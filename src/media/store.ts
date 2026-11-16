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
// The format is detected from the magic bytes, not the declared MIME type:
// files are often uploaded with the wrong extension (e.g. a WebP named .jpg),
// and walking a WebP as JPEG markers produced nonsense like 46104×26048.
export function sniffDimensions(buf: Uint8Array, _mime: string): { w: number | null; h: number | null } {
  const none = { w: null, h: null };
  try {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const ascii = (at: number, len: number): string => {
      let out = '';
      for (let k = 0; k < len && at + k < buf.length; k++) out += String.fromCharCode(buf[at + k]!);
      return out;
    };
    // PNG: IHDR width/height are big-endian uint32 at offsets 16 and 20.
    if (buf.length > 24 && buf[0] === 0x89 && ascii(1, 3) === 'PNG') {
      return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }
    // GIF: little-endian uint16 at 6 and 8.
    if (buf.length > 10 && ascii(0, 3) === 'GIF') {
      return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
    }
    // WebP: RIFF....WEBP + VP8X / VP8 / VP8L chunk.
    if (buf.length > 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
      const chunk = ascii(12, 4);
      if (chunk === 'VP8X') {
        const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
        const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
        return { w, h };
      }
      if (chunk === 'VP8 ') {
        return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        const bits = dv.getUint32(21, true);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
      return none;
    }
    // JPEG: walk the marker segments from SOI to the first SOFn.
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return none; // lost sync: give up rather than guess
        const marker = buf[i + 1]!;
        if (marker === 0xff) { i++; continue; } // fill byte
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          return { w: dv.getUint16(i + 7), h: dv.getUint16(i + 5) };
        }
        if (marker === 0xda || marker === 0xd9) return none; // scan data / EOI before any SOF
        i += 2 + dv.getUint16(i + 2);
      }
    }
  } catch {
    /* fall through */
  }
  return none;
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

function mediaFilter(opts: { mimeType?: string; q?: string }): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.mimeType) { clauses.push('`mimeType` LIKE ?'); params.push(`${opts.mimeType}%`); }
  if (opts.q) {
    const like = `%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    clauses.push('(`filename` LIKE ? OR CAST(`altText` AS CHAR) LIKE ?)');
    params.push(like, like);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export async function listMedia(opts: { mimeType?: string; q?: string; limit?: number; offset?: number } = {}): Promise<MediaRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const { where, params } = mediaFilter(opts);
  const rows = await query<MediaRow>(
    `SELECT * FROM \`media\` ${where} ORDER BY \`id\` DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return rows.map((r) => ({
    ...r,
    altText: parseJson<Record<string, string>>(r.altText, {}),
    focalPoint: r.focalPoint ? parseJson<{ x: number; y: number }>(r.focalPoint, { x: 0.5, y: 0.5 }) : null,
  }));
}

export async function countMedia(opts: { mimeType?: string; q?: string } = {}): Promise<number> {
  const { where, params } = mediaFilter(opts);
  const row = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM \`media\` ${where}`, params);
  return Number(row?.n ?? 0);
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

// Keys of replaced files carry this marker so the byte route knows the URL
// no longer maps to one immutable file and must be revalidated by caches.
const REPLACED_MARK = 'r-';

export function isReplacedKey(storageKey: string): boolean {
  return (storageKey.split('/').pop() ?? '').startsWith(REPLACED_MARK);
}

/**
 * Swap the bytes behind an existing media row. The id — and with it every
 * link and reference — stays the same; alt text and focal point are kept.
 */
export async function replaceMediaFile(
  id: number,
  input: { filename: string; mimeType: string; bytes: Uint8Array },
): Promise<MediaRow | null> {
  const existing = await getMedia(id);
  if (!existing) return null;
  const ym = new Date().toISOString().slice(0, 7).replace('-', '');
  const key = `${ym}/${REPLACED_MARK}${randomHex(8)}-${sanitize(input.filename)}`;
  await mediaStorage().put(key, input.bytes, input.mimeType);
  const { w, h } = sniffDimensions(input.bytes, input.mimeType);
  await execute(
    'UPDATE `media` SET `filename`=?, `mimeType`=?, `sizeBytes`=?, `storageKey`=?, `width`=?, `height`=? WHERE `id`=?',
    [input.filename, input.mimeType, input.bytes.length, key, w, h, id],
  );
  // The old bytes are unreachable now; a failed cleanup must not undo the swap.
  await mediaStorage().delete(existing.storageKey).catch(() => undefined);
  return getMedia(id);
}
