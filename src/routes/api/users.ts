// /api/v1/users/* and /api/v1/roles/*

import { Hono } from 'hono';
import { execute, query, queryOne } from '../../db/client.js';
import { normalizeDates } from '../../db/datetime.js';
import { hashPassword } from '../../auth/password.js';
import { findRoleBySlug, listRoles, type UserRow, type RoleRow } from '../../auth/users.js';
import { errorResponse } from './_helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { can } from '../../permissions/check.js';

export const userRoutes = new Hono();
export const roleRoutes = new Hono();

function randomHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

interface PublicUserRow {
  id: number; email: string; displayName: string; roleId: number;
  locale: string; status: string; lastLoginAt: unknown; createdAt: unknown;
  roleSlug?: string; roleLabel?: string;
}

// ─── Users ───────────────────────────────────────────────────────────────

userRoutes.get('/', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageUsers')) {
    return errorResponse(c, 'forbidden', 'manageUsers capability required', 403);
  }
  const rows = await query<PublicUserRow>(
    `SELECT u.\`id\`, u.\`email\`, u.\`displayName\`, u.\`roleId\`, u.\`locale\`,
            u.\`status\`, u.\`lastLoginAt\`, u.\`createdAt\`,
            r.\`slug\` AS roleSlug, r.\`label\` AS roleLabel
       FROM \`users\` u LEFT JOIN \`roles\` r ON r.\`id\` = u.\`roleId\`
      ORDER BY u.\`id\``,
  );
  return c.json({ data: normalizeDates(rows) });
});

userRoutes.post('/', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageUsers')) {
    return errorResponse(c, 'forbidden', 'manageUsers capability required', 403);
  }
  const body = await c.req.json<{
    email?: string; displayName?: string; roleId?: number; roleSlug?: string;
    locale?: string; password?: string; sendInvite?: boolean;
  }>().catch(() => ({}) as {
    email?: string; displayName?: string; roleId?: number; roleSlug?: string;
    locale?: string; password?: string; sendInvite?: boolean;
  });
  const email = String(body.email ?? '').trim().toLowerCase();
  const displayName = String(body.displayName ?? '').trim();
  if (!email || !displayName) {
    return errorResponse(c, 'validationError', 'email and displayName required', 422);
  }
  let roleId = body.roleId;
  if (!roleId && body.roleSlug) {
    const r = await findRoleBySlug(body.roleSlug);
    if (!r) return errorResponse(c, 'validationError', `unknown role: ${body.roleSlug}`, 422);
    roleId = r.id;
  }
  if (!roleId) return errorResponse(c, 'validationError', 'roleId or roleSlug required', 422);

  const dup = await queryOne<{ id: number }>('SELECT `id` FROM `users` WHERE `email` = ?', [email]);
  if (dup) return errorResponse(c, 'conflict', 'email already in use', 409);

  // If a password is given the user is active; otherwise create an invite.
  const invited = !body.password;
  const passwordHash = body.password
    ? await hashPassword(body.password)
    : await hashPassword(randomHex(24)); // unusable until invite accepted
  const inviteToken = invited ? randomHex(32) : null;

  const r = await execute(
    `INSERT INTO \`users\`
       (\`email\`, \`passwordHash\`, \`displayName\`, \`roleId\`, \`locale\`,
        \`status\`, \`inviteToken\`, \`inviteExpiresAt\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${invited ? '(NOW() + INTERVAL 7 DAY)' : 'NULL'})`,
    [email, passwordHash, displayName, roleId, body.locale ?? 'en',
     invited ? 'invited' : 'active', inviteToken],
  );
  // Invite email is queued via the email adapter when EMAIL backend is set.
  if (invited) {
    const { enqueue } = await import('../../jobs/queue.js');
    await enqueue('sendEmail', {
      templateSlug: 'userInvite',
      to: email,
      variables: { siteName: 'Skelpo CMS', inviteUrl: `/admin/accept-invite?token=${inviteToken}` },
    });
  }
  return c.json({ data: { id: Number(r.insertId), email, status: invited ? 'invited' : 'active' } }, 201);
});

userRoutes.patch('/:id', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const id = Number(c.req.param('id'));
  const isSelf = auth.user.id === id;
  if (!isSelf && !can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageUsers')) {
    return errorResponse(c, 'forbidden', 'manageUsers capability required', 403);
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof body.displayName === 'string') { sets.push('`displayName` = ?'); params.push(body.displayName); }
  if (typeof body.locale === 'string')      { sets.push('`locale` = ?');      params.push(body.locale); }
  if (typeof body.password === 'string')    { sets.push('`passwordHash` = ?'); params.push(await hashPassword(body.password)); }
  if (typeof body.roleId === 'number' && !isSelf &&
      can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageUsers')) {
    sets.push('`roleId` = ?'); params.push(body.roleId);
  }
  if (sets.length === 0) return errorResponse(c, 'validationError', 'no updatable fields', 422);
  params.push(id);
  const r = await execute(`UPDATE \`users\` SET ${sets.join(', ')} WHERE \`id\` = ?`, params);
  if (r.affectedRows === 0) return errorResponse(c, 'notFound', 'user not found', 404);
  return c.body(null, 204);
});

