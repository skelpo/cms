// /api/v1/jobs/*  — read-only inspection + retry of jobs in the queue.
// Useful for app integrations (dashboards, alerts) and the CLI.

import { Hono } from 'hono';
import { jobStats, retryJob } from '../../jobs/queue.js';
import { query, queryOne } from '../../db/client.js';
import { normalizeDates } from '../../db/datetime.js';
import { errorResponse } from './_helpers.js';
import { requireAuth, isResponse } from '../../auth/middleware.js';
import { can } from '../../permissions/check.js';

export const jobsRoutes = new Hono();

function gate(c: Parameters<typeof requireAuth>[0]) {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageJobs')) {
    return errorResponse(c, 'forbidden', 'manageJobs capability required', 403);
  }
  return auth;
}

// ─── GET /jobs  — list jobs (status filter optional) ──────────────────

jobsRoutes.get('/', async (c) => {
  const auth = gate(c);
  if (isResponse(auth)) return auth;
  const status = c.req.query('status');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 500);
  const params: unknown[] = [];
  let where = '';
  if (status) {
    where = "WHERE `status` = ?";
    params.push(status);
  }
  params.push(limit);
  const rows = await query<{
    id: number; queue: string; status: string; runAt: unknown; attempts: number;
    lastError: string | null; createdAt: unknown;
  }>(
    `SELECT \`id\`, \`queue\`, \`status\`, \`runAt\`, \`attempts\`, \`lastError\`, \`createdAt\`
       FROM \`jobs\` ${where} ORDER BY \`id\` DESC LIMIT ?`,
    params,
  );
  return c.json({ data: normalizeDates(rows) });
});

// ─── GET /jobs/stats  — counts by status ──────────────────────────────

jobsRoutes.get('/stats', async (c) => {
  const auth = gate(c);
  if (isResponse(auth)) return auth;
  const stats = await jobStats();
  return c.json({ data: stats });
});

// ─── GET /jobs/:id  — single job (full payload + last error) ─────────

jobsRoutes.get('/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (isResponse(auth)) return auth;
  const row = await queryOne<{
    id: number; queue: string; status: string; payload: unknown; runAt: unknown;
    attempts: number; lastError: string | null; createdAt: unknown; updatedAt: unknown;
  }>('SELECT * FROM `jobs` WHERE `id` = ?', [Number(c.req.param('id'))]);
  if (!row) return errorResponse(c, 'notFound', 'Job not found', 404);
  return c.json({ data: normalizeDates(row) });
});

// ─── POST /jobs/:id/retry  — re-queue a failed job ────────────────────

jobsRoutes.post('/:id{[0-9]+}/retry', async (c) => {
  const auth = gate(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageJobs')) {
    return errorResponse(c, 'forbidden', 'manageJobs capability required', 403);
  }
  const id = Number(c.req.param('id'));
  const ok = await retryJob(id);
  if (!ok) return errorResponse(c, 'notFound', 'Job not found or not retriable', 404);
  return c.json({ data: { id, requeued: true } });
});
