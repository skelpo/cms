// Content-type create/update with schema-revision tracking. A schema
// change computes the diff vs the current schema, writes a new
// contentTypeRevisions row, bumps currentRevision, and clears caches so
// the next content read lazily migrates (see schemaEvolution.ts).

import { execute, queryOne } from '../db/client.js';
import { invalidateTypeRegistry, type FieldsSchema, type FieldDef } from './types.js';
import { clearRevisionCache } from './schemaEvolution.js';

export interface SchemaChanges {
  added: Array<{ name: string; default?: unknown }>;
  removed: Array<{ name: string }>;
  renamed: Array<{ from: string; to: string }>;
  retyped: Array<{ name: string; from: string; to: string; transform?: string }>;
}

const EMPTY_CHANGES: SchemaChanges = { added: [], removed: [], renamed: [], retyped: [] };

/** Diff two field-schemas into a SchemaChanges record. */
export function diffSchema(prev: FieldsSchema, next: FieldsSchema): SchemaChanges {
  const prevByName = new Map(prev.fields.map((f) => [f.name, f]));
  const nextByName = new Map(next.fields.map((f) => [f.name, f]));
  const changes: SchemaChanges = { added: [], removed: [], renamed: [], retyped: [] };

  for (const [name, def] of nextByName) {
    if (!prevByName.has(name)) {
      const entry: { name: string; default?: unknown } = { name };
      if ('default' in (def.admin ?? {})) entry.default = (def.admin as { default?: unknown }).default;
      changes.added.push(entry);
    } else {
      const pf = prevByName.get(name)!;
      if (pf.type !== def.type) {
        changes.retyped.push({ name, from: pf.type, to: def.type });
      }
    }
  }
  for (const [name] of prevByName) {
    if (!nextByName.has(name)) changes.removed.push({ name });
  }
  return changes;
}

export interface CreateTypeInput {
  slug: string;
  labelSingular: string;
  labelPlural: string;
  isRoutable?: boolean;
  urlPattern?: string | null;
  icon?: string;
  fieldsSchema: FieldsSchema;
}

const TYPE_SLUG_RE = /^[a-z][a-z0-9]*$/;

export async function createType(
  input: CreateTypeInput,
  authorId: number,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  if (!TYPE_SLUG_RE.test(input.slug)) {
    return { ok: false, error: 'slug must be lowercase alphanumeric, starting with a letter' };
  }
  const dup = await queryOne<{ id: number }>(
    'SELECT `id` FROM `contentTypes` WHERE `slug` = ?',
    [input.slug],
  );
  if (dup) return { ok: false, error: 'slug already exists' };

  const r = await execute(
    `INSERT INTO \`contentTypes\`
       (\`slug\`, \`labelSingular\`, \`labelPlural\`, \`isBuiltin\`, \`isRoutable\`,
        \`urlPattern\`, \`fieldsSchema\`, \`icon\`, \`currentRevision\`)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1)`,
    [
      input.slug,
      input.labelSingular,
      input.labelPlural,
      input.isRoutable === false ? 0 : 1,
      input.urlPattern ?? null,
      JSON.stringify(input.fieldsSchema),
      input.icon ?? null,
    ],
  );
  const id = Number(r.insertId);
  await execute(
    `INSERT INTO \`contentTypeRevisions\`
       (\`typeId\`, \`revision\`, \`fieldsSchema\`, \`changes\`, \`authorId\`, \`note\`)
     VALUES (?, 1, ?, ?, ?, 'initial')`,
    [id, JSON.stringify(input.fieldsSchema), JSON.stringify(EMPTY_CHANGES), authorId],
  );
  invalidateTypeRegistry();
  return { ok: true, id };
}

export interface UpdateTypeInput {
  labelSingular?: string;
  labelPlural?: string;
  isRoutable?: boolean;
  urlPattern?: string | null;
  icon?: string;
  fieldsSchema?: FieldsSchema;
  changes?: SchemaChanges;     // explicit migration spec; computed if omitted
}

export async function updateType(
  slug: string,
  patch: UpdateTypeInput,
  authorId: number,
  opts: { dryRun?: boolean } = {},
): Promise<
  | { ok: true; newRevision?: number; affectedRows?: number }
  | { ok: false; error: string }