userRoutes.post('/:id/suspend', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageUsers')) {
    return errorResponse(c, 'forbidden', 'manageUsers capability required', 403);
  }
  const id = Number(c.req.param('id'));
  if (id === auth.user.id) return errorResponse(c, 'conflict', 'cannot suspend yourself', 409);
  const r = await execute("UPDATE `users` SET `status` = 'suspended' WHERE `id` = ?", [id]);
  if (r.affectedRows === 0) return errorResponse(c, 'notFound', 'user not found', 404);
  // Kill active sessions.
  await execute('DELETE FROM `sessions` WHERE `userId` = ?', [id]);
  return c.body(null, 204);
});

userRoutes.post('/:id/unsuspend', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageUsers')) {
    return errorResponse(c, 'forbidden', 'manageUsers capability required', 403);
  }
  const id = Number(c.req.param('id'));
  const r = await execute("UPDATE `users` SET `status` = 'active' WHERE `id` = ?", [id]);
  if (r.affectedRows === 0) return errorResponse(c, 'notFound', 'user not found', 404);
  return c.body(null, 204);
});

// ─── Roles ───────────────────────────────────────────────────────────────

roleRoutes.get('/', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const roles = await listRoles();
  return c.json({ data: roles });
});

roleRoutes.post('/', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageRoles')) {
    return errorResponse(c, 'forbidden', 'manageRoles capability required', 403);
  }
  const body = await c.req.json<{ slug?: string; label?: string; capabilities?: unknown }>()
    .catch(() => ({}) as { slug?: string; label?: string; capabilities?: unknown });
  if (!body.slug || !body.label || !body.capabilities) {
    return errorResponse(c, 'validationError', 'slug, label, capabilities required', 422);
  }
  const dup = await queryOne<{ id: number }>('SELECT `id` FROM `roles` WHERE `slug` = ?', [body.slug]);
  if (dup) return errorResponse(c, 'conflict', 'role slug exists', 409);
  const r = await execute(
    'INSERT INTO `roles` (`slug`, `label`, `capabilities`, `isBuiltin`) VALUES (?, ?, ?, 0)',
    [body.slug, body.label, JSON.stringify(body.capabilities)],
  );
  return c.json({ data: { id: Number(r.insertId), slug: body.slug } }, 201);
});

roleRoutes.patch('/:slug', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageRoles')) {
    return errorResponse(c, 'forbidden', 'manageRoles capability required', 403);
  }
  const slug = c.req.param('slug');
  const body = await c.req.json<{ label?: string; capabilities?: unknown }>()
    .catch(() => ({}) as { label?: string; capabilities?: unknown });
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.label !== undefined) { sets.push('`label` = ?'); params.push(body.label); }
  if (body.capabilities !== undefined) { sets.push('`capabilities` = ?'); params.push(JSON.stringify(body.capabilities)); }
  if (sets.length === 0) return errorResponse(c, 'validationError', 'nothing to update', 422);
  params.push(slug);
  const r = await execute(`UPDATE \`roles\` SET ${sets.join(', ')} WHERE \`slug\` = ?`, params);
  if (r.affectedRows === 0) return errorResponse(c, 'notFound', 'role not found', 404);
  return c.body(null, 204);
});

roleRoutes.delete('/:slug', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageRoles')) {
    return errorResponse(c, 'forbidden', 'manageRoles capability required', 403);
  }
  const slug = c.req.param('slug');
  const role = await queryOne<{ id: number; isBuiltin: number }>(
    'SELECT `id`, `isBuiltin` FROM `roles` WHERE `slug` = ?', [slug],
  );
  if (!role) return errorResponse(c, 'notFound', 'role not found', 404);
  if (role.isBuiltin) return errorResponse(c, 'conflict', 'cannot delete built-in role', 409);
  const inUse = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM `users` WHERE `roleId` = ?', [role.id]);
  if ((inUse?.n ?? 0) > 0) return errorResponse(c, 'conflict', `${inUse?.n} users still have this role`, 409);
  await execute('DELETE FROM `roles` WHERE `id` = ?', [role.id]);
  return c.body(null, 204);
});
