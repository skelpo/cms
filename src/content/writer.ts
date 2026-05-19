// Content write operations. Validation, revision tracking, cache
// invalidation hooks (callers wire the actual invalidate call).

import { execute, queryOne } from '../db/client.js';
import { getTypeBySlug, type FieldDef } from './types.js';
import type { ContentStatus, ContentDbRow } from './content.js';

export interface CreateContentInput {
  type: string;
  slug: string;
  locale: string;
  title: string;
  fields?: Record<string, unknown>;
  seo?: Record<string, unknown>;
  ai?: Record<string, unknown>;
  status?: ContentStatus;
  authorId: number;
  translationOf?: number | null;   // if set, joins existing translation group
  publishedAt?: string | null;
  scheduledAt?: string | null;
}

export interface UpdateContentInput {
  title?: string;
  slug?: string;
  fields?: Record<string, unknown>;
  seo?: Record<string, unknown>;
  ai?: Record<string, unknown>;
  status?: ContentStatus;
  publishedAt?: string | null;
  scheduledAt?: string | null;
}

export interface ValidationError {
  field: string;
  constraint: string;
  message: string;
}

// ────────────────────────────────────────────────────────────────────────
// Slug
// ────────────────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isValidSlug(s: string): boolean {
  return s.length > 0 && s.length <= 75 && SLUG_RE.test(s);
}

// ────────────────────────────────────────────────────────────────────────
// Field validation against the type's schema
// ────────────────────────────────────────────────────────────────────────

function validateFields(fields: Record<string, unknown>, defs: FieldDef[]): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const def of defs) {
    const v = fields[def.name];
    const present = v !== undefined && v !== null && v !== '';
    if (def.required && !present) {
      errors.push({
        field: def.name,
        constraint: 'required',
        message: `Field '${def.name}' is required`,
      });
      continue;
    }
    if (!present) continue;
    if (def.validation) {
      if (def.type === 'text' || def.type === 'textarea' || def.type === 'email' || def.type === 'url') {
        const s = String(v);
        const min = def.validation.minLength as number | undefined;
        const max = def.validation.maxLength as number | undefined;
        if (typeof min === 'number' && s.length < min) {
          errors.push({ field: def.name, constraint: 'minLength', message: `Field '${def.name}' must be at least ${min} characters` });
        }
        if (typeof max === 'number' && s.length > max) {
          errors.push({ field: def.name, constraint: 'maxLength', message: `Field '${def.name}' must be at most ${max} characters` });
        }
      }
      if (def.type === 'number') {
        const n = Number(v);
        const min = def.validation.min as number | undefined;
        const max = def.validation.max as number | undefined;
        if (typeof min === 'number' && n < min) {
          errors.push({ field: def.name, constraint: 'min', message: `Field '${def.name}' must be ≥ ${min}` });
        }
        if (typeof max === 'number' && n > max) {
          errors.push({ field: def.name, constraint: 'max', message: `Field '${def.name}' must be ≤ ${max}` });
        }
      }
      if (def.type === 'select' || def.type === 'multiselect') {
        const opts = (def.validation.options as string[] | undefined) ?? [];
        if (opts.length > 0) {
          const vals = Array.isArray(v) ? v : [v];
          for (const x of vals) {
            if (!opts.includes(String(x))) {
              errors.push({
                field: def.name,
                constraint: 'options',
                message: `Field '${def.name}' value '${x}' not in allowed options`,
              });
            }
          }
        }
      }
    }
  }
  return errors;
}

// ────────────────────────────────────────────────────────────────────────
// Publish-time SEO + accessibility checks
// ────────────────────────────────────────────────────────────────────────

export function validateSeoForPublish(seo: Record<string, unknown>, title: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const desc = String(seo.metaDescription ?? '').trim();
  if (desc.length === 0) {
    errors.push({ field: 'seo.metaDescription', constraint: 'required', message: 'metaDescription required to publish' });
  } else if (desc.length < 70 || desc.length > 160) {
    errors.push({ field: 'seo.metaDescription', constraint: 'length', message: 'metaDescription must be 70-160 characters' });
  }
  if (title.length > 70) {
    errors.push({ field: 'title', constraint: 'maxLength', message: 'title should be 70 chars or fewer' });
  }
  return errors;
}

// ────────────────────────────────────────────────────────────────────────
// Create / update
// ────────────────────────────────────────────────────────────────────────

