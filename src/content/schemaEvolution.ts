// Lazy schema migration. When a content row's schemaRevision lags the
// content type's currentRevision, we apply each interim revision's
// `changes` JSON to the in-memory fields object so callers see a fully
// up-to-date view. The row itself is rewritten only on next save.

import { query } from '../db/client.js';

export interface FieldChange {
  added:   Array<{ name: string; default?: unknown }>;
  removed: Array<{ name: string }>;
  renamed: Array<{ from: string; to: string }>;
  retyped: Array<{ name: string; from: string; to: string; transform?: string }>;
}

interface RevisionRow {
  revision: number;
  changes: FieldChange | string;
}

const revisionCache = new Map<string, FieldChange[]>(); // key: typeId:fromRev:toRev

function parseChanges(v: FieldChange | string): FieldChange {
  if (typeof v === 'object' && v !== null) return v;
  try {
    return JSON.parse(v) as FieldChange;
  } catch {
    return { added: [], removed: [], renamed: [], retyped: [] };
  }
}

async function loadChanges(typeId: number, fromRev: number, toRev: number): Promise<FieldChange[]> {
  const key = `${typeId}:${fromRev}:${toRev}`;
  const cached = revisionCache.get(key);
  if (cached) return cached;

  const rows = await query<RevisionRow>(
    `SELECT \`revision\`, \`changes\` FROM \`contentTypeRevisions\`
      WHERE \`typeId\` = ? AND \`revision\` > ? AND \`revision\` <= ?
      ORDER BY \`revision\` ASC`,
    [typeId, fromRev, toRev],
  );
  const list = rows.map((r) => parseChanges(r.changes));
  revisionCache.set(key, list);
  return list;
}

/**
 * Apply schema migrations forward from `fromRev` to `toRev` against a
 * fields object. Returns a new object — does NOT mutate the input.
 */
export async function migrateFields(
  fields: Record<string, unknown>,
  typeId: number,
  fromRev: number,
  toRev: number,
): Promise<Record<string, unknown>> {
  if (fromRev >= toRev) return fields;
  const out: Record<string, unknown> = { ...fields };
  const changes = await loadChanges(typeId, fromRev, toRev);
  for (const ch of changes) {
    for (const a of ch.added) {
      if (!(a.name in out)) out[a.name] = a.default ?? null;
    }
    for (const r of ch.renamed) {
      if (r.from in out) {
        out[r.to] = out[r.from];
        delete out[r.from];
      }
    }
    for (const rm of ch.removed) {
      if (rm.name in out) {
        const legacy = (out._legacy as Record<string, unknown> | undefined) ?? {};
        legacy[rm.name] = out[rm.name];
        out._legacy = legacy;
        delete out[rm.name];
      }
    }
    for (const t of ch.retyped) {
      if (t.name in out) {
        out[t.name] = applyTransform(t.transform, out[t.name]);
      }
    }
  }
  return out;
}

function applyTransform(name: string | undefined, value: unknown): unknown {
  if (!name) return value;
  switch (name) {
    case 'parseInt':   return typeof value === 'string' ? parseInt(value, 10) : value;
    case 'parseFloat': return typeof value === 'string' ? parseFloat(value)   : value;
    case 'toString':   return value === null || value === undefined ? null : String(value);
    case 'toBoolean':  return Boolean(value);
    case 'toArray':    return Array.isArray(value) ? value : value !== null && value !== undefined ? [value] : [];
    default:           return value;
  }
}

/** Cache-buster — call after a contentTypes row is updated. */
export function clearRevisionCache(typeId?: number): void {
  if (typeId === undefined) {
    revisionCache.clear();
    return;
  }
  for (const k of revisionCache.keys()) {
    if (k.startsWith(`${typeId}:`)) revisionCache.delete(k);
  }
}
