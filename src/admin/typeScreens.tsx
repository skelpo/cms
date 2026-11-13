// Content types: the list, creating a type, and a simple field builder
// (add / edit / reorder / remove fields) on top of the schema-revision writer.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { AdminPage } from './layout.js';
import type { AuthContext } from '../auth/middleware.js';
import { getT, type Translator } from './i18n/index.js';
import { query } from '../db/client.js';
import { listTypes, getTypeBySlug, type ContentTypeRow, type FieldDef, type FieldsSchema } from '../content/types.js';
import { createType, updateType, deleteType, validateFieldsSchema } from '../content/typeWriter.js';
import { invalidate } from '../cache/deps.js';
import { fireEvent } from '../webhooks/dispatch.js';
import { gate, notAuth, allowed, pageUser, readFlash, Flash, withFlash } from './helpers.js';

export const adminTypes = new Hono();

/** Field kinds an editor can add from the UI (repeaters need a developer). */
const FIELD_TYPES = [
  'text', 'textarea', 'richtext', 'number', 'boolean', 'date', 'datetime',
  'email', 'url', 'select', 'multiselect', 'image', 'gallery', 'relation', 'json',
] as const;

function forbidden(c: Context, auth: AuthContext, t: Translator) {
  return c.html(<AdminPage title={t('common.forbidden')} t={t} {...pageUser(auth)}><div class="card">{t('common.noAccess')}</div></AdminPage>, 403);
}

function schemaChanged(slug: string): void {
  invalidate([`type:${slug}`, `type-list:${slug}`], { prefix: true });
  void fireEvent('type.schemaChanged', { type: slug }, [`type:${slug}`]);
}

/** "Case studies" → "caseStudies" (type slugs and field names are alphanumeric). */
function camel(s: string): string {
  const words = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const out = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
  return /^[A-Za-z]/.test(out) ? out : out ? `f${out}` : '';
}

