// Outbound webhook dispatch + signing. Webhook events are fanned out as
// `webhookDispatch` jobs (one per matching webhook) so retries + the
// delivery audit log come for free via the queue.

import { execute, query, queryOne } from '../db/client.js';
import { enqueue } from '../jobs/queue.js';

export interface WebhookRow {
  id: number;
  url: string;
  events: string | string[];
  secret: string;
  active: number;
  description: string | null;
}

export type WebhookEvent =
  | 'content.created'
  | 'content.updated'
  | 'content.published'
  | 'content.unpublished'
  | 'content.deleted'
  | 'media.uploaded'
  | 'media.updated'
  | 'media.deleted'
  | 'menu.updated'
  | 'setting.changed'
  | 'form.submitted'
  | 'redirect.updated'
  | 'type.schemaChanged';

function parseEvents(v: string | string[]): string[] {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

/**
 * Fan an event out to every active webhook subscribed to it. Each
 * delivery is its own job — independent retry + audit row.
 */
export async function fireEvent(
  event: WebhookEvent,
  data: Record<string, unknown>,
  depKeys: string[],
): Promise<void> {
  const hooks = await query<WebhookRow>(
    'SELECT `id`, `url`, `events`, `secret` FROM `webhooks` WHERE `active` = 1',
  );
  for (const h of hooks) {
    const events = parseEvents(h.events);
    if (!events.includes(event) && !events.includes('*')) continue;
    await enqueue('webhookDispatch', {
      webhookId: h.id,
      event,
      data,
      depKeys,
    });
  }
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Job handler for `webhookDispatch`. Delivers the payload, records the
 * attempt in webhookDeliveries, throws on non-2xx so the queue retries.
 */
export async function deliverWebhookJob(payload: {
  webhookId: number;
  event: string;
  data: Record<string, unknown>;
  depKeys: string[];
}): Promise<void> {
  const hook = await queryOne<WebhookRow>(
    'SELECT * FROM `webhooks` WHERE `id` = ? AND `active` = 1',
    [payload.webhookId],
  );
  if (!hook) return; // webhook deleted/deactivated since enqueue — drop silently

  const bodyObj = {
    event: payload.event,
    deliveredAt: new Date().toISOString(),
    data: payload.data,
    depKeys: payload.depKeys,
  };
  const body = JSON.stringify(bodyObj);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await hmacSha256Hex(hook.secret, `${ts}.${body}`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Skelpo-Event': payload.event,
    'X-Skelpo-Signature': `t=${ts},v1=${sig}`,
    'X-Skelpo-Delivery': `dlv_${Date.now()}_${hook.id}`,
  };

  const started = Date.now();
  let responseStatus: number | null = null;
  let responseBody = '';
  let error: string | null = null;
  try {
    const resp = await fetch(hook.url, { method: 'POST', headers, body });
    responseStatus = resp.status;
    responseBody = (await resp.text()).slice(0, 2000);
    if (!resp.ok) error = `HTTP ${resp.status}`;
  } catch (e) {
    error = (e as Error).message;
  }
  const latencyMs = Date.now() - started;

  await execute(
    `INSERT INTO \`webhookDeliveries\`
       (\`webhookId\`, \`event\`, \`payload\`, \`requestHeaders\`, \`responseStatus\`,
        \`responseBody\`, \`latencyMs\`, \`succeeded\`, \`error\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      hook.id,
      payload.event,
      body,
      JSON.stringify(headers),
      responseStatus,
      responseBody,
      latencyMs,
      error ? 0 : 1,
      error,
    ],
  );

  if (error) {
    throw new Error(`Webhook delivery failed: ${error}`);
  }
}

// ────────── Webhook config CRUD ──────────

function randomHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function createWebhook(input: {
  url: string;
  events: string[];
  description?: string;
}): Promise<{ id: number; secret: string }> {
  const secret = randomHex(32);
  const r = await execute(
    'INSERT INTO `webhooks` (`url`, `events`, `secret`, `description`) VALUES (?, ?, ?, ?)',
    [input.url, JSON.stringify(input.events), secret, input.description ?? null],
  );
  return { id: Number(r.insertId), secret };
}

export async function listWebhooks(): Promise<Array<Omit<WebhookRow, 'secret'> & { events: string[] }>> {
  const rows = await query<WebhookRow>('SELECT * FROM `webhooks` ORDER BY `id`');
  return rows.map((r) => ({
    id: r.id, url: r.url, events: parseEvents(r.events), active: r.active, description: r.description,
  }));
}

export async function updateWebhook(
  id: number,
  patch: { url?: string; events?: string[]; active?: boolean; description?: string },
): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.url !== undefined)         { sets.push('`url` = ?');        params.push(patch.url); }
  if (patch.events !== undefined)      { sets.push('`events` = ?');     params.push(JSON.stringify(patch.events)); }
  if (patch.active !== undefined)      { sets.push('`active` = ?');     params.push(patch.active ? 1 : 0); }
  if (patch.description !== undefined) { sets.push('`description` = ?'); params.push(patch.description); }
  if (sets.length === 0) return false;
  params.push(id);
  const r = await execute(`UPDATE \`webhooks\` SET ${sets.join(', ')} WHERE \`id\` = ?`, params);
  return r.affectedRows > 0;
}

export async function deleteWebhook(id: number): Promise<boolean> {
  const r = await execute('DELETE FROM `webhooks` WHERE `id` = ?', [id]);
  return r.affectedRows > 0;
}

export async function listDeliveries(webhookId: number, limit = 50): Promise<unknown[]> {
  return query(
    `SELECT \`id\`, \`event\`, \`responseStatus\`, \`latencyMs\`, \`succeeded\`, \`error\`, \`createdAt\`
       FROM \`webhookDeliveries\` WHERE \`webhookId\` = ?
      ORDER BY \`createdAt\` DESC LIMIT ?`,
    [webhookId, Math.min(limit, 100)],
  );
}
