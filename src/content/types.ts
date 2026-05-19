// Content type registry. Loaded into memory at boot and after any
// schema change; small enough that an in-memory copy is the right call.

import { query, queryOne } from '../db/client.js';

export interface ContentTypeRow {
  id: number;
  slug: string;
  labelSingular: string;
  labelPlural: string;
  isBuiltin: number;
  isRoutable: number;
  urlPattern: string | null;
  fieldsSchema: FieldsSchema;
  currentRevision: number;
  listQuery: unknown;
  icon: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface FieldsSchema {
  version: number;
  fields: FieldDef[];
}

export interface FieldDef {
  name: string;
  type: string;
  label?: string;
  translatable?: boolean;
  required?: boolean;
  validation?: Record<string, unknown>;
  admin?: Record<string, unknown>;
  relation?: { toType: string; many: boolean; max?: number };
  repeater?: { fields: FieldDef[]; min?: number; max?: number };
  richtext?: { allowCodeBlocks?: boolean; allowEmbeds?: boolean; allowImages?: boolean };
}

interface ContentTypeDbRow extends Omit<ContentTypeRow, 'fieldsSchema' | 'listQuery'> {
  fieldsSchema: string | FieldsSchema;
  listQuery: string | null;
}

function parseJson<T>(v: T | string, fallback: T): T {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

function inflate(row: ContentTypeDbRow): ContentTypeRow {
  return {
    ...row,
    fieldsSchema: parseJson<FieldsSchema>(row.fieldsSchema, { version: 1, fields: [] }),
    listQuery:    row.listQuery ? parseJson<unknown>(row.listQuery, null) : null,
  };
}

// In-memory registry, lazily refreshed.
let cache: { bySlug: Map<string, ContentTypeRow>; byId: Map<number, ContentTypeRow> } | null = null;

export async function loadTypeRegistry(force = false): Promise<void> {
  if (cache && !force) return;
  const rows = await query<ContentTypeDbRow>('SELECT * FROM `contentTypes` ORDER BY `sortOrder`, `id`');
  const inflated = rows.map(inflate);
  cache = {
    bySlug: new Map(inflated.map((r) => [r.slug, r])),
    byId:   new Map(inflated.map((r) => [r.id,   r])),
  };
}

export async function getTypeBySlug(slug: string): Promise<ContentTypeRow | null> {
  await loadTypeRegistry();
  return cache!.bySlug.get(slug) ?? null;
}

export async function getTypeById(id: number): Promise<ContentTypeRow | null> {
  await loadTypeRegistry();
  return cache!.byId.get(id) ?? null;
}

export async function listTypes(): Promise<ContentTypeRow[]> {
  await loadTypeRegistry();
  return [...cache!.byId.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

/** Reload after schema edits. */
export function invalidateTypeRegistry(): void {
  cache = null;
}

/** Fast existence check; falls through to DB if registry not loaded. */
export async function typeSlugExists(slug: string): Promise<boolean> {
  if (cache) return cache.bySlug.has(slug);
  const row = await queryOne<{ id: number }>('SELECT `id` FROM `contentTypes` WHERE `slug` = ?', [slug]);
  return !!row;
}
