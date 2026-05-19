// /api/v1/content/* — read endpoints (v0.1).
//
// Public reads (status=published, no auth required) go through the cache.
// Authenticated draft reads bypass the cache entirely and require either
// a session/token with the right capability.

import { Hono } from 'hono';
import {
  findById,
  findBySlug,
  findByPath,
  listContent,
  inflateContent,
  type ContentStatus,
} from '../../content/content.js';
import { getTypeBySlug } from '../../content/types.js';
import {
  createContent,
  updateContent,
  deleteContent,
  publishContent,
  unpublishContent,
} from '../../content/writer.js';
import { getDefaultLocale, getConfiguredLocales } from '../../settings/store.js';
import { withCache } from '../../cache/respond.js';
import { invalidate } from '../../cache/deps.js';
import { fireEvent } from '../../webhooks/dispatch.js';
import { errorResponse } from './_helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { can } from '../../permissions/check.js';

export const contentRoutes = new Hono();

// ─── GET /content ────────────────────────────────────────────────────────

contentRoutes.get('/', async (c) => {
  const type = c.req.query('type');
  if (!type) {
    return errorResponse(c, 'validationError', 'Query parameter `type` is required', 422);
  }
  const t = await getTypeBySlug(type);
  if (!t) return errorResponse(c, 'notFound', `Unknown content type: ${type}`, 404);

  const defaultLocale = await getDefaultLocale();
  const locale = c.req.query('locale') ?? defaultLocale;
  const limit = Number(c.req.query('limit') ?? 20);
  const cursor = c.req.query('cursor') ?? undefined;
  const sort = c.req.query('sort') ?? '-publishedAt';
  const status = c.req.query('status');
  const includeRelations = (c.req.query('include') ?? '').split(',').includes('relations');
  const authorId = c.req.query('authorId') ? Number(c.req.query('authorId')) : undefined;
  const slug = c.req.query('slug');

  // If filtering by non-published status, require auth + capability.
  const auth = c.get('auth');
  let statuses: ContentStatus[] | undefined;
  if (status && status !== 'published') {
    if (!auth) return errorResponse(c, 'unauthorized', 'Authentication required for draft reads', 401);
    if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'readDrafts', t.slug)) {
      return errorResponse(c, 'forbidden', `No readDrafts capability for ${t.slug}`, 403);
    }
    statuses = status.split(',').map((s) => s.trim()) as ContentStatus[];
  }

  // Authenticated draft reads skip the cache.
  if (statuses) {
    const opts: Parameters<typeof listContent>[0] = {
      typeSlug: t.slug,
      locale,
      status: statuses,
      sort,
      limit,
      includeDrafts: true,
    };
    if (cursor) opts.cursor = cursor;
    if (authorId !== undefined) opts.authorId = authorId;
    if (slug) opts.slug = slug;
    const { rows, nextCursor } = await listContent(opts);
    const data = await Promise.all(
      rows.map((r) => inflateContent(r, { includeRelations, defaultLocale })),
    );
    return c.json({ data, pagination: { nextCursor, hasMore: nextCursor !== null } });
  }

  // Public read — cacheable.
  const cacheKey = `GET:/content?${new URLSearchParams({
    type, locale, limit: String(limit), cursor: cursor ?? '',
    sort, authorId: authorId !== undefined ? String(authorId) : '',
    slug: slug ?? '', include: includeRelations ? 'relations' : '',
  }).toString()}`;
  return withCache(c, cacheKey, async (deps) => {
    deps.addTypeList(t.slug, locale);
    const opts: Parameters<typeof listContent>[0] = {
      typeSlug: t.slug, locale, sort, limit,
    };
    if (cursor) opts.cursor = cursor;
    if (authorId !== undefined) opts.authorId = authorId;
    if (slug) opts.slug = slug;
    const { rows, nextCursor } = await listContent(opts);
    const data = await Promise.all(
      rows.map(async (r) => {
        deps.addContent(r.id);
        return inflateContent(r, { includeRelations, defaultLocale });
      }),
    );
    return { body: { data, pagination: { nextCursor, hasMore: nextCursor !== null } } };
  });
});

// ─── GET /content/by-id/:id ──────────────────────────────────────────────

contentRoutes.get('/by-id/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) {
    return errorResponse(c, 'badRequest', 'Invalid id', 400);
  }
  const auth = c.get('auth');
  const row = await findById(id, /* includeDrafts */ !!auth);
  if (!row) return errorResponse(c, 'notFound', 'Content not found', 404);

  // If draft, require capability.
  if (row.status !== 'published') {
    if (!auth) return errorResponse(c, 'unauthorized', 'Authentication required', 401);
    if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'readDrafts', row.typeSlug, row.authorId)) {
      return errorResponse(c, 'forbidden', 'Cannot read drafts of this type', 403);
    }
  }

  const defaultLocale = await getDefaultLocale();
  const includeRelations = (c.req.query('include') ?? '').split(',').includes('relations');

  // Drafts bypass cache.
  if (row.status !== 'published') {
    const data = await inflateContent(row, { includeRelations, defaultLocale });
    return c.json({ data });
  }

  return withCache(c, `GET:/content/by-id/${id}:${includeRelations}`, async (deps) => {
    deps.addContent(row.id);
    const data = await inflateContent(row, { includeRelations, defaultLocale });
    return { body: { data } };
  });
});

