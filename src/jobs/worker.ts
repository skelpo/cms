// In-process job worker. Polls the queue on an interval, runs handlers,
// retries with backoff. Single-threaded (setInterval) for v0.1 — adequate
// for a single-tenant CMS where jobs are email/webhook/prerender, not
// CPU-bound. Future: move to perry/thread / worker_threads behind the
// same handler map.

import {
  claimNext,
  markDone,
  markFailed,
  recoverStuckJobs,
  type JobKind,
  type JobRow,
} from './queue.js';
import { deliverWebhookJob } from '../webhooks/dispatch.js';
import { sendTemplatedEmail } from '../email/adapter.js';
import { pruneExpiredSessions } from '../auth/sessions.js';
import { pruneOldLoginAttempts } from '../auth/ratelimit.js';

const WORKER_ID = `w_${Math.random().toString(36).slice(2, 10)}`;
let timer: ReturnType<typeof setInterval> | null = null;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

type Handler = (payload: Record<string, unknown>) => Promise<void>;

const handlers: Record<JobKind, Handler> = {
  webhookDispatch: async (p) => {
    await deliverWebhookJob(p as Parameters<typeof deliverWebhookJob>[0]);
  },
  sendEmail: async (p) => {
    await sendTemplatedEmail(
      String(p.templateSlug),
      String(p.to),
      (p.variables as Record<string, string>) ?? {},
      String(p.locale ?? 'en'),
    );
  },
  scheduledPublish: async (p) => {
    const { publishContent } = await import('../content/writer.js');
    const id = Number(p.contentId);
    if (Number.isFinite(id)) await publishContent(id, Number(p.authorId ?? 0));
  },
  preRender: async () => { /* customer-site concern; no-op server-side in v0.1 */ },
  regenSitemap: async () => { /* customer-site concern in headless model */ },
  regenLlmsTxt: async () => { /* customer-site concern */ },
  imgproxyWarm: async () => { /* future: pre-generate variants */ },
  pruneSessions: async () => { await pruneExpiredSessions(); },
  pruneLoginAttempts: async () => { await pruneOldLoginAttempts(); },
  pruneContentRevisions: async () => { await pruneAutosaveRevisions(); },
};

async function pruneAutosaveRevisions(): Promise<void> {
  const { execute } = await import('../db/client.js');
  await execute(
    `DELETE FROM \`contentRevisions\`
      WHERE \`reason\` = 'autosave' AND \`createdAt\` < (NOW() - INTERVAL 30 DAY)`,
  );
}

// Publish content whose scheduledAt has arrived. There was previously no
// producer for this at all — scheduled posts never went live. Runs on a short
// interval; publishContent stamps publishedAt + status and we invalidate the
// content caches and fire the webhook event, matching the manual publish path.
async function publishDueScheduled(): Promise<void> {
  const { query } = await import('../db/client.js');
  const { publishContent } = await import('../content/writer.js');
  const { invalidate } = await import('../cache/deps.js');
  const { fireEvent } = await import('../webhooks/dispatch.js');
  const due = await query<{ id: number; typeSlug: string; locale: string; authorId: number }>(
    `SELECT \`id\`, \`typeSlug\`, \`locale\`, \`authorId\` FROM \`content\`
      WHERE \`scheduledAt\` IS NOT NULL AND \`scheduledAt\` <= NOW()
        AND \`status\` NOT IN ('published','archived')
      ORDER BY \`scheduledAt\` ASC
      LIMIT 50`,
  );
  for (const row of due) {
    const result = await publishContent(row.id, row.authorId ?? 0);
    if (!result.ok) {
      console.error(`[jobs] scheduled publish blocked for content ${row.id}:`, result.errors[0]?.message);
      continue;
    }
    invalidate([`content:${row.id}`]);
    invalidate([`type-list:${row.typeSlug}:${row.locale}`], { prefix: true });
    await fireEvent(
      'content.published',
      { id: row.id, type: row.typeSlug, locale: row.locale },
      [`content:${row.id}`, `type-list:${row.typeSlug}:${row.locale}`],
    );
  }
}

// Bound each handler well below the 10-minute stuck-job lease so a hung handler
// (e.g. a slow email/webhook endpoint) is failed + retried before
// recoverStuckJobs could re-claim it and cause a concurrent second execution.
const HANDLER_TIMEOUT_MS = 5 * 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timerId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`job handler timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timerId));
}

async function processOne(): Promise<boolean> {
  const job: JobRow | null = await claimNext(WORKER_ID);
  if (!job) return false;
  const handler = handlers[job.kind as JobKind];
  try {
    if (!handler) throw new Error(`No handler for job kind: ${job.kind}`);
    const payload =
      typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    await withTimeout(handler(payload as Record<string, unknown>), HANDLER_TIMEOUT_MS, job.kind);
    await markDone(job.id);
  } catch (err) {
    // Coerce non-Error throws (strings/undefined) so markFailed's .slice never
    // throws inside the catch and strands the job as 'running'.
    const msg = String((err as Error)?.message ?? err);
    await markFailed(job.id, msg, job.attempts, job.maxAttempts);
  }
  return true;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Drain up to N jobs per tick to avoid starving under load.
    let processed = 0;
    while (processed < 25 && (await processOne())) processed++;
  } catch (err) {
    console.error('[jobs] worker tick error:', err);
  } finally {
    running = false;
  }
}

let recoverCounter = 0;

export function startWorker(intervalMs = 2000): void {
  if (timer) return;
  console.log(`[jobs] worker ${WORKER_ID} starting (poll ${intervalMs}ms)`);
  timer = setInterval(() => {
    void tick();
    // Every ~60 ticks, recover stuck jobs.
    if (++recoverCounter % 60 === 0) {
      void recoverStuckJobs().catch((err) => console.error('[jobs] recoverStuckJobs failed:', err));
    }
  }, intervalMs);

  // Recurring maintenance — driven directly off process-lifetime intervals
  // rather than one-shot seeded jobs (which only ever ran once per boot and let
  // sessions/loginAttempts/autosave-revisions grow without bound).
  const runMaintenance = (): void => {
    void pruneExpiredSessions().catch((err) => console.error('[jobs] pruneSessions failed:', err));
    void pruneOldLoginAttempts().catch((err) => console.error('[jobs] pruneLoginAttempts failed:', err));
    void pruneAutosaveRevisions().catch((err) => console.error('[jobs] pruneContentRevisions failed:', err));
  };
  runMaintenance(); // initial sweep (DB is up: migrations ran before startWorker)
  maintenanceTimer = setInterval(runMaintenance, 3_600_000);

  // Scheduled-content publisher — checks every 60s for posts whose scheduledAt
  // has arrived.
  schedulerTimer = setInterval(() => {
    void publishDueScheduled().catch((err) => console.error('[jobs] publishDueScheduled failed:', err));
  }, 60_000);
}

export function stopWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (maintenanceTimer) { clearInterval(maintenanceTimer); maintenanceTimer = null; }
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
}
