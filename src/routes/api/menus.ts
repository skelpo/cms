// /api/v1/menus/*

import { Hono } from 'hono';
import {
  getMenuTree,
  listMenus,
  createMenu,
  updateMenu,
  deleteMenu,
  addMenuItem,
  updateMenuItem,
  deleteMenuItem,
  reorderMenuItems,
} from '../../menus/store.js';
import { getDefaultLocale } from '../../settings/store.js';
import { withCache } from '../../cache/respond.js';
import { invalidate } from '../../cache/deps.js';
import { errorResponse } from './_helpers.js';
import { requireAuth, isResponse } from '../../auth/middleware.js';
import { can } from '../../permissions/check.js';

export const menuRoutes = new Hono();

// ─── GET /menus (list) ───────────────────────────────────────────────────

menuRoutes.get('/', async (c) => {
  return withCache(c, 'GET:/menus', async (deps) => {
    deps.add('menus:all'); // umbrella dep so create/rename/delete can invalidate this list
    const menus = await listMenus();
    return { body: { data: menus } };
  });
});

// ─── GET /menus/:slug (tree) ─────────────────────────────────────────────

menuRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const defaultLocale = await getDefaultLocale();
  const locale = c.req.query('locale') ?? defaultLocale;
  return withCache(c, `GET:/menus/${slug}:${locale}`, async (deps) => {
    deps.addMenu(slug, locale);
    const tree = await getMenuTree(slug, locale, defaultLocale);
    if (!tree) {
      return { status: 404, body: { error: { code: 'notFound', message: 'Menu not found' } } };
    }
    return { body: { data: { slug: tree.menu.slug, label: tree.menu.label, items: tree.items } } };
  });
});

// ─── POST /menus (create) ────────────────────────────────────────────────

menuRoutes.post('/', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageMenus')) {
    return errorResponse(c, 'forbidden', 'manageMenus capability required', 403);
  }
  const body = await c.req.json<{ slug?: string; label?: string }>().catch(() => ({}) as { slug?: string; label?: string });
  const slug = String(body.slug ?? '').trim();
  const label = String(body.label ?? '').trim();
  if (!slug || !label) return errorResponse(c, 'validationError', 'slug and label required', 422);
  const menu = await createMenu({ slug, label });
  invalidate(['menus:all']);
  return c.json({ data: menu }, 201);
});

// ─── PATCH /menus/:slug ──────────────────────────────────────────────────

menuRoutes.patch('/:slug', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageMenus')) {
    return errorResponse(c, 'forbidden', 'manageMenus capability required', 403);
  }
  const slug = c.req.param('slug');
  const body = await c.req.json<{ label?: string }>().catch(() => ({}) as { label?: string });
  const patch: { label?: string } = {};
  if (body.label !== undefined) patch.label = String(body.label);
  const updated = await updateMenu(slug, patch);
  if (!updated) return errorResponse(c, 'notFound', 'Menu not found', 404);
  invalidate([`menu:${slug}`], { prefix: true });
  invalidate(['menus:all']);
  return c.json({ data: updated });
});

// ─── DELETE /menus/:slug ─────────────────────────────────────────────────

menuRoutes.delete('/:slug', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageMenus')) {
    return errorResponse(c, 'forbidden', 'manageMenus capability required', 403);
  }
  const slug = c.req.param('slug');
  const ok = await deleteMenu(slug);
  if (!ok) return errorResponse(c, 'conflict', 'Cannot delete: not found or built-in', 409);
  invalidate([`menu:${slug}`], { prefix: true });
  invalidate(['menus:all']);
  return c.body(null, 204);
});

// ─── POST /menus/:slug/items ─────────────────────────────────────────────

menuRoutes.post('/:slug/items', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageMenus')) {
    return errorResponse(c, 'forbidden', 'manageMenus capability required', 403);
  }
  const slug = c.req.param('slug');
  const body = await c.req.json<{
    parentId?: number | null;
    label?: Record<string, string>;
    url?: string | null;
    contentId?: number | null;
    target?: '_self' | '_blank';
    sortOrder?: number;
  }>().catch(() => ({} as {
    parentId?: number | null;
    label?: Record<string, string>;
    url?: string | null;
    contentId?: number | null;
    target?: '_self' | '_blank';
    sortOrder?: number;
  }));
  if (!body.label || typeof body.label !== 'object') {
    return errorResponse(c, 'validationError', 'label (object with locale keys) required', 422);
  }
  try {
    const itemInput: Parameters<typeof addMenuItem>[1] = { label: body.label };
    if (body.parentId !== undefined)  itemInput.parentId  = body.parentId;
    if (body.url !== undefined)       itemInput.url       = body.url;
    if (body.contentId !== undefined) itemInput.contentId = body.contentId;
    if (body.target !== undefined)    itemInput.target    = body.target;
    if (body.sortOrder !== undefined) itemInput.sortOrder = body.sortOrder;
    const id = await addMenuItem(slug, itemInput);
    invalidate([`menu:${slug}`], { prefix: true });
    return c.json({ data: { id } }, 201);
  } catch (err) {
    return errorResponse(c, 'validationError', (err as Error).message, 422);
  }
});

// ─── PATCH /menus/:slug/items/:id ────────────────────────────────────────

menuRoutes.patch('/:slug/items/:id', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageMenus')) {
    return errorResponse(c, 'forbidden', 'manageMenus capability required', 403);
  }
  const slug = c.req.param('slug');
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) {
    return errorResponse(c, 'badRequest', 'Invalid id', 400);
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  await updateMenuItem(id, body as Parameters<typeof updateMenuItem>[1]);
  invalidate([`menu:${slug}`], { prefix: true });
  return c.body(null, 204);
});

// ─── DELETE /menus/:slug/items/:id ───────────────────────────────────────

menuRoutes.delete('/:slug/items/:id', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageMenus')) {
    return errorResponse(c, 'forbidden', 'manageMenus capability required', 403);
  }
  const slug = c.req.param('slug');
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) {
    return errorResponse(c, 'badRequest', 'Invalid id', 400);
  }
  const ok = await deleteMenuItem(id);
  if (!ok) return errorResponse(c, 'notFound', 'Menu item not found', 404);
  invalidate([`menu:${slug}`], { prefix: true });
  return c.body(null, 204);
});

// ─── POST /menus/:slug/items/reorder ─────────────────────────────────────

menuRoutes.post('/:slug/items/reorder', async (c) => {
  const auth = requireAuth(c);
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageMenus')) {
    return errorResponse(c, 'forbidden', 'manageMenus capability required', 403);
  }
  const slug = c.req.param('slug');
  const body = await c.req.json<{ items?: Array<{ id: number; parentId: number | null; sortOrder: number }> }>().catch(() => ({} as { items?: Array<{ id: number; parentId: number | null; sortOrder: number }> }));
  if (!Array.isArray(body.items)) {
    return errorResponse(c, 'validationError', 'items array required', 422);
  }
  await reorderMenuItems(body.items);
  invalidate([`menu:${slug}`], { prefix: true });
  return c.body(null, 204);
});
