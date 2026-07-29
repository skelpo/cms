// /api/v1/settings/*

import { Hono } from 'hono';
import { getAllSettings, getPublicSettings, getSetting, isSensitiveSettingKey, setSetting, invalidateSettingsCache } from '../../settings/store.js';
import { invalidate } from '../../cache/deps.js';
import { fireEvent } from '../../webhooks/dispatch.js';
import { withCache } from '../../cache/respond.js';
import { errorResponse } from './_helpers.js';
import { requireAuth, isResponse } from '../../auth/middleware.js';
import { can } from '../../permissions/check.js';

export const settingsRoutes = new Hono();

// ─── GET /settings ───────────────────────────────────────────────────────

settingsRoutes.get('/', async (c) => {
  const auth = c.get('auth');
  const canManage = !!auth && can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageSettings');
  if (canManage) {
    // Full view for settings managers — not cached (the response varies by
    // privilege, and must never populate the shared public cache with secrets).
    return c.json({ data: await getAllSettings() });
  }
  // Anonymous/public callers get the sensitive keys filtered out.
  return withCache(c, 'GET:/settings', async (deps) => {
    deps.add('settings:all'); // umbrella dep so any settings write invalidates this list
    const pub = await getPublicSettings();
    for (const key of Object.keys(pub)) deps.addSetting(key);
    return { body: { data: pub } };
  });
});

// ─── GET /settings/:key ──────────────────────────────────────────────────

settingsRoutes.get('/:key', async (c) => {
  const key = c.req.param('key');
  const auth = c.get('auth');
  const canManage = !!auth && can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageSettings');
  // Sensitive keys (previewToken, secrets, credentials) are never cached and
  // are only readable by settings managers.
  if (isSensitiveSettingKey(key)) {
    if (!canManage) return errorResponse(c, 'notFound', `Setting '${key}' not set`, 404);
    const v = await getSetting(key, null);
    if (v === null) return errorResponse(c, 'notFound', `Setting '${key}' not set`, 404);
    return c.json({ data: { [key]: v } });
  }
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
  if (isResponse(auth)) return auth;
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
  invalidate(['settings:all']);
  void fireEvent('setting.changed', { key }, [`setting:${key}`, 'settings:all']);
  return c.json({ data: { [key]: body.value } });
});

// ─── PUT /settings (bulk) ────────────────────────────────────────────────

settingsRoutes.put('/', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
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
  invalidate(['settings:all']);
  for (const key of Object.keys(body)) {
    void fireEvent('setting.changed', { key }, [`setting:${key}`, 'settings:all']);
  }
  return c.json({ data: body });
});
