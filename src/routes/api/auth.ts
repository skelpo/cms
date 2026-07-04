// /api/v1/auth/* — login, logout, me, refresh, token CRUD.

import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { verifyPassword, verifyDummy } from '../../auth/password.js';
import {
  createSession,
  deleteSession,
} from '../../auth/sessions.js';
import {
  checkLoginRateLimit,
  recordLoginAttempt,
  clearFailedAttemptsForEmail,
} from '../../auth/ratelimit.js';
import {
  findUserByEmail,
  findRoleById,
  touchLastLogin,
  toPublicUser,
} from '../../auth/users.js';
import { requireAuth, isResponse } from '../../auth/middleware.js';
import {
  createToken,
  listTokensForUser,
  revokeToken,
} from '../../auth/tokens.js';
import { errorResponse, clientIp, userAgent, isHttps } from './_helpers.js';

const SESSION_COOKIE = 'skelpoSession';

export const authRoutes = new Hono();

// ─── POST /auth/login ────────────────────────────────────────────────────

interface LoginBody {
  email?: string;
  password?: string;
  totpCode?: string;
}

authRoutes.post('/login', async (c) => {
  const body = await c.req.json<LoginBody>().catch(() => ({}) as LoginBody);
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const ip = clientIp(c);

  if (!email || !password) {
    return errorResponse(c, 'validationError', 'Email and password required', 422);
  }

  // 1. Rate-limit BEFORE doing expensive bcrypt work.
  const rate = await checkLoginRateLimit(email, ip);
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfterSeconds ?? 900));
    return errorResponse(
      c,
      'rateLimited',
      'Too many login attempts. Try again later.',
      429,
      { retryAfterS: rate.retryAfterSeconds },
    );
  }

  // 2. Lookup user.
  const user = await findUserByEmail(email);
  if (!user) {
    // Equalize timing with the real bcrypt.compare path so a missing account
    // isn't detectably faster (user enumeration), then record the failure.
    await verifyDummy();
    await recordLoginAttempt(email, ip, false);
    return errorResponse(c, 'unauthorized', 'Invalid credentials', 401);
  }

  // 3. Verify password (constant-time via bcryptjs.compare).
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    await recordLoginAttempt(email, ip, false);
    return errorResponse(c, 'unauthorized', 'Invalid credentials', 401);
  }

  // 4. TOTP check if enabled. Real verification (src/auth/totp.ts) is NOT yet
  // implemented, so we FAIL CLOSED: an account with TOTP enabled cannot obtain
  // a session until the code can actually be validated against the stored
  // secret. (Previously this accepted ANY 6-digit value — a complete 2FA
  // bypass.) No enrollment path currently sets totpVerified=1, so no working
  // account is affected today.
  if (user.totpVerified === 1) {
    return errorResponse(
      c,
      'unavailable',
      'Two-factor authentication is enabled for this account, but verification is not yet available. Contact an administrator.',
      503,
    );
  }

  // 5. Issue session.
  const { token, expiresAt } = await createSession(user.id, {
    ip,
    userAgent: userAgent(c),
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    expires: expiresAt,
  });

  await touchLastLogin(user.id);
  await clearFailedAttemptsForEmail(email);
  await recordLoginAttempt(email, ip, true);

  const role = await findRoleById(user.roleId);
  if (!role) {
    return errorResponse(c, 'internalError', 'Role lookup failed', 500);
  }

  return c.json({
    data: {
      user: toPublicUser(user, role),
      token,
      expiresAt: expiresAt.toISOString(),
    },
  });
});

// ─── POST /auth/logout ───────────────────────────────────────────────────

authRoutes.post('/logout', async (c) => {
  const auth = c.get('auth');
  if (auth) {
    // Best-effort delete; we need the session token, which we kept in cookie.
    const cookie = c.req.header('cookie') ?? '';
    const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    if (match) {
      await deleteSession(match[1]!);
    }
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.body(null, 204);
});

// ─── GET /auth/me ────────────────────────────────────────────────────────

authRoutes.get('/me', (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;

  return c.json({
    data: {
      user: toPublicUser(auth.user, auth.role),
      role: auth.role,
      capabilities: auth.role.capabilities,
    },
  });
});

// ─── POST /auth/refresh ──────────────────────────────────────────────────

authRoutes.post('/refresh', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (auth.via !== 'session') {
    return errorResponse(c, 'forbidden', 'Refresh only applies to sessions', 403);
  }

  // Issue a new session, keep old alive briefly for in-flight requests.
  const { token, expiresAt } = await createSession(auth.user.id, {
    ip: clientIp(c),
    userAgent: userAgent(c),
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    expires: expiresAt,
  });
  return c.json({
    data: {
      user: toPublicUser(auth.user, auth.role),
      token,
      expiresAt: expiresAt.toISOString(),
    },
  });
});

// ─── POST /auth/tokens (create) ──────────────────────────────────────────

authRoutes.post('/tokens', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;

  const body = (await c.req.json<{ name?: string; scopes?: string[] }>().catch(
    () => ({}) as { name?: string; scopes?: string[] },
  ));
  const name = String(body.name ?? '').trim().slice(0, 128);
  const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : [];
  if (!name) {
    return errorResponse(c, 'validationError', 'Token name required', 422);
  }
  const result = await createToken({ userId: auth.user.id, name, scopes });
  return c.json(
    {
      data: {
        id: result.id,
        name,
        token: result.token, // shown ONCE
        scopes,
      },
    },
    201,
  );
});

// ─── GET /auth/tokens ────────────────────────────────────────────────────

authRoutes.get('/tokens', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  const tokens = await listTokensForUser(auth.user.id);
  // Never return tokenHash; only id, name, prefix, scopes, timestamps.
  return c.json({
    data: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      scopes: t.scopes,
      lastUsedAt: t.lastUsedAt,
      expiresAt: t.expiresAt,
      revokedAt: t.revokedAt,
      createdAt: t.createdAt,
    })),
  });
});

// ─── DELETE /auth/tokens/:id ─────────────────────────────────────────────

authRoutes.delete('/tokens/:id', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) {
    return errorResponse(c, 'badRequest', 'Invalid token id', 400);
  }
  const ok = await revokeToken(id, auth.user.id);
  if (!ok) return errorResponse(c, 'notFound', 'Token not found', 404);
  return c.body(null, 204);
});
