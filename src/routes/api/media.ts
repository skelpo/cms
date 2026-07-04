// /api/v1/media/*

import { Hono } from 'hono';
import {
  storeMedia,
  getMedia,
  listMedia,
  updateMedia,
  deleteMedia,
  readMediaBytes,
  mediaPublicUrl,
} from '../../media/store.js';
import { signedImgproxyUrl, type TransformOpts } from '../../media/imgproxy.js';
import { getSiteUrl } from '../../settings/store.js';
import { normalizeDates } from '../../db/datetime.js';
import { errorResponse } from './_helpers.js';
import { requireAuth, isResponse } from '../../auth/middleware.js';
import { can } from '../../permissions/check.js';

export const mediaRoutes = new Hono();

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
// MIME types safe to serve inline; everything else (SVG, HTML, unknown) is sent
// as an attachment + nosniff so it can't execute as active content on our
// same-origin media path.
const INLINE_SAFE = /^(?:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/pdf)$/i;

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
  if (isResponse(auth)) return auth;
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
  // Backend exposes the file directly (public S3 bucket or CDN)?
  // 302-redirect there so the CMS stays out of the byte path.
  const direct = mediaPublicUrl(m);
  if (direct) return c.redirect(direct, 302);
  const bytes = await readMediaBytes(m);
  const safeName = (m.filename || 'download').replace(/[^\w.\- ]+/g, '_').slice(0, 128);
  const disposition = INLINE_SAFE.test(m.mimeType) ? 'inline' : `attachment; filename="${safeName}"`;
  return new Response(bytes as BodyInit, {
    headers: {
      'Content-Type': m.mimeType,
      // Never let the browser sniff uploaded bytes into an executable type, and
      // force non-image/av/pdf content to download rather than render inline.
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': disposition,
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
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageMedia')) {
    return errorResponse(c, 'forbidden', 'manageMedia capability required', 403);
  }
  const body = await c.req.parseBody();
  const file = body.file;
  if (!file || typeof file === 'string') {
    return errorResponse(c, 'validationError', 'multipart `file` field required', 422);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return errorResponse(c, 'contentTooLarge', `file exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB limit`, 413);
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
  if (isResponse(auth)) return auth;
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
  if (isResponse(auth)) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageMedia')) {
    return errorResponse(c, 'forbidden', 'manageMedia capability required', 403);
  }
  const ok = await deleteMedia(Number(c.req.param('id')));
  if (!ok) return errorResponse(c, 'notFound', 'Media not found', 404);
  return c.body(null, 204);
});
