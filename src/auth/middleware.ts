// Auth middleware. Resolves a user from either a session cookie or a
// Bearer token. Populates Hono context so handlers can call c.get('user').
// Does NOT enforce auth itself — that's per-route via requireAuth() helper.

import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { lookupSession } from './sessions.js';
import { lookupToken } from './tokens.js';
import { findUserById, findRoleById, type UserRow, type RoleRow } from './users.js';

export interface AuthContext {
  user: UserRow;
  role: RoleRow;
  via: 'session' | 'token';
  token?: { id: number; scopes: string[] };
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext | null;
  }
}

const SESSION_COOKIE = 'skelpoSession';

export async function attachAuthContext(c: Context, next: Next): Promise<void | Response> {
  const auth = await resolveAuth(c);
  c.set('auth', auth);
  return next();
}

async function resolveAuth(c: Context): Promise<AuthContext | null> {
  // 1. Bearer token (preferred for SDK/mobile; allows tokens with scopes)
  const authz = c.req.header('authorization');
  if (authz && authz.startsWith('Bearer ')) {
    const raw = authz.slice('Bearer '.length).trim();
    const tok = await lookupToken(raw);
    if (tok) {
      const user = await findUserById(tok.userId);
      if (!user || user.status !== 'active') return null;
      const role = await findRoleById(user.roleId);
      if (!role) return null;
      return { user, role, via: 'token', token: { id: tok.id, scopes: tok.scopes } };
    }
  }

  // 2. Session cookie (browser/admin)
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) {
    const session = await lookupSession(cookie);
    if (session) {
      const user = await findUserById(session.userId);
      if (!user || user.status !== 'active') return null;
      const role = await findRoleById(user.roleId);
      if (!role) return null;
      return { user, role, via: 'session' };
    }
  }

  return null;
}

export function requireAuth(c: Context): AuthContext | Response {
  const auth = c.get('auth');
  if (!auth) {
    return c.json(
      { error: { code: 'unauthorized', message: 'Authentication required' } },
      401,
    );
  }
  return auth;
}
