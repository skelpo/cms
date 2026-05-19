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
  enqueue,
  type JobKind,
  type JobRow,
} from './queue.js';
import { deliverWebhookJob } from '../webhooks/dispatch.js';
import { sendTemplatedEmail } from '../email/adapter.js';
import { pruneExpiredSessions } from '../auth/sessions.js';
import { pruneOldLoginAttempts } from '../auth/ratelimit.js';

const WORKER_ID = `w_${Math.random().toString(36).slice(2, 10)}`;
let timer: ReturnType<typeof setInterval> | null = null;
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
  pruneContentRevisions: async () => {
    const { execute } = await import('../db/client.js');
    await execute(
      `DELETE FROM \`contentRevisions\`
        WHERE \`reason\` = 'autosave' AND \`createdAt\` < (NOW() - INTERVAL 30 DAY)`,
    );
  },
};

async function processOne(): Promise<boolean> {
  const job: JobRow | null = await claimNext(WORKER_ID);
  if (!job) return false;
  const handler = handlers[job.kind as JobKind];
  try {
    if (!handler) throw new Error(`No handler for job kind: ${job.kind}`);
    const payload =
      typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    await handler(payload as Record<string, unknown>);
    await markDone(job.id);
  } catch (err) {
    await markFailed(job.id, (err as Error).message, job.attempts, job.maxAttempts);
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
    if (++recoverCounter % 60 === 0) void recoverStuckJobs();
  }, intervalMs);

  // Seed recurring maintenance jobs (idempotent enough — they're cheap).
  void enqueue('pruneSessions', {}, { runAt: new Date(Date.now() + 60_000) });
  void enqueue('pruneLoginAttempts', {}, { runAt: new Date(Date.now() + 120_000) });
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
