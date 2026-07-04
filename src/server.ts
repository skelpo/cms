// Entry point. Runs migrations, seeds built-in rows, then binds the Hono
// app to the host runtime's HTTP adapter. Handles graceful shutdown.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { app } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { runSeed, isFirstRun } from './db/seed.js';
import { closeDb, checkDbTimezone } from './db/client.js';
import { startWorker, stopWorker } from './jobs/worker.js';

// Bridge a node:http request/response pair onto the Hono app's WHATWG
// `fetch` handler. Written to be portable across Node, Bun, and Perry:
//  - Headers are rebuilt from `req.rawHeaders` (flat [k,v,k,v,…]); under Perry
//    `req.headers` is undefined, and rawHeaders is portable to Node too.
//  - Body chunks are coerced with `Buffer.from` before concat — Perry delivers
//    them as strings, which would make `Buffer.concat` throw.
//  - `data`/`end` listeners are attached synchronously inside the createServer
//    callback; Perry fires them eagerly and a deferred registration would miss
//    them and hang.
function startHttpServer(): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => { chunks.push(Buffer.from(chunk)); });
    req.on('end', () => { void dispatch(req, res, chunks); });
    req.on('error', () => { res.statusCode = 400; res.end(); });
  });
  server.listen(config.port, config.host, () => {
    console.log(`[skelpo-cms] listening at http://${config.host}:${config.port}`);
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse, chunks: Buffer[]): Promise<void> {
  try {
    const headers = new Headers();
    const raw = req.rawHeaders ?? [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      headers.append(raw[i] as string, raw[i + 1] as string);
    }

    const method = req.method ?? 'GET';
    const host = headers.get('host') ?? `${config.host}:${config.port}`;
    const url = `http://${host}${req.url ?? '/'}`;
    const hasBody = method !== 'GET' && method !== 'HEAD' && chunks.length > 0;
    // Perry workaround (#5483): a Buffer/Uint8Array body handed to `new Request`
    // is read at a +12-byte offset (corrupted); a *string* body is read
    // correctly. Decode text bodies (form/JSON/text) to a string so they
    // survive — this is what makes POST form parsing (e.g. /admin/login) work.
    // Binary bodies (uploads) stay raw and remain affected until #5483 lands.
    let body: BodyInit | undefined;
    if (hasBody) {
      const buf = Buffer.concat(chunks);
      const ct = headers.get('content-type') ?? '';
      const isText = /application\/x-www-form-urlencoded|application\/json|^text\//i.test(ct);
      body = isText ? buf.toString('utf8') : buf;
    }
    const request = new Request(url, { method, headers, body });

    const response = await app.fetch(request);

    res.statusCode = response.status;
    const headerEntries = response.headers as unknown as Iterable<[string, string]>;
    for (const [key, value] of headerEntries) { res.setHeader(key, value); }
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (err) {
    console.error('[skelpo-cms] request handling error:', err);
    if (!res.headersSent) res.statusCode = 500;
    res.end('Internal Server Error');
  }
}

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

  // 1b. Warn (don't fail) if the DB session isn't UTC — the CMS assumes UTC.
  await checkDbTimezone();

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
  //
  // We serve through an inline node:http adapter that bridges (req,res) ⇄
  // app.fetch. This is the one path that works natively on Node, Bun, AND
  // Perry (Perry's node:http is native; @hono/node-server pulls in runtime JS
  // and crashes its own request path under Perry — see CLAUDE.md). No external
  // server package, so nothing extra to AOT-compile.

  // Perry workaround (PerryTS/perry#4004): on the *first* request, the fetch
  // Request handle's id collided with the node:http IncomingMessage handle id
  // (both id allocators started at 1), and the property tower checks
  // IncomingMessage before fetch — so `request.headers` returned node:http's
  // plain header object instead of a `Headers`, and Hono's `headers.get()`
  // threw once. A warmup `app.fetch` (no IncomingMessage involved) advances
  // the fetch id counter past the collision zone before we accept traffic.
  //
  // FIXED UPSTREAM in perry#4018 (fetch ids now start at 0x40000, disjoint
  // from the node:http range): once this build targets a Perry >= that fix,
  // this warmup is unnecessary and can be deleted. It's inert on Node/Bun.
  try {
    await app.fetch(new Request(`http://${config.host}:${config.port}/healthz`));
  } catch {
    // The first request is expected to throw under Perry; that's the point.
  }

  startHttpServer();

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
