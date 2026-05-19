// /api/v1/media/*

import { Hono } from 'hono';
import {
  storeMedia,
  getMedia,
  listMedia,
  updateMedia,
  deleteMedia,
  readMediaBytes,
} from '../../media/store.js';
import { signedImgproxyUrl, type TransformOpts } from '../../media/imgproxy.js';
import { getSiteUrl } from '../../settings/store.js';
import { normalizeDates } from '../../db/datetime.js';
import { errorResponse } from './_helpers.js';
import { requireAuth } from '../../auth/middleware.js';
import { can } from '../../permissions/check.js';

export const mediaRoutes = new Hono();

function publicShape(m: Awaited<ReturnType<typeof getMedia>>) {
  if (!m) return null;
  return normalizeDates({
    id: m.id,
    filename: m.filename,
    mimeType: m.mimeType,
    sizeBytes: m.sizeBytes,
    width: m.width,
    height: m.height,
    altText: m.altText,
    focalPoint: m.focalPoint,
    createdAt: m.createdAt,
    urlRaw: `/api/v1/media/${m.id}/raw`,
  });
}

// ─── GET /media (list) ───────────────────────────────────────────────────

mediaRoutes.get('/', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const mimeType = c.req.query('mimeType');
  const list = await listMedia({
    ...(mimeType ? { mimeType } : {}),
    limit: Number(c.req.query('limit') ?? 50),
  });
  return c.json({ data: list.map(publicShape) });
});

// ─── GET /media/:id ──────────────────────────────────────────────────────

mediaRoutes.get('/:id{[0-9]+}', async (c) => {
  const m = await getMedia(Number(c.req.param('id')));
  if (!m) return errorResponse(c, 'notFound', 'Media not found', 404);
  return c.json({ data: publicShape(m) });
});

// ─── GET /media/:id/raw ──────────────────────────────────────────────────

mediaRoutes.get('/:id{[0-9]+}/raw', async (c) => {
  const m = await getMedia(Number(c.req.param('id')));
  if (!m) return errorResponse(c, 'notFound', 'Media not found', 404);
  const bytes = await readMediaBytes(m);
  return new Response(bytes as BodyInit, {
    headers: {
      'Content-Type': m.mimeType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(m.sizeBytes),
    },
  });
});

// ─── GET /media/:id/url (signed imgproxy) ────────────────────────────────

mediaRoutes.get('/:id{[0-9]+}/url', async (c) => {
  const m = await getMedia(Number(c.req.param('id')));
  if (!m) return errorResponse(c, 'notFound', 'Media not found', 404);
  const siteUrl = await getSiteUrl();
  const source = `${siteUrl.replace(/\/+$/, '')}/api/v1/media/${m.id}/raw`;
  const opts: TransformOpts = {};
  const w = c.req.query('w');
  const h = c.req.query('h');
  if (w) opts.w = Number(w);
  if (h) opts.h = Number(h);
  const fmt = c.req.query('format');
  if (fmt) opts.format = fmt as TransformOpts['format'];
  const q = c.req.query('quality');
  if (q) opts.quality = Number(q);
  const fit = c.req.query('fit');
  if (fit === 'contain' || fit === 'cover') opts.fit = fit;
  if (c.req.query('gravity') === 'focal' && m.focalPoint && typeof m.focalPoint === 'object') {
    opts.gravity = 'fp';
    opts.focalPoint = m.focalPoint as { x: number; y: number };
  }
  const url = await signedImgproxyUrl(source, opts);
  return c.json({ data: { url } });
});

// ─── POST /media (upload, multipart) ─────────────────────────────────────

mediaRoutes.post('/', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageMedia')) {
    return errorResponse(c, 'forbidden', 'manageMedia capability required', 403);
  }
  const body = await c.req.parseBody();
  const file = body.file;
  if (!file || typeof file === 'string') {
    return errorResponse(c, 'validationError', 'multipart `file` field required', 422);
  }
  // Opinionated stance: alt text is mandatory (a11y + SEO + LLM-friendly).
  let altText: Record<string, string> = {};
  try {
    altText = body.altText ? JSON.parse(String(body.altText)) : {};
  } catch {
    altText = { en: String(body.altText ?? '') };
  }
  const isImage = (file.type || '').startsWith('image/');
  if (isImage && Object.values(altText).filter(Boolean).length === 0) {
    return errorResponse(c, 'validationError', 'altText is required for images', 422, {
      field: 'altText',
      constraint: 'requiredForImages',
    });
  }
  let focalPoint: { x: number; y: number } | undefined;
  if (body.focalPoint) {
    try {
      focalPoint = JSON.parse(String(body.focalPoint));
    } catch {
      /* ignore bad focal point */
    }
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const row = await storeMedia({
    filename: file.name || 'upload',
    mimeType: file.type || 'application/octet-stream',
    bytes,
    altText,
    ...(focalPoint ? { focalPoint } : {}),
    uploadedBy: auth.user.id,
  });
  return c.json({ data: publicShape(row) }, 201);
});

// ─── PATCH /media/:id ────────────────────────────────────────────────────

mediaRoutes.patch('/:id{[0-9]+}', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageMedia')) {
    return errorResponse(c, 'forbidden', 'manageMedia capability required', 403);
  }
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{
    altText?: Record<string, string>;
    focalPoint?: { x: number; y: number };
    filename?: string;
  }>().catch(() => ({}) as Record<string, never>);
  const ok = await updateMedia(id, body);
  if (!ok) return errorResponse(c, 'notFound', 'Media not found (or nothing to update)', 404);
  return c.body(null, 204);
});

// ─── DELETE /media/:id ───────────────────────────────────────────────────

mediaRoutes.delete('/:id{[0-9]+}', async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageMedia')) {
    return errorResponse(c, 'forbidden', 'manageMedia capability required', 403);
  }
  const ok = await deleteMedia(Number(c.req.param('id')));
  if (!ok) return errorResponse(c, 'notFound', 'Media not found', 404);
  return c.body(null, 204);
});
