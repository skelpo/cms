// Media metadata layer. Bytes go through `MediaStorage` (local disk or
// S3/R2/B2/MinIO); this file only cares about the row in `media` and the
// derived `storageKey` (yyyymm/randomhex-filename). The backend is
// selected by `MEDIA_BACKEND` env (see ./storage.ts).

import { execute, query, queryOne } from '../db/client.js';
import { mediaStorage } from './storage.js';

export interface MediaRow {
  id: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  width: number | null;
  height: number | null;
  altText: string | Record<string, string>;
  focalPoint: string | { x: number; y: number } | null;
  uploadedBy: number | null;
  createdAt: unknown;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
}
function randomHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// Minimal dimension sniff for the common web formats. Returns nulls for
// anything we don't parse — width/height are advisory (used for CLS).
function sniffDimensions(buf: Uint8Array, mime: string): { w: number | null; h: number | null } {
  try {
    if (mime === 'image/png' && buf.length > 24) {
      // IHDR width/height are big-endian uint32 at offsets 16 and 20.
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1]!;
        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          const h = dv.getUint16(i + 5);
          const w = dv.getUint16(i + 7);
          return { w, h };
        }
        const len = (buf[i + 2]! << 8) | buf[i + 3]!;
        i += 2 + len;
      }
    }
    if (mime === 'image/gif' && buf.length > 10) {
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
    }
  } catch {
    /* fall through */
  }
  return { w: null, h: null };
}

function parseJson<T>(v: T | string, fb: T): T {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v) as T; } catch { return fb; }
}

export interface UploadInput {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  altText: Record<string, string>;
  focalPoint?: { x: number; y: number };
  uploadedBy: number;
}

export async function storeMedia(input: UploadInput): Promise<MediaRow> {
  const ym = new Date().toISOString().slice(0, 7).replace('-', '');
  const key = `${ym}/${randomHex(8)}-${sanitize(input.filename)}`;
  await mediaStorage().put(key, input.bytes, input.mimeType);
  const { w, h } = sniffDimensions(input.bytes, input.mimeType);
  const r = await execute(
    `INSERT INTO \`media\`
       (\`filename\`,\`mimeType\`,\`sizeBytes\`,\`storageKey\`,\`width\`,\`height\`,
        \`altText\`,\`focalPoint\`,\`uploadedBy\`)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      input.filename,
      input.mimeType,
      input.bytes.length,
      key,
      w,
      h,
      JSON.stringify(input.altText),
      input.focalPoint ? JSON.stringify(input.focalPoint) : null,
      input.uploadedBy,
    ],
  );
  const row = await getMedia(Number(r.insertId));
  if (!row) throw new Error('media row vanished after insert');
  return row;
}

export async function getMedia(id: number): Promise<MediaRow | null> {
  const row = await queryOne<MediaRow>('SELECT * FROM `media` WHERE `id`=?', [id]);
  if (!row) return null;
  return {
    ...row,
    altText: parseJson<Record<string, string>>(row.altText, {}),
    focalPoint: row.focalPoint ? parseJson<{ x: number; y: number }>(row.focalPoint, { x: 0.5, y: 0.5 }) : null,
  };
}

export async function readMediaBytes(row: MediaRow): Promise<Uint8Array> {
  return mediaStorage().get(row.storageKey);
}

/** Direct URL the public can hit (e.g., S3 + CDN), or null if bytes must
 *  be proxied through the CMS. Caller decides whether to 302 or stream. */
export function mediaPublicUrl(row: MediaRow): string | null {
  return mediaStorage().publicUrl(row.storageKey);
}

export async function listMedia(opts: { mimeType?: string; limit?: number } = {}): Promise<MediaRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const where = opts.mimeType ? 'WHERE `mimeType` LIKE ?' : '';
  const params: unknown[] = opts.mimeType ? [`${opts.mimeType}%`] : [];
  params.push(limit);
  const rows = await query<MediaRow>(
    `SELECT * FROM \`media\` ${where} ORDER BY \`id\` DESC LIMIT ?`,
    params,
  );
  return rows.map((r) => ({
    ...r,
    altText: parseJson<Record<string, string>>(r.altText, {}),
    focalPoint: r.focalPoint ? parseJson<{ x: number; y: number }>(r.focalPoint, { x: 0.5, y: 0.5 }) : null,
  }));
}

export async function updateMedia(
  id: number,
  patch: { altText?: Record<string, string>; focalPoint?: { x: number; y: number }; filename?: string },
): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.altText !== undefined)   { sets.push('`altText`=?');    params.push(JSON.stringify(patch.altText)); }
  if (patch.focalPoint !== undefined){ sets.push('`focalPoint`=?'); params.push(JSON.stringify(patch.focalPoint)); }
  if (patch.filename !== undefined)  { sets.push('`filename`=?');   params.push(patch.filename); }
  if (sets.length === 0) return false;
  params.push(id);
  const r = await execute(`UPDATE \`media\` SET ${sets.join(',')} WHERE \`id\`=?`, params);
  return r.affectedRows > 0;
}

export async function deleteMedia(id: number): Promise<boolean> {
  const row = await getMedia(id);
  if (!row) return false;
  const r = await execute('DELETE FROM `media` WHERE `id`=?', [id]);
  if (r.affectedRows > 0) {
    await mediaStorage().delete(row.storageKey);
    return true;
  }
  return false;
}
