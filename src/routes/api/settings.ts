// /api/v1/settings/*

import { Hono } from 'hono';
import { getAllSettings, getSetting, setSetting, invalidateSettingsCache } from '../../settings/store.js';
import { invalidate } from '../../cache/deps.js';
import { withCache } from '../../cache/respond.js';
import { errorResponse } from './_helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { can } from '../../permissions/check.js';

export const settingsRoutes = new Hono();

// ─── GET /settings ───────────────────────────────────────────────────────

settingsRoutes.get('/', async (c) => {
  return withCache(c, 'GET:/settings', async (deps) => {
    const all = await getAllSettings();
    for (const key of Object.keys(all)) deps.addSetting(key);
    return { body: { data: all } };
  });
});

// ─── GET /settings/:key ──────────────────────────────────────────────────

settingsRoutes.get('/:key', async (c) => {
  const key = c.req.param('key');
  return withCache(c, `GET:/settings/${key}`, async (deps) => {
    deps.addSetting(key);
    const v = await getSetting(key, null);
    if (v === null) return { status: 404, body: { error: { code: 'notFound', message: `Setting '${key}' not set` } } };
    return { body: { data: { [key]: v } } };
  });
});

// ─── PUT /settings/:key ──────────────────────────────────────────────────

settingsRoutes.put('/:key', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageSettings')) {
    return errorResponse(c, 'forbidden', 'manageSettings capability required', 403);
  }
  const key = c.req.param('key');
  const body = await c.req.json<{ value?: unknown }>().catch(() => ({}) as { value?: unknown });
  if (body.value === undefined) {
    return errorResponse(c, 'validationError', 'value required', 422);
  }
  await setSetting(key, body.value, auth.user.id);
  invalidateSettingsCache();
  invalidate([`setting:${key}`]);
  invalidate(['GET:/settings'], { prefix: true });
  return c.json({ data: { [key]: body.value } });
});

// ─── PUT /settings (bulk) ────────────────────────────────────────────────

settingsRoutes.put('/', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageSettings')) {
    return errorResponse(c, 'forbidden', 'manageSettings capability required', 403);
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const invalidated: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    await setSetting(key, value, auth.user.id);
    invalidated.push(`setting:${key}`);
  }
  invalidateSettingsCache();
  invalidate(invalidated);
  invalidate(['GET:/settings'], { prefix: true });
  return c.json({ data: body });
});
