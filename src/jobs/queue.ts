// DB-backed job queue. enqueue() inserts a row; the worker polls with
// SELECT ... FOR UPDATE SKIP LOCKED so multiple workers (or future
// processes) never double-process.

import { execute, queryOne, query } from '../db/client.js';

export type JobKind =
  | 'sendEmail'
  | 'preRender'
  | 'webhookDispatch'
  | 'scheduledPublish'
  | 'regenSitemap'
  | 'regenLlmsTxt'
  | 'pruneSessions'
  | 'pruneLoginAttempts'
  | 'pruneContentRevisions'
  | 'imgproxyWarm';

export interface JobRow {
  id: number;
  kind: JobKind;
  payload: string | Record<string, unknown>;
  runAt: string;
  attempts: number;
  maxAttempts: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'dead';
  lockedBy: string | null;
  lockedAt: string | null;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export async function enqueue(
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; maxAttempts?: number } = {},
): Promise<number> {
  const runAt = opts.runAt
    ? opts.runAt.toISOString().slice(0, 19).replace('T', ' ')
    : null;
  const r = await execute(
    `INSERT INTO \`jobs\` (\`kind\`, \`payload\`, \`runAt\`, \`maxAttempts\`)
     VALUES (?, ?, COALESCE(?, NOW()), ?)`,
    [kind, JSON.stringify(payload), runAt, opts.maxAttempts ?? 5],
  );
  return Number(r.insertId);
}

/**
 * Claim the next runnable job for this worker. Uses FOR UPDATE SKIP
 * LOCKED inside a transaction so concurrent workers don't collide.
 * Returns null when the queue is empty.
 */
export async function claimNext(workerId: string): Promise<JobRow | null> {
  // @perryts/mysql: use a transaction so the row lock is held across
  // the SELECT + UPDATE.
  const { pool } = await import('../db/client.js');
  return pool.transaction(async (conn) => {
    const sel = await conn.query<JobRow>(
      `SELECT * FROM \`jobs\`
        WHERE \`status\` = 'pending' AND \`runAt\` <= NOW()
        ORDER BY \`runAt\` ASC, \`id\` ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    const job = sel.rows[0];
    if (!job) return null;
    await conn.query(
      `UPDATE \`jobs\`
          SET \`status\` = 'running', \`lockedBy\` = ?, \`lockedAt\` = NOW(),
              \`attempts\` = \`attempts\` + 1
        WHERE \`id\` = ?`,
      [workerId, job.id],
    );
    return { ...job, status: 'running', attempts: job.attempts + 1 };
  });
}

export async function markDone(id: number): Promise<void> {
  await execute(
    "UPDATE `jobs` SET `status` = 'done', `completedAt` = NOW() WHERE `id` = ?",
    [id],
  );
}

export async function markFailed(
  id: number,
  error: string,
  attempts: number,
  maxAttempts: number,
): Promise<void> {
  if (attempts >= maxAttempts) {
    await execute(
      "UPDATE `jobs` SET `status` = 'dead', `lastError` = ? WHERE `id` = ?",
      [error.slice(0, 4000), id],
    );
  } else {
    // Exponential backoff: 2^attempts minutes.
    const delayMin = Math.min(2 ** attempts, 60);
    await execute(
      `UPDATE \`jobs\`
          SET \`status\` = 'pending', \`lastError\` = ?,
              \`runAt\` = (NOW() + INTERVAL ? MINUTE), \`lockedBy\` = NULL, \`lockedAt\` = NULL
        WHERE \`id\` = ?`,
      [error.slice(0, 4000), delayMin, id],
    );
  }
}

export async function jobStats(): Promise<Record<string, number>> {
  const rows = await query<{ status: string; n: number }>(
    'SELECT `status`, COUNT(*) AS n FROM `jobs` GROUP BY `status`',
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export async function getJob(id: number): Promise<JobRow | null> {
  return queryOne<JobRow>('SELECT * FROM `jobs` WHERE `id` = ?', [id]);
}

export async function retryJob(id: number): Promise<boolean> {
  const r = await execute(
    `UPDATE \`jobs\` SET \`status\` = 'pending', \`runAt\` = NOW(),
            \`lockedBy\` = NULL, \`lockedAt\` = NULL
      WHERE \`id\` = ? AND \`status\` IN ('failed','dead')`,
    [id],
  );
  return r.affectedRows > 0;
}

/** Recover jobs whose worker died mid-run (locked > 10 min ago). */
export async function recoverStuckJobs(): Promise<number> {
  const r = await execute(
    `UPDATE \`jobs\`
        SET \`status\` = 'pending', \`lockedBy\` = NULL, \`lockedAt\` = NULL
      WHERE \`status\` = 'running' AND \`lockedAt\` < (NOW() - INTERVAL 10 MINUTE)`,
  );
  return r.affectedRows;
}