export async function createContent(input: CreateContentInput): Promise<{
  ok: true; id: number;
} | {
  ok: false; errors: ValidationError[];
}> {
  const type = await getTypeBySlug(input.type);
  if (!type) return { ok: false, errors: [{ field: 'type', constraint: 'unknown', message: `Unknown type: ${input.type}` }] };

  if (!isValidSlug(input.slug)) {
    return { ok: false, errors: [{ field: 'slug', constraint: 'format', message: 'slug must be URL-safe, 1-75 chars, lowercase' }] };
  }

  // Uniqueness — collisions surface as 409 at the route layer.
  const dup = await queryOne<{ id: number }>(
    'SELECT `id` FROM `content` WHERE `typeSlug` = ? AND `slug` = ? AND `locale` = ?',
    [input.type, input.slug, input.locale],
  );
  if (dup) return { ok: false, errors: [{ field: 'slug', constraint: 'unique', message: 'slug already exists for this type and locale' }] };

  const fields = input.fields ?? {};
  // For drafts, skip required-field validation so authors can save partial work.
  // The publish endpoint runs the full validation.
  if (input.status === 'published') {
    const fieldErrors = validateFields(fields, type.fieldsSchema.fields);
    if (fieldErrors.length > 0) return { ok: false, errors: fieldErrors };
    const seoErrors = validateSeoForPublish(input.seo ?? {}, input.title);
    if (seoErrors.length > 0) return { ok: false, errors: seoErrors };
  }

  // Translation group: if linking to an existing translation, reuse its group id.
  let translationGroupId = 0;
  if (input.translationOf) {
    const sib = await queryOne<{ translationGroupId: number }>(
      'SELECT `translationGroupId` FROM `content` WHERE `id` = ?',
      [input.translationOf],
    );
    if (sib) translationGroupId = sib.translationGroupId;
  }

  const r = await execute(
    `INSERT INTO \`content\`
       (\`typeId\`, \`typeSlug\`, \`slug\`, \`locale\`, \`translationGroupId\`,
        \`status\`, \`title\`, \`fields\`, \`seo\`, \`ai\`, \`authorId\`,
        \`publishedAt\`, \`scheduledAt\`, \`revision\`, \`schemaRevision\`)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      type.id, type.slug, input.slug, input.locale,
      0, // placeholder; updated below to equal id if it's the canonical row
      input.status ?? 'draft',
      input.title,
      JSON.stringify(fields),
      JSON.stringify(input.seo ?? {}),
      JSON.stringify(input.ai ?? {}),
      input.authorId,
      input.publishedAt ?? (input.status === 'published' ? new Date().toISOString().slice(0,19).replace('T',' ') : null),
      input.scheduledAt ?? null,
      type.currentRevision,
    ],
  );
  const id = Number(r.insertId);
  // If no explicit translation group, use this row as its own canonical.
  if (translationGroupId === 0) {
    await execute('UPDATE `content` SET `translationGroupId` = ? WHERE `id` = ?', [id, id]);
  } else {
    await execute('UPDATE `content` SET `translationGroupId` = ? WHERE `id` = ?', [translationGroupId, id]);
  }

  // Snapshot revision 1.
  await saveRevision(id, 1, input.authorId, 'create');

  return { ok: true, id };
}

export async function updateContent(
  id: number,
  patch: UpdateContentInput,
  authorId: number,
): Promise<{
  ok: true; row: ContentDbRow;
} | {
  ok: false; errors: ValidationError[]; status?: number;
}> {
  const existing = await queryOne<ContentDbRow>('SELECT * FROM `content` WHERE `id` = ?', [id]);
  if (!existing) return { ok: false, errors: [{ field: '', constraint: 'notFound', message: 'Content not found' }], status: 404 };

  if (patch.slug !== undefined && !isValidSlug(patch.slug)) {
    return { ok: false, errors: [{ field: 'slug', constraint: 'format', message: 'slug must be URL-safe' }] };
  }
  if (patch.slug && patch.slug !== existing.slug) {
    const dup = await queryOne<{ id: number }>(
      'SELECT `id` FROM `content` WHERE `typeSlug` = ? AND `slug` = ? AND `locale` = ? AND `id` <> ?',
      [existing.typeSlug, patch.slug, existing.locale, id],
    );
    if (dup) return { ok: false, errors: [{ field: 'slug', constraint: 'unique', message: 'slug already taken' }], status: 409 };
  }

  // Build SET clause incrementally.
  const sets: string[] = ['`revision` = `revision` + 1'];
  const params: unknown[] = [];
  if (patch.title !== undefined) { sets.push('`title` = ?'); params.push(patch.title); }
  if (patch.slug  !== undefined) { sets.push('`slug` = ?');  params.push(patch.slug); }
  if (patch.fields !== undefined) { sets.push('`fields` = ?'); params.push(JSON.stringify(patch.fields)); }
  if (patch.seo    !== undefined) { sets.push('`seo` = ?');    params.push(JSON.stringify(patch.seo)); }
  if (patch.ai     !== undefined) { sets.push('`ai` = ?');     params.push(JSON.stringify(patch.ai)); }
  if (patch.status !== undefined) { sets.push('`status` = ?'); params.push(patch.status); }
  if (patch.publishedAt !== undefined) { sets.push('`publishedAt` = ?'); params.push(patch.publishedAt); }
  if (patch.scheduledAt !== undefined) { sets.push('`scheduledAt` = ?'); params.push(patch.scheduledAt); }

  params.push(id);
  await execute(`UPDATE \`content\` SET ${sets.join(', ')} WHERE \`id\` = ?`, params);

  const updated = await queryOne<ContentDbRow>('SELECT * FROM `content` WHERE `id` = ?', [id]);
  if (!updated) return { ok: false, errors: [{ field: '', constraint: 'gone', message: 'Row vanished' }], status: 500 };
  await saveRevision(id, updated.revision, authorId, 'update');
  return { ok: true, row: updated };
}

