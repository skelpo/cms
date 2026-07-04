// /api/v1/redirects/* — 301/302 management. Read path is cached so the
// public redirect lookup (done by the customer frontend) is O(1).

import { Hono } from 'hono';
import { execute, query, queryOne } from '../../db/client.js';
import { normalizeDates } from '../../db/datetime.js';
import { invalidate } from '../../cache/deps.js';
import { withCache } from '../../cache/respond.js';
import { errorResponse } from './_helpers.js';
import { requireAuth, isResponse } from '../../auth/middleware.js';
import { can } from '../../permissions/check.js';

export const redirectRoutes = new Hono();

interface RedirectRow {
  id: number; source: string; destination: string;
  statusCode: number; hitCount: number; createdAt: unknown;
}

const VALID_CODES = new Set([301, 302, 307, 308]);

// A destination must be a root-relative path or an absolute http(s) URL — never
// `javascript:`/`data:` or protocol-relative `//host`, which the consuming
// frontend would turn into an open redirect or XSS.
function isSafeRedirectDestination(dest: string): boolean {
  const s = dest.trim();
  if (s.startsWith('//')) return false;
  if (s.startsWith('/')) return true;
  return /^https?:\/\//i.test(s);
}

redirectRoutes.get('/', async (c) => {
  // Public — the customer frontend fetches the full table to resolve
  // unmatched paths. Small + cacheable.
  return withCache(c, 'GET:/redirects', async (deps) => {
    deps.add('redirects');
    const rows = await query<RedirectRow>(
      'SELECT `id`, `source`, `destination`, `statusCode` FROM `redirects` ORDER BY `id`',
    );
    return { body: { data: rows } };
  });
});

redirectRoutes.post('/', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageRedirects')) {
    return errorResponse(c, 'forbidden', 'manageRedirects capability required', 403);
  }
  const body = await c.req.json<{ source?: string; destination?: string; statusCode?: number }>()
    .catch(() => ({}) as { source?: string; destination?: string; statusCode?: number });
  const source = String(body.source ?? '').trim();
  const destination = String(body.destination ?? '').trim();
  const statusCode = body.statusCode ?? 301;
  if (!source || !destination) {
    return errorResponse(c, 'validationError', 'source and destination required', 422);
  }
  if (!isSafeRedirectDestination(destination)) {
    return errorResponse(c, 'validationError', 'destination must be a root-relative path or an absolute http(s) URL', 422);
  }
  if (!VALID_CODES.has(statusCode)) {
    return errorResponse(c, 'validationError', 'statusCode must be 301/302/307/308', 422);
  }
  const dup = await queryOne<{ id: number }>('SELECT `id` FROM `redirects` WHERE `source` = ?', [source]);
  if (dup) return errorResponse(c, 'conflict', 'a redirect for that source exists', 409);
  const r = await execute(
    'INSERT INTO `redirects` (`source`, `destination`, `statusCode`) VALUES (?, ?, ?)',
    [source, destination, statusCode],
  );
  invalidate(['redirects', 'GET:/redirects'], { prefix: true });
  return c.json({ data: { id: Number(r.insertId), source, destination, statusCode } }, 201);
});

redirectRoutes.patch('/:id', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageRedirects')) {
    return errorResponse(c, 'forbidden', 'manageRedirects capability required', 403);
  }
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ source?: string; destination?: string; statusCode?: number }>()
    .catch(() => ({}) as { source?: string; destination?: string; statusCode?: number });
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.source !== undefined)      { sets.push('`source` = ?');      params.push(body.source); }
  if (body.destination !== undefined) {
    if (!isSafeRedirectDestination(String(body.destination))) {
      return errorResponse(c, 'validationError', 'destination must be a root-relative path or an absolute http(s) URL', 422);
    }
    sets.push('`destination` = ?'); params.push(body.destination);
  }
  if (body.statusCode !== undefined) {
    if (!VALID_CODES.has(body.statusCode)) return errorResponse(c, 'validationError', 'bad statusCode', 422);
    sets.push('`statusCode` = ?'); params.push(body.statusCode);
  }
  if (sets.length === 0) return errorResponse(c, 'validationError', 'nothing to update', 422);
  params.push(id);
  const r = await execute(`UPDATE \`redirects\` SET ${sets.join(', ')} WHERE \`id\` = ?`, params);
  if (r.affectedRows === 0) return errorResponse(c, 'notFound', 'redirect not found', 404);
  invalidate(['redirects', 'GET:/redirects'], { prefix: true });
  return c.body(null, 204);
});

redirectRoutes.delete('/:id', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageRedirects')) {
    return errorResponse(c, 'forbidden', 'manageRedirects capability required', 403);
  }
  const id = Number(c.req.param('id'));
  const r = await execute('DELETE FROM `redirects` WHERE `id` = ?', [id]);
  if (r.affectedRows === 0) return errorResponse(c, 'notFound', 'redirect not found', 404);
  invalidate(['redirects', 'GET:/redirects'], { prefix: true });
  return c.body(null, 204);
});

// Resolve a single path (used by customer frontend hot-path or admin preview).
redirectRoutes.get('/resolve', async (c) => {
  const path = c.req.query('path');
  if (!path) return errorResponse(c, 'validationError', 'path query required', 422);
  const row = await queryOne<RedirectRow>(
    'SELECT * FROM `redirects` WHERE `source` = ?', [path],
  );
  if (!row) return c.json({ data: null });
  // Best-effort hit counter (not awaited critically).
  void execute('UPDATE `redirects` SET `hitCount` = `hitCount` + 1, `lastHitAt` = NOW() WHERE `id` = ?', [row.id]);
  return c.json({ data: { destination: row.destination, statusCode: row.statusCode } });
});
