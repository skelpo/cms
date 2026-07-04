// /api/v1/webhooks/* — webhook configuration + delivery audit.

import { Hono, type Context } from 'hono';
import {
  createWebhook,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
  listDeliveries,
} from '../../webhooks/dispatch.js';
import { errorResponse } from './_helpers.js';
import { requireAuth, isResponse, type AuthContext } from '../../auth/middleware.js';
import { can } from '../../permissions/check.js';

export const webhookRoutes = new Hono();

function guard(c: Context): AuthContext | Response {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageSettings')) {
    return errorResponse(c, 'forbidden', 'manageSettings capability required', 403);
  }
  return auth;
}

webhookRoutes.get('/', async (c) => {
  const g = guard(c);
  if (isResponse(g)) return g;
  return c.json({ data: await listWebhooks() });
});

webhookRoutes.post('/', async (c) => {
  const g = guard(c);
  if (isResponse(g)) return g;
  const body = await c.req.json<{ url?: string; events?: string[]; description?: string }>()
    .catch(() => ({}) as { url?: string; events?: string[]; description?: string });
  if (!body.url || !Array.isArray(body.events) || body.events.length === 0) {
    return errorResponse(c, 'validationError', 'url and non-empty events[] required', 422);
  }
  let created: { id: number; secret: string };
  try {
    created = await createWebhook({
      url: body.url,
      events: body.events,
      ...(body.description !== undefined ? { description: body.description } : {}),
    });
  } catch (e) {
    return errorResponse(c, 'validationError', (e as Error).message, 422);
  }
  // secret returned ONCE.
  return c.json({ data: { id: created.id, secret: created.secret, url: body.url, events: body.events } }, 201);
});

webhookRoutes.patch('/:id', async (c) => {
  const g = guard(c);
  if (isResponse(g)) return g;
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return errorResponse(c, 'badRequest', 'Invalid id', 400);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  let ok: boolean;
  try {
    ok = await updateWebhook(id, body as Parameters<typeof updateWebhook>[1]);
  } catch (e) {
    return errorResponse(c, 'validationError', (e as Error).message, 422);
  }
  if (!ok) return errorResponse(c, 'notFound', 'Webhook not found', 404);
  return c.body(null, 204);
});

webhookRoutes.delete('/:id', async (c) => {
  const g = guard(c);
  if (isResponse(g)) return g;
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return errorResponse(c, 'badRequest', 'Invalid id', 400);
  const ok = await deleteWebhook(id);
  if (!ok) return errorResponse(c, 'notFound', 'Webhook not found', 404);
  return c.body(null, 204);
});

webhookRoutes.get('/:id/deliveries', async (c) => {
  const g = guard(c);
  if (isResponse(g)) return g;
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return errorResponse(c, 'badRequest', 'Invalid id', 400);
  return c.json({ data: await listDeliveries(id) });
});
