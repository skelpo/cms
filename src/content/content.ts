// Content read service. Database access + lazy schema migration + URL
// computation + relation expansion.

import { query, queryOne } from '../db/client.js';
import { dateToIso } from '../db/datetime.js';
import { getTypeBySlug, getTypeById, type ContentTypeRow } from './types.js';
import { migrateFields } from './schemaEvolution.js';

export type ContentStatus = 'draft' | 'review' | 'published' | 'archived';

export interface ContentDbRow {
  id: number;
  typeId: number;
  typeSlug: string;
  slug: string;
  locale: string;
  translationGroupId: number;
  status: ContentStatus;
  title: string;
  fields: string | Record<string, unknown>;
  seo: string | Record<string, unknown>;
  ai: string | Record<string, unknown>;
  authorId: number | null;
  publishedAt: string | null;
  scheduledAt: string | null;
  revision: number;
  schemaRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContentPublic {
  id: number;
  type: string;
  slug: string;
  locale: string;
  translationGroupId: number;
  status: ContentStatus;
  title: string;
  fields: Record<string, unknown>;
  seo: Record<string, unknown>;
  ai: Record<string, unknown>;
  authorId: number | null;
  publishedAt: string | null;
  scheduledAt: string | null;
  revision: number;
  schemaRevision: number;
  createdAt: string;
  updatedAt: string;
  url: string | null;
  relations?: Record<string, ContentPublic[]>;
}

function parseJson<T>(v: T | string, fallback: T): T {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

/**
 * Compute the public URL for a row using its content type's urlPattern.
 * Returns null for non-routable types or missing patterns.
 */
function computeUrl(row: ContentDbRow, type: ContentTypeRow, defaultLocale: string): string | null {
  if (!type.isRoutable || !type.urlPattern) return null;
  let path = type.urlPattern.replace(':slug', row.slug);
  // Other tokens not handled in v0.1; future: :year, :month, :id, custom segments.
  // Locale prefix: omit for the default locale (clean URLs).
  if (row.locale !== defaultLocale) {
    path = `/${row.locale}${path.startsWith('/') ? '' : '/'}${path}`;
  }
  // Collapse double slashes that can creep in.
  return path.replace(/\/{2,}/g, '/');
}

/**
 * Materialize a DB row into the API/SDK-facing ContentPublic shape.
 * Applies lazy schema migration. Optionally includes relations.
 */
export async function inflateContent(
  row: ContentDbRow,
  opts: { includeRelations?: boolean; defaultLocale: string } = { defaultLocale: 'en' },
): Promise<ContentPublic> {
  let fields = parseJson<Record<string, unknown>>(row.fields, {});
  const type = await getTypeById(row.typeId);
  if (type && row.schemaRevision < type.currentRevision) {
    fields = await migrateFields(fields, type.id, row.schemaRevision, type.currentRevision);
  }

  const publicRow: ContentPublic = {
    id:                 row.id,
    type:               row.typeSlug,
    slug:               row.slug,
    locale:             row.locale,
    translationGroupId: row.translationGroupId,
    status:             row.status,
    title:              row.title,
    fields,
    seo:                parseJson<Record<string, unknown>>(row.seo, {}),
    ai:                 parseJson<Record<string, unknown>>(row.ai,  {}),
    authorId:           row.authorId,
    publishedAt:        dateToIso(row.publishedAt),
    scheduledAt:        dateToIso(row.scheduledAt),
    revision:           row.revision,
    schemaRevision:     row.schemaRevision,
    createdAt:          dateToIso(row.createdAt) ?? '',
    updatedAt:          dateToIso(row.updatedAt) ?? '',
    url:                type ? computeUrl(row, type, opts.defaultLocale) : null,
  };

  if (opts.includeRelations) {
    publicRow.relations = await loadRelations(row.id, opts.defaultLocale);
  }

  return publicRow;
}

async function loadRelations(
  fromId: number,
  defaultLocale: string,
): Promise<Record<string, ContentPublic[]>> {
  const rows = await query<ContentDbRow & { fromField: string; relSortOrder: number }>(
    `SELECT c.*, cr.\`fromField\` AS \`fromField\`, cr.\`sortOrder\` AS \`relSortOrder\`
       FROM \`contentRelations\` cr
       JOIN \`content\` c ON c.\`id\` = cr.\`toId\`
      WHERE cr.\`fromId\` = ?
      ORDER BY cr.\`fromField\`, cr.\`sortOrder\``,
    [fromId],
  );
  const grouped: Record<string, ContentPublic[]> = {};
  for (const r of rows) {
    const field = r.fromField;
    if (!grouped[field]) grouped[field] = [];
    // Recurse without nested relations to avoid cycles in v0.1.
    grouped[field].push(await inflateContent(r, { includeRelations: false, defaultLocale }));
  }
  return grouped;
}

// ────────────────────────────────────────────────────────────────────────
// Lookups
// ────────────────────────────────────────────────────────────────────────

export async function findById(id: number, includeDrafts = false): Promise<ContentDbRow | null> {
  const statusClause = includeDrafts ? '' : "AND `status` = 'published'";
  return queryOne<ContentDbRow>(
    `SELECT * FROM \`content\` WHERE \`id\` = ? ${statusClause} LIMIT 1`,
    [id],
  );
}

export async function findBySlug(
  typeSlug: string,
  slug: string,
  locale: string,
  includeDrafts = false,
): Promise<ContentDbRow | null> {
  const statusClause = includeDrafts ? '' : "AND `status` = 'published'";
  return queryOne<ContentDbRow>(
    `SELECT * FROM \`content\`
      WHERE \`typeSlug\` = ? AND \`slug\` = ? AND \`locale\` = ? ${statusClause}
      LIMIT 1`,
    [typeSlug, slug, locale],
  );
}

/**
 * Resolve a public URL path to a content row. Walks all routable types,
 * matches `urlPattern` against the path, and returns the first hit.
 *
 * For v0.1 we support patterns of the form `/(:locale/)?[prefix/]:slug` —
 * a single :slug token at the end. Locale is detected from the leading
 * segment if it matches one of the configured locales.
 */
export async function findByPath(
  path: string,
  defaultLocale: string,
  configuredLocales: string[],
  includeDrafts = false,
): Promise<ContentDbRow | null> {
  let p = path;
  if (!p.startsWith('/')) p = '/' + p;

  // Detect locale prefix.
  let locale = defaultLocale;
  const leadMatch = p.match(/^\/([a-z]{2}(?:-[a-zA-Z0-9]+)?)(\/|$)/);
  if (leadMatch && configuredLocales.includes(leadMatch[1]!)) {
    locale = leadMatch[1]!;
    p = p.slice(leadMatch[0]!.length - (leadMatch[2] === '/' ? 1 : 0));
    if (!p.startsWith('/')) p = '/' + p;
  }

  // Look up the registry to consider every routable type.
  const { listTypes } = await import('./types.js');
  const types = await listTypes();
  for (const t of types) {
    if (!t.isRoutable || !t.urlPattern) continue;
    const pattern = t.urlPattern;
    // Convert pattern → regex with capture for :slug.
    const re = new RegExp('^' + pattern.replace(/:slug/g, '([^/]+)') + '$');
    const m = p.match(re);
    if (!m) continue;
    const slug = m[1];
    if (!slug) continue;
    const row = await findBySlug(t.slug, slug, locale, includeDrafts);
    if (row) return row;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// List
// ────────────────────────────────────────────────────────────────────────

export interface ListContentOptions {
  typeSlug: string;
  locale?: string;
  status?: ContentStatus | ContentStatus[];
  authorId?: number;
  slug?: string;
  publishedBefore?: string;
  publishedAfter?: string;
  sort?: string;     // 'publishedAt' | '-publishedAt' | etc
  limit?: number;
  cursor?: string;
  includeDrafts?: boolean;
}

export async function listContent(opts: ListContentOptions): Promise<{
  rows: ContentDbRow[];
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const where: string[] = ['`typeSlug` = ?'];
  const params: unknown[] = [opts.typeSlug];

  if (opts.locale) {
    where.push('`locale` = ?');
    params.push(opts.locale);
  }
  if (opts.status) {
    const list = Array.isArray(opts.status) ? opts.status : [opts.status];
    where.push(`\`status\` IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  } else if (!opts.includeDrafts) {
    where.push("`status` = 'published'");
  }
  if (opts.authorId !== undefined) {
    where.push('`authorId` = ?');
    params.push(opts.authorId);
  }
  if (opts.slug) {
    where.push('`slug` = ?');
    params.push(opts.slug);
  }
  if (opts.publishedBefore) {
    where.push('`publishedAt` < ?');
    params.push(opts.publishedBefore);
  }
  if (opts.publishedAfter) {
    where.push('`publishedAt` > ?');
    params.push(opts.publishedAfter);
  }

  // Cursor: opaque base64 of { id, publishedAt } for keyset pagination on the
  // default `-publishedAt` sort. NOTE: the keyset always orders by publishedAt
  // then id; a non-default `sort` still pages by this keyset (stable forward
  // paging, but not strictly ordered by the requested column).
  let cursorClause = '';
  if (opts.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8'));
      if (decoded && typeof decoded.id === 'number') {
        if (typeof decoded.publishedAt === 'string') {
          cursorClause = ' AND (`publishedAt` < ? OR (`publishedAt` = ? AND `id` < ?))';
          params.push(decoded.publishedAt, decoded.publishedAt, decoded.id);
        } else {
          // NULL publishedAt (e.g. draft listings): fall back to an id-only keyset.
          cursorClause = ' AND `id` < ?';
          params.push(decoded.id);
        }
      }
    } catch {
      // ignore bad cursors
    }
  }

  const orderBy = parseSort(opts.sort ?? '-publishedAt');

  const sql =
    `SELECT * FROM \`content\` WHERE ${where.join(' AND ')}${cursorClause}` +
    ` ORDER BY ${orderBy} LIMIT ?`;
  params.push(limit + 1);

  const rows = await query<ContentDbRow>(sql, params);
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1]!;
    // Serialize publishedAt as the DB datetime STRING. The @perryts/mysql driver
    // returns TIMESTAMP columns as MyDateTime objects with no toJSON, so
    // JSON.stringify(last.publishedAt) would emit an object; the decode-side
    // `typeof === 'string'` check would then always fail, drop the cursor
    // clause, and page 1 would repeat forever (infinite crawl loop).
    nextCursor = Buffer.from(
      JSON.stringify({ publishedAt: toDbDatetimeString(last.publishedAt), id: last.id }),
      'utf8',
    ).toString('base64url');
  }
  return { rows: rows.slice(0, limit), nextCursor };
}

/** Extract the MySQL `YYYY-MM-DD HH:MM:SS` string from a driver datetime value
 *  (MyDateTime object or already-a-string), or null. Used for keyset cursors,
 *  which compare against a DATETIME column and so must not carry ISO `T`/`Z`. */
function toDbDatetimeString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof (v as { raw?: unknown }).raw === 'string') {
    return (v as { raw: string }).raw;
  }
  return null;
}

function parseSort(sort: string): string {
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  const allowed = new Set(['publishedAt', 'createdAt', 'title', 'updatedAt']);
  if (!allowed.has(field)) return '`publishedAt` DESC, `id` DESC';
  return `\`${field}\` ${desc ? 'DESC' : 'ASC'}, \`id\` ${desc ? 'DESC' : 'ASC'}`;
}

// Type re-export
export { getTypeBySlug, getTypeById };