// ─── GET /content/by-slug/:type/:slug ────────────────────────────────────

contentRoutes.get('/by-slug/:type/:slug', async (c) => {
  const typeSlug = c.req.param('type');
  const slug = c.req.param('slug');
  if (!typeSlug || !slug) {
    return errorResponse(c, 'badRequest', 'type and slug required', 400);
  }
  const t = await getTypeBySlug(typeSlug);
  if (!t) return errorResponse(c, 'notFound', `Unknown content type: ${typeSlug}`, 404);

  const defaultLocale = await getDefaultLocale();
  const locale = c.req.query('locale') ?? defaultLocale;
  const auth = c.get('auth');
  const row = await findBySlug(typeSlug, slug, locale, !!auth);
  if (!row) return errorResponse(c, 'notFound', 'Content not found', 404);

  if (row.status !== 'published') {
    if (!auth) return errorResponse(c, 'unauthorized', 'Authentication required', 401);
    if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'readDrafts', row.typeSlug, row.authorId)) {
      return errorResponse(c, 'forbidden', 'Cannot read drafts of this type', 403);
    }
  }

  const includeRelations = (c.req.query('include') ?? '').split(',').includes('relations');
  if (row.status !== 'published') {
    const data = await inflateContent(row, { includeRelations, defaultLocale });
    return c.json({ data });
  }

  return withCache(c, `GET:/content/by-slug/${typeSlug}/${slug}:${locale}:${includeRelations}`, async (deps) => {
    deps.addContent(row.id);
    const data = await inflateContent(row, { includeRelations, defaultLocale });
    return { body: { data } };
  });
});

// ─── GET /content/by-path/:path* ─────────────────────────────────────────

contentRoutes.get('/by-path/*', async (c) => {
  const url = new URL(c.req.url);
  // Strip the leading prefix; everything after /by-path/ is the target path.
  const idx = url.pathname.indexOf('/by-path/');
  if (idx < 0) return errorResponse(c, 'badRequest', 'Bad path', 400);
  const rawPath = '/' + url.pathname.slice(idx + '/by-path/'.length).replace(/^\/+/, '');

  const defaultLocale = await getDefaultLocale();
  const locales = await getConfiguredLocales();
  const auth = c.get('auth');
  const row = await findByPath(rawPath, defaultLocale, locales, !!auth);

  if (!row) {
    return c.json({ data: { type: null, content: null, redirect: null } }, 404);
  }

  if (row.status !== 'published') {
    if (!auth) return errorResponse(c, 'unauthorized', 'Authentication required', 401);
    if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'readDrafts', row.typeSlug, row.authorId)) {
      return errorResponse(c, 'forbidden', 'Cannot read drafts of this type', 403);
    }
  }

  const includeRelations = (c.req.query('include') ?? '').split(',').includes('relations');
  if (row.status !== 'published') {
    const data = await inflateContent(row, { includeRelations, defaultLocale });
    return c.json({ data: { type: row.typeSlug, content: data, redirect: null } });
  }

  return withCache(c, `GET:/content/by-path${rawPath}:${includeRelations}`, async (deps) => {
    deps.addContent(row.id);
    const data = await inflateContent(row, { includeRelations, defaultLocale });
    return { body: { data: { type: row.typeSlug, content: data, redirect: null } } };
  });
});

// ─── Write helpers ───────────────────────────────────────────────────────

function invalidateForContent(typeSlug: string, locale: string, id?: number): void {
  if (id !== undefined) invalidate([`content:${id}`]);
  invalidate([`type-list:${typeSlug}:${locale}`], { prefix: true });
}

function depKeysForContent(typeSlug: string, locale: string, id: number): string[] {
  return [`content:${id}`, `type-list:${typeSlug}:${locale}`];
}

// ─── POST /content ───────────────────────────────────────────────────────

contentRoutes.post('/', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const body = (await c.req.json<{
    type?: string;
    slug?: string;
    locale?: string;
    title?: string;
    fields?: Record<string, unknown>;
    seo?: Record<string, unknown>;
    ai?: Record<string, unknown>;
    status?: ContentStatus;
    translationOf?: number | null;
  }>().catch(() => ({}) as Record<string, never>));

  if (!body.type || !body.slug || !body.locale || !body.title) {
    return errorResponse(c, 'validationError', 'type, slug, locale, title required', 422);
  }
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'create', body.type)) {
    return errorResponse(c, 'forbidden', `No create capability for ${body.type}`, 403);
  }
  const result = await createContent({
    type:          body.type,
    slug:          body.slug,
    locale:        body.locale,
    title:         body.title,
    fields:        body.fields ?? {},
    seo:           body.seo ?? {},
    ai:            body.ai ?? {},
    status:        body.status ?? 'draft',
    authorId:      auth.user.id,
    translationOf: body.translationOf ?? null,
  });
  if (!result.ok) {
    return errorResponse(c, 'validationError', result.errors[0]?.message ?? 'Validation failed', 422, { errors: result.errors });
  }
  invalidateForContent(body.type, body.locale, result.id);
  void fireEvent('content.created', { id: result.id, type: body.type, locale: body.locale }, depKeysForContent(body.type, body.locale, result.id));
  const created = await findById(result.id, /* includeDrafts */ true);
  if (!created) return errorResponse(c, 'internalError', 'Created row not found', 500);
  const defaultLocale = await getDefaultLocale();
  return c.json({ data: await inflateContent(created, { defaultLocale }) }, 201);
});

