// Webhook signature verification + automatic cache invalidation.
//
// Usage in a Hono app:
//   app.post('/webhook/cms', webhookHandler(cms))
//
// The handler verifies the X-Skelpo-Signature HMAC and, if valid, calls
// `cms.invalidate(payload.depKeys)` so subsequent SDK reads hit fresh
// data via the in-memory cache.

import type { CmsClient } from './client.js';

export interface WebhookPayload {
  event: string;
  deliveredAt: string;
  data: Record<string, unknown>;
  depKeys: string[];
}

interface MinimalContext {
  req: { header: (name: string) => string | undefined; text: () => Promise<string>; raw?: unknown };
  body: (body: BodyInit | null, status?: number) => Response;
  json: (data: unknown, status?: number) => Response;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Parse `t=<ts>,v1=<hex>` style signature header. */
function parseSignature(header: string): { ts: string; v1: string } | null {
  const parts = header.split(',').map((s) => s.trim());
  let ts: string | null = null, v1: string | null = null;
  for (const p of parts) {
    if (p.startsWith('t=')) ts = p.slice(2);
    else if (p.startsWith('v1=')) v1 = p.slice(3);
  }
  if (ts && v1) return { ts, v1 };
  return null;
}

/**
 * Returns a Hono-compatible handler. Accepts any framework whose context
 * matches the minimal shape (req.header/req.text/body/json) — Hono fits.
 */
export function webhookHandler(cms: CmsClient): (c: MinimalContext) => Promise<Response> {
  return async function handle(c: MinimalContext) {
    const secret = cms.opts.webhookSecret;
    if (!secret) return c.json({ error: 'webhookSecret not configured' }, 500);

    const sigHeader = c.req.header('x-skelpo-signature');
    if (!sigHeader) return c.json({ error: 'missing signature' }, 401);

    const parsed = parseSignature(sigHeader);
    if (!parsed) return c.json({ error: 'malformed signature' }, 401);

    // Replay protection: reject if older than 5 minutes.
    const tsNum = Number(parsed.ts);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
      return c.json({ error: 'signature outside time window' }, 401);
    }

    const body = await c.req.text();
    const expected = await hmacSha256Hex(secret, `${parsed.ts}.${body}`);
    if (!constantTimeEquals(expected, parsed.v1)) {
      return c.json({ error: 'invalid signature' }, 401);
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(body) as WebhookPayload;
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }

    if (Array.isArray(payload.depKeys) && payload.depKeys.length > 0) {
      cms.invalidate(payload.depKeys);
    }

    return c.json({ ok: true, invalidated: payload.depKeys?.length ?? 0 });
  };
}
