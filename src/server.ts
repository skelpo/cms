// Entry point. Runs migrations, seeds built-in rows, then binds the Hono
// app to the host runtime's HTTP adapter. Handles graceful shutdown.

import { app } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { runSeed, isFirstRun } from './db/seed.js';
import { closeDb } from './db/client.js';
import { startWorker, stopWorker } from './jobs/worker.js';

async function main(): Promise<void> {
  console.log(`[skelpo-cms] starting on port ${config.port}…`);

  // 1. Run migrations.
  try {
    const { applied, skipped } = await runMigrations();
    if (applied.length > 0) {
      console.log(`[skelpo-cms] applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }
    if (skipped.length > 0) {
      console.log(`[skelpo-cms] ${skipped.length} migration(s) already applied`);
    }
  } catch (err) {
    console.error('[skelpo-cms] migration failed:', err);
    process.exit(1);
  }

  // 2. Seed built-in roles, types, templates, settings, menus.
  try {
    const { inserted } = await runSeed();
    const total = Object.values(inserted).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.log('[skelpo-cms] seeded built-ins:', inserted);
    }
    if (await isFirstRun()) {
      console.log('[skelpo-cms] no users yet — first-run wizard required at /admin/install');
    }
  } catch (err) {
    console.error('[skelpo-cms] seed failed:', err);
    process.exit(1);
  }

  // 3. Start background job worker.
  startWorker(2000);

  // 4. Bind HTTP listener.
  const bun = (globalThis as { Bun?: { serve: (opts: { port: number; hostname: string; fetch: typeof app.fetch }) => unknown } }).Bun;
  if (bun) {
    bun.serve({ port: config.port, hostname: config.host, fetch: app.fetch });
    console.log(`[skelpo-cms] listening at http://${config.host}:${config.port}`);
  } else {
    const { serve } = await import('@hono/node-server');
    serve({ port: config.port, hostname: config.host, fetch: app.fetch }, (info) => {
      console.log(`[skelpo-cms] listening at http://${info.address}:${info.port}`);
    });
  }

  // 5. Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[skelpo-cms] ${signal} received, shutting down…`);
    stopWorker();
    try {
      await closeDb();
    } catch (err) {
      console.error('[skelpo-cms] error closing DB:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

void main();