> {
  const row = await queryOne<{
    id: number;
    currentRevision: number;
    fieldsSchema: string | FieldsSchema;
  }>('SELECT `id`, `currentRevision`, `fieldsSchema` FROM `contentTypes` WHERE `slug` = ?', [slug]);
  if (!row) return { ok: false, error: 'type not found' };

  const prevSchema: FieldsSchema =
    typeof row.fieldsSchema === 'string' ? JSON.parse(row.fieldsSchema) : row.fieldsSchema;

  // Metadata-only patch (no schema change).
  if (!patch.fieldsSchema) {
    if (opts.dryRun) return { ok: true };
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.labelSingular !== undefined) { sets.push('`labelSingular` = ?'); params.push(patch.labelSingular); }
    if (patch.labelPlural   !== undefined) { sets.push('`labelPlural` = ?');   params.push(patch.labelPlural); }
    if (patch.isRoutable    !== undefined) { sets.push('`isRoutable` = ?');    params.push(patch.isRoutable ? 1 : 0); }
    if (patch.urlPattern    !== undefined) { sets.push('`urlPattern` = ?');    params.push(patch.urlPattern); }
    if (patch.icon          !== undefined) { sets.push('`icon` = ?');          params.push(patch.icon); }
    if (sets.length > 0) {
      params.push(slug);
      await execute(`UPDATE \`contentTypes\` SET ${sets.join(', ')} WHERE \`slug\` = ?`, params);
      invalidateTypeRegistry();
    }
    return { ok: true };
  }

  // Schema change → new revision.
  const changes = patch.changes ?? diffSchema(prevSchema, patch.fieldsSchema);
  const affected = await queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM `content` WHERE `typeSlug` = ?',
    [slug],
  );
  const affectedRows = affected?.n ?? 0;

  if (opts.dryRun) {
    return { ok: true, newRevision: row.currentRevision + 1, affectedRows };
  }

  const newRevision = row.currentRevision + 1;
  await execute(
    `INSERT INTO \`contentTypeRevisions\`
       (\`typeId\`, \`revision\`, \`fieldsSchema\`, \`changes\`, \`authorId\`)
     VALUES (?, ?, ?, ?, ?)`,
    [row.id, newRevision, JSON.stringify(patch.fieldsSchema), JSON.stringify(changes), authorId],
  );

  const sets = ['`fieldsSchema` = ?', '`currentRevision` = ?'];
  const params: unknown[] = [JSON.stringify(patch.fieldsSchema), newRevision];
  if (patch.labelSingular !== undefined) { sets.push('`labelSingular` = ?'); params.push(patch.labelSingular); }
  if (patch.labelPlural   !== undefined) { sets.push('`labelPlural` = ?');   params.push(patch.labelPlural); }
  if (patch.isRoutable    !== undefined) { sets.push('`isRoutable` = ?');    params.push(patch.isRoutable ? 1 : 0); }
  if (patch.urlPattern    !== undefined) { sets.push('`urlPattern` = ?');    params.push(patch.urlPattern); }
  if (patch.icon          !== undefined) { sets.push('`icon` = ?');          params.push(patch.icon); }
  params.push(slug);
  await execute(`UPDATE \`contentTypes\` SET ${sets.join(', ')} WHERE \`slug\` = ?`, params);

  invalidateTypeRegistry();
  clearRevisionCache(row.id);
  return { ok: true, newRevision, affectedRows };
}

export async function deleteType(
  slug: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const row = await queryOne<{ id: number; isBuiltin: number }>(
    'SELECT `id`, `isBuiltin` FROM `contentTypes` WHERE `slug` = ?',
    [slug],
  );
  if (!row) return { ok: false, error: 'type not found', status: 404 };
  if (row.isBuiltin) return { ok: false, error: 'cannot delete built-in type', status: 409 };

  const cnt = await queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM `content` WHERE `typeSlug` = ?',
    [slug],
  );
  if ((cnt?.n ?? 0) > 0 && !opts.force) {
    return {
      ok: false,
      error: `${cnt?.n} content rows exist; pass ?force=true&archiveContent=true to proceed`,
      status: 409,
    };
  }
  if ((cnt?.n ?? 0) > 0) {
    await execute("UPDATE `content` SET `status` = 'archived' WHERE `typeSlug` = ?", [slug]);
  }
  await execute('DELETE FROM `contentTypes` WHERE `slug` = ?', [slug]);
  invalidateTypeRegistry();
  return { ok: true };
}

export function validateFieldsSchema(schema: unknown): { ok: true } | { ok: false; error: string } {
  if (!schema || typeof schema !== 'object') return { ok: false, error: 'fieldsSchema must be an object' };
  const s = schema as Partial<FieldsSchema>;
  if (typeof s.version !== 'number') return { ok: false, error: 'fieldsSchema.version (number) required' };
  if (!Array.isArray(s.fields)) return { ok: false, error: 'fieldsSchema.fields (array) required' };
  const allowed = new Set([
    'text','textarea','richtext','number','boolean','date','datetime','email','url',
    'color','select','multiselect','image','gallery','file','relation','repeater','json',
  ]);
  const seen = new Set<string>();
  for (const f of s.fields as FieldDef[]) {
    if (!f.name || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f.name)) {
      return { ok: false, error: `invalid field name: ${JSON.stringify(f.name)}` };
    }
    if (seen.has(f.name)) return { ok: false, error: `duplicate field name: ${f.name}` };
    seen.add(f.name);
    if (!allowed.has(f.type)) return { ok: false, error: `invalid field type '${f.type}' for ${f.name}` };
  }
  return { ok: true };
}