// ─── PATCH /content/:id ──────────────────────────────────────────────────

contentRoutes.patch('/:id', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) return errorResponse(c, 'badRequest', 'Invalid id', 400);

  const existing = await findById(id, true);
  if (!existing) return errorResponse(c, 'notFound', 'Content not found', 404);
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'update', existing.typeSlug, existing.authorId)) {
    return errorResponse(c, 'forbidden', `No update capability for ${existing.typeSlug}`, 403);
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const result = await updateContent(id, body as Parameters<typeof updateContent>[1], auth.user.id);
  if (!result.ok) {
    const status = result.status ?? 422;
    const codeMap: Record<number, string> = { 404: 'notFound', 409: 'conflict', 422: 'validationError', 500: 'internalError' };
    return errorResponse(
      c,
      codeMap[status] ?? 'validationError',
      result.errors[0]?.message ?? 'Validation failed',
      status as 404 | 409 | 422 | 500,
      { errors: result.errors },
    );
  }
  invalidateForContent(result.row.typeSlug, result.row.locale, id);
  void fireEvent('content.updated', { id, type: result.row.typeSlug, locale: result.row.locale }, depKeysForContent(result.row.typeSlug, result.row.locale, id));
  const defaultLocale = await getDefaultLocale();
  return c.json({ data: await inflateContent(result.row, { defaultLocale }) });
});

// ─── DELETE /content/:id ─────────────────────────────────────────────────

contentRoutes.delete('/:id', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) return errorResponse(c, 'badRequest', 'Invalid id', 400);
  const existing = await findById(id, true);
  if (!existing) return errorResponse(c, 'notFound', 'Content not found', 404);
  const hard = c.req.query('hard') === 'true';
  const action = hard ? 'delete' : 'update';
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, action, existing.typeSlug, existing.authorId)) {
    return errorResponse(c, 'forbidden', `No ${action} capability for ${existing.typeSlug}`, 403);
  }
  const ok = await deleteContent(id, hard);
  if (!ok) return errorResponse(c, 'notFound', 'Content not found', 404);
  invalidateForContent(existing.typeSlug, existing.locale, id);
  void fireEvent('content.deleted', { id, type: existing.typeSlug, locale: existing.locale }, depKeysForContent(existing.typeSlug, existing.locale, id));
  return c.body(null, 204);
});

// ─── POST /content/:id/publish ───────────────────────────────────────────

contentRoutes.post('/:id/publish', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) return errorResponse(c, 'badRequest', 'Invalid id', 400);
  const existing = await findById(id, true);
  if (!existing) return errorResponse(c, 'notFound', 'Content not found', 404);
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'publish', existing.typeSlug, existing.authorId)) {
    return errorResponse(c, 'forbidden', `No publish capability for ${existing.typeSlug}`, 403);
  }
  const result = await publishContent(id, auth.user.id);
  if (!result.ok) {
    return errorResponse(c, 'validationError', 'Publish blocked by validation', 422, { errors: result.errors });
  }
  invalidateForContent(result.row.typeSlug, result.row.locale, id);
  void fireEvent('content.published', { id, type: result.row.typeSlug, locale: result.row.locale }, depKeysForContent(result.row.typeSlug, result.row.locale, id));
  const defaultLocale = await getDefaultLocale();
  return c.json({ data: await inflateContent(result.row, { defaultLocale }) });
});

// ─── POST /content/:id/unpublish ─────────────────────────────────────────

contentRoutes.post('/:id/unpublish', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) return errorResponse(c, 'badRequest', 'Invalid id', 400);
  const existing = await findById(id, true);
  if (!existing) return errorResponse(c, 'notFound', 'Content not found', 404);
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'publish', existing.typeSlug, existing.authorId)) {
    return errorResponse(c, 'forbidden', `No publish capability for ${existing.typeSlug}`, 403);
  }
  const ok = await unpublishContent(id, auth.user.id);
  if (!ok) return errorResponse(c, 'conflict', 'Not published', 409);
  invalidateForContent(existing.typeSlug, existing.locale, id);
  void fireEvent('content.unpublished', { id, type: existing.typeSlug, locale: existing.locale }, depKeysForContent(existing.typeSlug, existing.locale, id));
  const after = await findById(id, true);
  const defaultLocale = await getDefaultLocale();
  return c.json({ data: after ? await inflateContent(after, { defaultLocale }) : null });
});
