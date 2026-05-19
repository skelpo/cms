// Content create/edit form. Renders an input per field from the content
// type's fieldsSchema, plus title/slug/status/SEO. Submits to admin POST
// handlers that call the writer functions directly (already inside an
// authenticated session — no API round-trip).
//
// v0.1 richtext = HTML textarea (renderTipTap passes HTML strings through).
// A TipTap enhancement layer is a follow-up; the data contract is stable.

import type { FC } from 'hono/jsx';
import type { FieldDef, ContentTypeRow } from '../content/types.js';
import type { ContentDbRow } from '../content/content.js';
import { AdminPage, StatusBadge } from './layout.js';

function val(fields: Record<string, unknown>, name: string): string {
  const v = fields[name];
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

const Field: FC<{ def: FieldDef; value: string }> = ({ def, value }) => {
  const name = `f_${def.name}`;
  const label = (
    <label>
      {def.label ?? def.name}
      {def.required ? <span style="color:var(--err)"> *</span> : null}
      {def.translatable ? <span class="muted" style="font-weight:400"> · i18n</span> : null}
    </label>
  );
  switch (def.type) {
    case 'textarea':
    case 'richtext':
    case 'json':
    case 'repeater':
    case 'gallery':
      return (
        <div>
          {label}
          <textarea
            name={name}
            rows={def.type === 'richtext' ? 14 : 6}
            placeholder={
              def.type === 'richtext'
                ? 'HTML or TipTap JSON'
                : def.type === 'repeater' || def.type === 'json' || def.type === 'gallery'
                  ? 'JSON'
                  : ''
            }
          >
            {value}
          </textarea>
        </div>
      );
    case 'boolean':
      return (
        <div>
          {label}
          <select name={name}>
            <option value="false" selected={value !== 'true'}>
              No
            </option>
            <option value="true" selected={value === 'true'}>
              Yes
            </option>
          </select>
        </div>
      );
    case 'select':
    case 'multiselect': {
      const opts = (def.validation?.options as string[] | undefined) ?? [];
      return (
        <div>
          {label}
          <select name={name} multiple={def.type === 'multiselect'}>
            {def.type === 'select' ? <option value="">—</option> : null}
            {opts.map((o) => (
              <option value={o} selected={value.includes(o)}>
                {o}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case 'number':
      return (
        <div>
          {label}
          <input type="number" name={name} value={value} />
        </div>
      );
    case 'boolean' as never:
      return null;
    case 'date':
      return (
        <div>
          {label}
          <input type="date" name={name} value={value} />
        </div>
      );
    case 'datetime':
      return (
        <div>
          {label}
          <input type="datetime-local" name={name} value={value} />
        </div>
      );
    case 'image':
    case 'file':
      return (
        <div>
          {label}
          <input
            type="text"
            name={name}
            value={value}
            placeholder="media id (media picker is a follow-up)"
          />
        </div>
      );
    case 'relation':
      return (
        <div>
          {label}
          <input
            type="text"
            name={name}
            value={value}
            placeholder="comma-separated content ids"
          />
        </div>
      );
    default:
      return (
        <div>
          {label}
          <input type="text" name={name} value={value} />
        </div>
      );
  }
};

export const ContentForm: FC<{
  type: ContentTypeRow;
  row?: ContentDbRow | null;
  fields: Record<string, unknown>;
  seo: Record<string, unknown>;
  user: { displayName: string };
  flash?: { ok?: string; err?: string };
}> = ({ type, row, fields, seo, user, flash }) => {
  const isNew = !row;
  const action = isNew
    ? `/admin/content/${type.slug}`
    : `/admin/content/${type.slug}/${row!.id}`;
  return (
    <AdminPage
      title={isNew ? `New ${type.labelSingular}` : row!.title}
      active={type.slug}
      user={user}
    >
      <div class="top">
        <h1>
          {isNew ? `New ${type.labelSingular}` : `Edit: ${row!.title}`}{' '}
          {row ? <StatusBadge status={row.status} /> : null}
        </h1>
        <a class="btn sec" href={`/admin/content/${type.slug}`}>
          ← Back
        </a>
      </div>
      {flash?.ok ? <div class="ok">{flash.ok}</div> : null}
      {flash?.err ? <div class="err">{flash.err}</div> : null}
      <form method="post" action={action}>
        <div class="grid g2" style="align-items:start">
          <div class="card">
            <label>
              Title<span style="color:var(--err)"> *</span>
            </label>
            <input type="text" name="title" value={row?.title ?? ''} required />
            <label>
              Slug<span style="color:var(--err)"> *</span>
            </label>
            <input
              type="text"
              name="slug"
              value={row?.slug ?? ''}
              required
              placeholder="url-safe-slug"
            />
            <label>Locale</label>
            <input type="text" name="locale" value={row?.locale ?? 'en'} />
            {type.fieldsSchema.fields.map((def) => (
              <Field def={def} value={val(fields, def.name)} />
            ))}
          </div>
          <div class="card">
            <h3 style="margin-top:0">SEO &amp; agent</h3>
            <label>Meta description (70–160 chars, required to publish)</label>
            <textarea name="seo_metaDescription" rows={3}>
              {String(seo.metaDescription ?? '')}
            </textarea>
            <label>Meta title (optional override)</label>
            <input type="text" name="seo_metaTitle" value={String(seo.metaTitle ?? '')} />
            <label>OG image (media id)</label>
            <input type="text" name="seo_ogImage" value={String(seo.ogImage ?? '')} />
            <label>schema.org type override</label>
            <input type="text" name="seo_schemaType" value={String(seo.schemaType ?? '')} />
            <label>noindex</label>
            <select name="seo_noindex">
              <option value="false" selected={seo.noindex !== true}>
                No
              </option>
              <option value="true" selected={seo.noindex === true}>
                Yes
              </option>
            </select>
            <label>AI summary (for llms.txt)</label>
            <textarea name="ai_summary" rows={3}>
              {''}
            </textarea>
            <div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn" type="submit" name="action" value="save">
                Save
              </button>
              {row && row.status !== 'published' ? (
                <button class="btn" type="submit" name="action" value="publish">
                  Save &amp; Publish
                </button>
              ) : null}
              {row && row.status === 'published' ? (
                <button class="btn sec" type="submit" name="action" value="unpublish">
                  Unpublish
                </button>
              ) : null}
              {row ? (
                <button
                  class="btn sec"
                  type="submit"
                  name="action"
                  value="delete"
                  style="margin-left:auto;color:var(--err)"
                >
                  Delete
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </form>
    </AdminPage>
  );
};

/**
 * Reconstruct fields/seo/ai objects from the posted form body, coercing
 * by the type schema (booleans, numbers, JSON, relation id arrays).
 */
export function parseContentForm(
  body: Record<string, string | File>,
  schema: FieldDef[],
): {
  title: string;
  slug: string;
  locale: string;
  fields: Record<string, unknown>;
  seo: Record<string, unknown>;
  ai: Record<string, unknown>;
  action: string;
} {
  const get = (k: string): string => String(body[k] ?? '');
  const fields: Record<string, unknown> = {};
  for (const def of schema) {
    const raw = get(`f_${def.name}`);
    if (raw === '' && !def.required) continue;
    switch (def.type) {
      case 'number':
        fields[def.name] = raw === '' ? null : Number(raw);
        break;
      case 'boolean':
        fields[def.name] = raw === 'true';
        break;
      case 'json':
      case 'repeater':
      case 'gallery':
        try {
          fields[def.name] = raw ? JSON.parse(raw) : def.type === 'gallery' ? [] : {};
        } catch {
          fields[def.name] = raw;
        }
        break;
      case 'relation':
        fields[def.name] = raw
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n));
        break;
      case 'multiselect':
        fields[def.name] = raw ? raw.split(',').map((s) => s.trim()) : [];
        break;
      default:
        fields[def.name] = raw;
    }
  }
  return {
    title: get('title'),
    slug: get('slug'),
    locale: get('locale') || 'en',
    fields,
    seo: {
      metaDescription: get('seo_metaDescription'),
      metaTitle: get('seo_metaTitle') || undefined,
      ogImage: get('seo_ogImage') ? Number(get('seo_ogImage')) : undefined,
      schemaType: get('seo_schemaType') || undefined,
      noindex: get('seo_noindex') === 'true',
    },
    ai: { summary: get('ai_summary') || undefined },
    action: get('action') || 'save',
  };
}