export async function deleteContent(id: number, hard = false): Promise<boolean> {
  if (hard) {
    const r = await execute('DELETE FROM `content` WHERE `id` = ?', [id]);
    return r.affectedRows > 0;
  }
  const r = await execute("UPDATE `content` SET `status` = 'archived' WHERE `id` = ?", [id]);
  return r.affectedRows > 0;
}

// ────────────────────────────────────────────────────────────────────────
// Publish
// ────────────────────────────────────────────────────────────────────────

export async function publishContent(id: number, authorId: number): Promise<{
  ok: true; row: ContentDbRow;
} | {
  ok: false; errors: ValidationError[];
}> {
  const existing = await queryOne<ContentDbRow>('SELECT * FROM `content` WHERE `id` = ?', [id]);
  if (!existing) return { ok: false, errors: [{ field: '', constraint: 'notFound', message: 'Content not found' }] };
  const type = await getTypeBySlug(existing.typeSlug);
  if (!type) return { ok: false, errors: [{ field: 'type', constraint: 'missing', message: 'Type missing' }] };

  const fields = typeof existing.fields === 'string' ? JSON.parse(existing.fields) : existing.fields;
  const seo    = typeof existing.seo === 'string'    ? JSON.parse(existing.seo)    : existing.seo;
  const errors = [
    ...validateFields(fields as Record<string, unknown>, type.fieldsSchema.fields),
    ...validateSeoForPublish(seo as Record<string, unknown>, existing.title),
  ];
  if (errors.length > 0) return { ok: false, errors };

  await execute(
    "UPDATE `content` SET `status` = 'published', `publishedAt` = COALESCE(`publishedAt`, NOW()), `revision` = `revision` + 1 WHERE `id` = ?",
    [id],
  );
  const updated = await queryOne<ContentDbRow>('SELECT * FROM `content` WHERE `id` = ?', [id]);
  if (!updated) return { ok: false, errors: [{ field: '', constraint: 'gone', message: 'Row vanished' }] };
  await saveRevision(id, updated.revision, authorId, 'publish');
  return { ok: true, row: updated };
}

export async function unpublishContent(id: number, authorId: number): Promise<boolean> {
  const r = await execute(
    "UPDATE `content` SET `status` = 'draft', `revision` = `revision` + 1 WHERE `id` = ? AND `status` = 'published'",
    [id],
  );
  if (r.affectedRows > 0) {
    const updated = await queryOne<ContentDbRow>('SELECT * FROM `content` WHERE `id` = ?', [id]);
    if (updated) await saveRevision(id, updated.revision, authorId, 'unpublish');
  }
  return r.affectedRows > 0;
}

// ────────────────────────────────────────────────────────────────────────
// Revisions
// ────────────────────────────────────────────────────────────────────────

async function saveRevision(
  contentId: number,
  revision: number,
  authorId: number,
  reason: string,
): Promise<void> {
  const row = await queryOne<ContentDbRow>('SELECT * FROM `content` WHERE `id` = ?', [contentId]);
  if (!row) return;
  await execute(
    `INSERT IGNORE INTO \`contentRevisions\`
       (\`contentId\`, \`revision\`, \`snapshot\`, \`authorId\`, \`reason\`)
     VALUES (?, ?, ?, ?, ?)`,
    [contentId, revision, JSON.stringify(row), authorId, reason],
  );
}