adminTypes.get('/types', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageTypes')) return forbidden(c, auth, t);
  const types = await listTypes();
  const countRows = await query<{ typeSlug: string; n: number }>(
    "SELECT `typeSlug`, COUNT(*) n FROM `content` WHERE `status` != 'archived' GROUP BY `typeSlug`");
  const counts = new Map(countRows.map((r) => [r.typeSlug, Number(r.n)]));
  return c.html(
    <AdminPage title={t('types.title')} active="types" t={t} {...pageUser(auth)}>
      <div class="top"><h1>{t('types.title')}</h1></div>
      <div class="help" style="margin:0 0 14px">{t('types.intro')}</div>
      <Flash flash={readFlash(c)} />
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>{t('types.colName')}</th>
              <th>{t('types.colUrlPattern')}</th>
              <th>{t('types.colFields')}</th>
              <th>{t('types.colEntries')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {types.map((ct) => (
              <tr>
                <td>
                  <a href={`/admin/types/${ct.slug}`} style="font-weight:600">{ct.labelPlural}</a>
                  <div class="muted" style="font-size:11px">{ct.slug}{ct.isBuiltin ? ` · ${t('types.builtin')}` : ''}</div>
                </td>
                <td class="muted">{ct.urlPattern ?? '—'}</td>
                <td class="muted">{ct.fieldsSchema.fields.length}</td>
                <td class="muted"><a href={`/admin/content/${ct.slug}`}>{counts.get(ct.slug) ?? 0}</a></td>
                <td style="text-align:right"><a class="btn sec sm" href={`/admin/types/${ct.slug}`}>{t('common.edit')}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form method="post" action="/admin/types" class="card" style="margin-top:16px">
        <h3>{t('types.newTitle')}</h3>
        <div class="grid g3">
          <div>
            <label for="labelSingular">{t('types.labelSingular')}</label>
            <input type="text" name="labelSingular" id="labelSingular" required maxlength={64} placeholder={t('types.labelSingularPlaceholder')} />
          </div>
          <div>
            <label for="labelPlural">{t('types.labelPlural')}</label>
            <input type="text" name="labelPlural" id="labelPlural" required maxlength={64} placeholder={t('types.labelPluralPlaceholder')} />
          </div>
          <div>
            <label for="urlPattern">{t('types.urlPattern')}</label>
            <input type="text" name="urlPattern" id="urlPattern" placeholder="/case-studies/:slug" />
          </div>
        </div>
        <div class="help">{t('types.urlPatternHelp')}</div>
        <div style="margin-top:14px"><button class="btn" type="submit">{t('types.create')}</button></div>
      </form>
    </AdminPage>,
  );
});

function cleanUrlPattern(raw: string): string | null | false {
  const v = raw.trim();
  if (!v) return null;
  if (!/^\/[A-Za-z0-9/_\-.:]*$/.test(v) || !v.includes(':slug')) return false;
  return v;
}

adminTypes.post('/types', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageTypes')) return forbidden(c, auth, t);
  const b = await c.req.parseBody();
  const labelSingular = String(b.labelSingular ?? '').trim().slice(0, 64);
  const labelPlural = String(b.labelPlural ?? '').trim().slice(0, 64);
  const slug = camel(labelSingular).replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 32);
  const urlPattern = cleanUrlPattern(String(b.urlPattern ?? ''));
  if (!labelSingular || !labelPlural || !slug) return c.redirect(withFlash('/admin/types', 'err', t('types.errLabels')), 302);
  if (urlPattern === false) return c.redirect(withFlash('/admin/types', 'err', t('types.errUrlPattern')), 302);
  const res = await createType({
    slug,
    labelSingular,
    labelPlural,
    isRoutable: urlPattern !== null,
    urlPattern,
    fieldsSchema: {
      version: 1,
      fields: [
        { name: 'description', type: 'textarea', label: 'Description', translatable: true },
        { name: 'body', type: 'richtext', label: 'Body', translatable: true },
      ],
    },
  }, auth.user.id);
  if (!res.ok) return c.redirect(withFlash('/admin/types', 'err', t('types.errExists', { slug })), 302);
  schemaChanged(slug);
  return c.redirect(withFlash(`/admin/types/${slug}`, 'ok', t('types.flashCreated')), 302);
});

adminTypes.get('/types/:slug', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageTypes')) return forbidden(c, auth, t);
  const ct = await getTypeBySlug(c.req.param('slug'));
  if (!ct) return c.redirect(withFlash('/admin/types', 'err', t('common.unknownType')), 302);
  const fields = ct.fieldsSchema.fields;
  const editing = fields.find((f) => f.name === c.req.query('field')) ?? null;
  const allTypes = await listTypes();
  const base = `/admin/types/${ct.slug}`;
  const options = (f: FieldDef | null): string => ((f?.validation?.options as string[] | undefined) ?? []).join('\n');

  return c.html(
    <AdminPage title={ct.labelPlural} active="types" t={t} {...pageUser(auth)}>
      <div class="top">
        <h1>{ct.labelPlural}</h1>
        <a class="btn sec" href="/admin/types">{t('types.backToTypes')}</a>
      </div>
      <Flash flash={readFlash(c)} />
      <div class="editor-grid">
        <div class="stack">
          <div class="card">
            <h3>{t('types.fieldsTitle')}</h3>
            <div class="help" style="margin-top:0">{t('types.fieldsIntro')}</div>
            <table style="margin-top:8px">
              <thead><tr><th>{t('types.fieldLabel')}</th><th>{t('types.fieldType')}</th><th></th></tr></thead>
              <tbody>
                <tr>
                  <td>{t('editor.title')} <span style="color:var(--err)">*</span></td>
                  <td class="muted">{t('types.kind.text')}</td>
                  <td class="muted" style="text-align:right;font-size:12px">{t('types.alwaysPresent')}</td>
                </tr>
                {fields.map((f, i) => (
                  <tr>
                    <td>
                      {f.label ?? f.name}{f.required ? <span style="color:var(--err)"> *</span> : null}
                      <div class="muted" style="font-size:11px">{f.name}</div>
                    </td>
                    <td class="muted">{(FIELD_TYPES as readonly string[]).includes(f.type) || f.type === 'repeater' || f.type === 'file' || f.type === 'color' ? t(`types.kind.${f.type}`) : f.type}</td>
                    <td style="text-align:right;white-space:nowrap">
                      <form method="post" action={`${base}/fields/${f.name}/move`} style="margin:0;display:inline">
                        <button class="btn sec sm" type="submit" name="dir" value="up" disabled={i === 0} aria-label={t('menus.moveUp')}>↑</button>{' '}
                        <button class="btn sec sm" type="submit" name="dir" value="down" disabled={i === fields.length - 1} aria-label={t('menus.moveDown')}>↓</button>
                      </form>{' '}
                      <a class="btn sec sm" href={`${base}?field=${f.name}#field-form`}>{t('common.edit')}</a>{' '}
                      <form method="post" action={`${base}/fields/${f.name}/delete`} style="margin:0;display:inline">
                        <button class="btn danger sm" type="submit" data-confirm={t('types.confirmRemoveField', { field: f.label ?? f.name })}>{t('types.removeField')}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form method="post" action={`${base}/fields`} class="card" id="field-form">
            <h3>{editing ? t('types.editField', { field: editing.label ?? editing.name }) : t('types.addField')}</h3>
            {editing ? <input type="hidden" name="name" value={editing.name} /> : null}
            <div class="grid g2">
              <div>
                <label for="f-label">{t('types.fieldLabel')}</label>
                <input type="text" name="label" id="f-label" value={editing?.label ?? ''} required maxlength={64} />
              </div>
              <div>
                <label for="f-type">{t('types.fieldType')}</label>
                {editing ? (
                  <input type="text" value={t(`types.kind.${editing.type}`)} disabled />
                ) : (
                  <select name="type" id="f-type">
                    {FIELD_TYPES.map((k) => <option value={k}>{t(`types.kind.${k}`)}</option>)}
                  </select>
                )}
              </div>
            </div>
            <label for="f-help">{t('types.fieldHelp')}</label>
            <input type="text" name="help" id="f-help" value={typeof editing?.admin?.help === 'string' ? editing.admin.help : ''} maxlength={300} />
            <div class="help">{t('types.fieldHelpHint')}</div>
            {!editing || editing.type === 'select' || editing.type === 'multiselect' ? (
              <>
                <label for="f-options">{t('types.fieldOptions')}</label>
                <textarea name="options" id="f-options" rows={3}>{options(editing)}</textarea>
                <div class="help">{t('types.fieldOptionsHint')}</div>
              </>
            ) : null}
            {!editing || editing.type === 'relation' ? (
              <>
                <label for="f-toType">{t('types.fieldRelation')}</label>
                <select name="toType" id="f-toType">
                  {allTypes.filter((x) => !['form', 'errorPage'].includes(x.slug)).map((x) => (
                    <option value={x.slug} selected={editing?.relation?.toType === x.slug}>{x.labelPlural}</option>
                  ))}
                </select>
                {!editing ? <div class="help">{t('types.fieldRelationHint')}</div> : null}
              </>
            ) : null}
            <label class="check" style="margin-top:14px">
              <input type="checkbox" name="required" value="1" checked={editing?.required === true} /> {t('types.fieldRequired')}
            </label>
            <div style="margin-top:14px;display:flex;gap:8px">
              <button class="btn" type="submit">{editing ? t('common.save') : t('types.addField')}</button>
              {editing ? <a class="btn sec" href={base}>{t('common.cancel')}</a> : null}
            </div>
          </form>
        </div>

        <div class="stack">
          <form method="post" action={base} class="card">
            <h3>{t('types.detailsTitle')}</h3>
            <label for="labelSingular">{t('types.labelSingular')}</label>
            <input type="text" name="labelSingular" id="labelSingular" value={ct.labelSingular} required maxlength={64} />
            <label for="labelPlural">{t('types.labelPlural')}</label>
            <input type="text" name="labelPlural" id="labelPlural" value={ct.labelPlural} required maxlength={64} />
            <label for="urlPattern">{t('types.urlPattern')}</label>
            <input type="text" name="urlPattern" id="urlPattern" value={ct.urlPattern ?? ''} placeholder="/blog/:slug" />
            <div class="help">{t('types.urlPatternHelp')}</div>
            <div style="margin-top:14px"><button class="btn" type="submit">{t('common.save')}</button></div>
          </form>
          {!ct.isBuiltin ? (
            <div class="card">
              <h3>{t('types.deleteTitle')}</h3>
              <div class="help" style="margin-top:0">{t('types.deleteHelp')}</div>
              <form method="post" action={`${base}/delete`} style="margin-top:10px">
                <button class="btn danger" type="submit" data-confirm={t('types.confirmDelete', { name: ct.labelPlural })}>{t('types.deleteType')}</button>
              </form>
            </div>
          ) : null}
        </div>
      </div>
    </AdminPage>,
  );
});

adminTypes.post('/types/:slug', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageTypes')) return forbidden(c, auth, t);
  const slug = c.req.param('slug');
  const back = `/admin/types/${slug}`;
  const b = await c.req.parseBody();
  const labelSingular = String(b.labelSingular ?? '').trim().slice(0, 64);
  const labelPlural = String(b.labelPlural ?? '').trim().slice(0, 64);
  const urlPattern = cleanUrlPattern(String(b.urlPattern ?? ''));
  if (!labelSingular || !labelPlural) return c.redirect(withFlash(back, 'err', t('types.errLabels')), 302);
  if (urlPattern === false) return c.redirect(withFlash(back, 'err', t('types.errUrlPattern')), 302);
  const res = await updateType(slug, { labelSingular, labelPlural, urlPattern, isRoutable: urlPattern !== null }, auth.user.id);
  if (!res.ok) return c.redirect(withFlash(back, 'err', res.error), 302);
  schemaChanged(slug);
  return c.redirect(withFlash(back, 'ok', t('content.flashSaved')), 302);
});

/** Apply a new field list as a schema revision. */
async function saveFields(ct: ContentTypeRow, fields: FieldDef[], auth: AuthContext): Promise<string | null> {
  const fieldsSchema: FieldsSchema = { version: ct.fieldsSchema.version ?? 1, fields };
  const check = validateFieldsSchema(fieldsSchema);
  if (!check.ok) return check.error;
  const res = await updateType(ct.slug, { fieldsSchema }, auth.user.id);
  if (!res.ok) return res.error;
  schemaChanged(ct.slug);
  return null;
}

adminTypes.post('/types/:slug/fields', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageTypes')) return forbidden(c, auth, t);
  const ct = await getTypeBySlug(c.req.param('slug'));
  if (!ct) return c.redirect('/admin/types', 302);
  const back = `/admin/types/${ct.slug}`;
  const b = await c.req.parseBody();
  const label = String(b.label ?? '').trim().slice(0, 64);
  const help = String(b.help ?? '').trim().slice(0, 300);
  const required = b.required === '1';
  const optionList = String(b.options ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!label) return c.redirect(withFlash(back, 'err', t('types.errFieldLabel')), 302);
  const fields = ct.fieldsSchema.fields.map((f) => ({ ...f }));

  const existingName = String(b.name ?? '');
  if (existingName) {
    const f = fields.find((x) => x.name === existingName);
    if (!f) return c.redirect(withFlash(back, 'err', t('common.notFound')), 302);
    f.label = label;
    f.required = required;
    f.admin = { ...(f.admin ?? {}) };
    if (help) f.admin.help = help; else delete f.admin.help;
    if (f.type === 'select' || f.type === 'multiselect') f.validation = { ...(f.validation ?? {}), options: optionList };
    if (f.type === 'relation' && b.toType) f.relation = { ...(f.relation ?? { many: true }), toType: String(b.toType) };
  } else {
    const type = String(b.type ?? 'text');
    if (!(FIELD_TYPES as readonly string[]).includes(type)) return c.redirect(withFlash(back, 'err', t('types.errFieldType')), 302);
    let name = camel(label).slice(0, 48);
    if (!name || ['title', 'slug', 'locale', 'status', 'id'].includes(name)) name = `${name || 'field'}Field`;
    if (fields.some((x) => x.name === name)) return c.redirect(withFlash(back, 'err', t('types.errFieldExists', { field: label })), 302);
    const def: FieldDef = { name, type, label, required };
    if (['text', 'textarea', 'richtext'].includes(type)) def.translatable = true;
    if (help) def.admin = { help };
    if (type === 'select' || type === 'multiselect') def.validation = { options: optionList };
    if (type === 'select' && optionList.length === 0) return c.redirect(withFlash(back, 'err', t('types.errOptions')), 302);
    if (type === 'relation') def.relation = { toType: String(b.toType ?? ct.slug), many: true };
    fields.push(def);
  }
  const err = await saveFields(ct, fields, auth);
  if (err) return c.redirect(withFlash(back, 'err', err), 302);
  return c.redirect(withFlash(back, 'ok', t('content.flashSaved')), 302);
});

adminTypes.post('/types/:slug/fields/:name/move', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageTypes')) return forbidden(c, auth, t);
  const ct = await getTypeBySlug(c.req.param('slug'));
  if (!ct) return c.redirect('/admin/types', 302);
  const fields = [...ct.fieldsSchema.fields];
  const at = fields.findIndex((f) => f.name === c.req.param('name'));
  const to = String((await c.req.parseBody()).dir ?? '') === 'up' ? at - 1 : at + 1;
  if (at >= 0 && to >= 0 && to < fields.length) {
    [fields[at], fields[to]] = [fields[to]!, fields[at]!];
    await saveFields(ct, fields, auth);
  }
  return c.redirect(`/admin/types/${ct.slug}`, 302);
});

adminTypes.post('/types/:slug/fields/:name/delete', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageTypes')) return forbidden(c, auth, t);
  const ct = await getTypeBySlug(c.req.param('slug'));
  if (!ct) return c.redirect('/admin/types', 302);
  const back = `/admin/types/${ct.slug}`;
  const fields = ct.fieldsSchema.fields.filter((f) => f.name !== c.req.param('name'));
  if (fields.length === ct.fieldsSchema.fields.length) return c.redirect(back, 302);
  const err = await saveFields(ct, fields, auth);
  return c.redirect(withFlash(back, err ? 'err' : 'ok', err ?? t('types.flashFieldRemoved')), 302);
});

adminTypes.post('/types/:slug/delete', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!allowed(auth, 'manageTypes')) return forbidden(c, auth, t);
  const slug = c.req.param('slug');
  const res = await deleteType(slug);
  if (!res.ok) {
    return c.redirect(withFlash(`/admin/types/${slug}`, 'err', res.status === 409 ? t('types.errHasEntries') : res.error), 302);
  }
  schemaChanged(slug);
  return c.redirect(withFlash('/admin/types', 'ok', t('types.flashDeleted')), 302);
});
