// Content screens: the list (search, filters, trash, bulk actions), the
// editor (create / update / publish / schedule), revisions and duplicate.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { AdminPage, StatusBadge } from './layout.js';
import type { AuthContext } from '../auth/middleware.js';
import { query, queryOne, execute } from '../db/client.js';
import { dateToIso } from '../db/datetime.js';
import { getTypeBySlug, type ContentTypeRow, type FieldDef } from '../content/types.js';
import { findById, computeUrl, type ContentDbRow } from '../content/content.js';
import {
  createContent,
  updateContent,
  publishContent,
  unpublishContent,
  deleteContent,
  restoreContent,
  validateFields,
  validateSeoForPublish,
  type ValidationError,
} from '../content/writer.js';
import { invalidate } from '../cache/deps.js';
import { fireEvent } from '../webhooks/dispatch.js';
import { getConfiguredLocales, getDefaultLocale, getSetting } from '../settings/store.js';
import { ContentForm, parseContentForm, type EditorMeta, type ParsedContentForm, type RelationOption } from './contentEditor.js';
import { getT, type Translator } from './i18n/index.js';
import { gate, notAuth, allowed, pageUser, readFlash, Flash, withFlash, DateTime, Pager, toDbDatetime, slugify } from './helpers.js';

export const adminContent = new Hono();

const PER_PAGE = 25;

function parseObj(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; }
  }
  return (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
}

async function siteUrl(): Promise<string> {
  const v = await getSetting<unknown>('site.url', '');
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v.replace(/\/+$/, '') : '';
}

function invalidateAndNotify(event: Parameters<typeof fireEvent>[0], typeSlug: string, locale: string, id: number): void {
  invalidate([`content:${id}`]);
  invalidate([`type-list:${typeSlug}:${locale}`], { prefix: true });
  void fireEvent(event, { id, type: typeSlug, locale }, [`content:${id}`, `type-list:${typeSlug}:${locale}`]);
}

function notFoundPage(c: Context, auth: AuthContext, t: Translator, message: string, status: 403 | 404 = 404) {
  return c.html(<AdminPage title={message} t={t} {...pageUser(auth)}><div class="card">{message}</div></AdminPage>, status);
}

// ── Human-readable validation messages ─────────────────────────────────

function friendlyErrors(t: Translator, errors: ValidationError[], schema: FieldDef[]): string[] {
  const labelOf = (name: string): string => schema.find((d) => d.name === name)?.label ?? name;
  return errors.map((e) => {
    if (e.field === 'seo.metaDescription') {
      return e.constraint === 'required' ? t('errors.metaRequired') : t('errors.metaLength');
    }
    if (e.field === 'title' && e.constraint === 'maxLength') return t('errors.titleTooLong');
    if (e.field === 'slug' && e.constraint === 'format') return t('errors.slugFormat');
    if (e.field === 'slug' && e.constraint === 'unique') return t('errors.slugTaken');
    if (e.field === 'locale') return t('errors.localeUnknown');
    if (e.constraint === 'conflict') return t('errors.conflict');
    if (e.constraint === 'required' && e.field) return t('errors.fieldRequired', { field: labelOf(e.field) });
    if (e.constraint === 'options' && e.field) return t('errors.fieldOption', { field: labelOf(e.field) });
    return e.message;
  });
}

/** Plain-text teaser for a missing meta description: the entry's own
 *  description/excerpt, else the start of its body. Null when too short. */
function deriveMetaDescription(fields: Record<string, unknown>): string | null {
  const candidates = ['description', 'excerpt', 'summary', 'teaser', 'intro', 'body', 'content'];
  for (const name of candidates) {
    const raw = fields[name];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const text = raw
      .replace(/^---[\s\S]*?---/, ' ')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^[#>\-*+\s]+/gm, '')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length < 70) continue;
    if (text.length <= 160) return text;
    const cut = text.slice(0, 159);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > 100 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.\-–]+$/, '')}…`;
  }
  return null;
}

function withDerivedMeta(seo: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  if (String(seo.metaDescription ?? '').trim()) return seo;
  const derived = deriveMetaDescription(fields);
  return derived ? { ...seo, metaDescription: derived } : seo;
}

// ── Editor context (author, revisions, relation choices, URLs) ─────────

async function relationOptionsFor(ct: ContentTypeRow, locale: string, selfId?: number): Promise<Record<string, RelationOption[]>> {
  const out: Record<string, RelationOption[]> = {};
  for (const def of ct.fieldsSchema.fields) {
    if (def.type !== 'relation' || !def.relation?.toType) continue;
    const rows = await query<{ id: number; title: string; locale: string }>(
      "SELECT `id`, `title`, `locale` FROM `content` WHERE `typeSlug` = ? AND `status` != 'archived' ORDER BY (`locale` = ?) DESC, `title` LIMIT 300",
      [def.relation.toType, locale],
    );
    out[def.name] = rows
      .filter((r) => r.id !== selfId)
      .map((r) => ({ id: r.id, title: r.locale === locale ? r.title : `${r.title} (${r.locale})` }));
  }
  return out;
}

async function editorMeta(auth: AuthContext, ct: ContentTypeRow, row: ContentDbRow | null, locale: string): Promise<EditorMeta> {
  const base = await siteUrl();
  const meta: EditorMeta = {
    siteUrl: base,
    canPublish: allowed(auth, 'publish', ct.slug, row?.authorId ?? auth.user.id),
    canDelete: row ? allowed(auth, 'delete', ct.slug, row.authorId) : false,
    relationOptions: await relationOptionsFor(ct, locale, row?.id),
    authorName: auth.user.displayName,
  };
  if (row) {
    const path = computeUrl(row, ct, await getDefaultLocale());
    meta.viewUrl = path && base ? `${base}${path}` : null;
    const author = row.authorId
      ? await queryOne<{ displayName: string }>('SELECT `displayName` FROM `users` WHERE `id` = ?', [row.authorId])
      : null;
    meta.authorName = author?.displayName ?? null;
    const rev = await queryOne<{ n: number }>('SELECT COUNT(*) n FROM `contentRevisions` WHERE `contentId` = ?', [row.id]);
    meta.revisionCount = Number(rev?.n ?? 0);
  }
  return meta;
}

async function siblingsOf(row: Pick<ContentDbRow, 'translationGroupId' | 'typeSlug'>): Promise<{ id: number; locale: string; status: string }[]> {
  return query<{ id: number; locale: string; status: string }>(
    "SELECT `id`, `locale`, `status` FROM `content` WHERE `translationGroupId` = ? AND `typeSlug` = ? AND `status` != 'archived' ORDER BY `locale`",
    [row.translationGroupId, row.typeSlug],
  );
}

// ── Row actions shared by the list, bulk bar and the editor ────────────

type RowAction = 'trash' | 'restore' | 'purge' | 'publish' | 'unpublish' | 'duplicate';

async function uniqueCopySlug(typeSlug: string, locale: string, slug: string): Promise<string> {
  for (let i = 1; i < 50; i++) {
    const suffix = i === 1 ? '-copy' : `-copy-${i}`;
    const candidate = `${slug.slice(0, 75 - suffix.length).replace(/-+$/, '')}${suffix}`;
    const dup = await queryOne<{ id: number }>(
      'SELECT `id` FROM `content` WHERE `typeSlug` = ? AND `slug` = ? AND `locale` = ?',
      [typeSlug, candidate, locale],
    );
    if (!dup) return candidate;
  }
  return `${slug.slice(0, 60)}-${Date.now().toString(36)}`;
}

/** Publish now, filling a missing meta description from the entry itself. */
async function publishRow(auth: AuthContext, row: ContentDbRow): Promise<{ ok: true } | { ok: false; errors: ValidationError[] }> {
  const fields = parseObj(row.fields);
  const seo = parseObj(row.seo);
  const filled = withDerivedMeta(seo, fields);
  if (filled !== seo) await execute('UPDATE `content` SET `seo` = ? WHERE `id` = ?', [JSON.stringify(filled), row.id]);
  const pub = await publishContent(row.id, auth.user.id);
  if (!pub.ok) return { ok: false, errors: pub.errors };
  await execute('UPDATE `content` SET `scheduledAt` = NULL WHERE `id` = ?', [row.id]);
  invalidateAndNotify('content.published', row.typeSlug, row.locale, row.id);
  return { ok: true };
}

async function applyRowAction(
  auth: AuthContext,
  ct: ContentTypeRow,
  row: ContentDbRow,
  action: RowAction,
  t: Translator,
): Promise<{ ok: boolean; message: string; newId?: number }> {
  switch (action) {
    case 'trash': {
      if (!allowed(auth, 'delete', ct.slug, row.authorId)) return { ok: false, message: t('content.noDeletePermission') };
      await deleteContent(row.id, false);
      invalidateAndNotify('content.deleted', ct.slug, row.locale, row.id);
      return { ok: true, message: t('content.flashTrashed') };
    }
    case 'restore': {
      if (!allowed(auth, 'update', ct.slug, row.authorId)) return { ok: false, message: t('content.noUpdatePermission') };
      await restoreContent(row.id, auth.user.id);
      invalidateAndNotify('content.updated', ct.slug, row.locale, row.id);
      return { ok: true, message: t('content.flashRestored') };
    }
    case 'purge': {
      if (!allowed(auth, 'delete', ct.slug, row.authorId)) return { ok: false, message: t('content.noDeletePermission') };
      if (row.status !== 'archived') return { ok: false, message: t('content.purgeOnlyTrash') };
      await deleteContent(row.id, true);
      invalidateAndNotify('content.deleted', ct.slug, row.locale, row.id);
      return { ok: true, message: t('content.flashPurged') };
    }
    case 'publish': {
      if (!allowed(auth, 'publish', ct.slug, row.authorId)) return { ok: false, message: t('content.noPublishPermission') };
      if (row.status === 'archived') return { ok: false, message: t('content.restoreFirst') };
      const pub = await publishRow(auth, row);
      if (!pub.ok) {
        return { ok: false, message: t('content.publishBlocked', { reason: friendlyErrors(t, pub.errors, ct.fieldsSchema.fields).join(' ') }) };
      }
      return { ok: true, message: t('content.flashPublished') };
    }
    case 'unpublish': {
      if (!allowed(auth, 'publish', ct.slug, row.authorId)) return { ok: false, message: t('content.noPublishPermission') };
      await unpublishContent(row.id, auth.user.id);
      await execute('UPDATE `content` SET `scheduledAt` = NULL WHERE `id` = ?', [row.id]);
      invalidateAndNotify('content.unpublished', ct.slug, row.locale, row.id);
      return { ok: true, message: t('content.flashUnpublished') };
    }
    case 'duplicate': {
      if (!allowed(auth, 'create', ct.slug)) return { ok: false, message: t('content.noCreatePermission') };
      const copyTitle = `${row.title.slice(0, 70 - t('content.copySuffix').length - 1)} ${t('content.copySuffix')}`;
      const res = await createContent({
        type: ct.slug,
        slug: await uniqueCopySlug(ct.slug, row.locale, row.slug),
        locale: row.locale,
        title: copyTitle,
        fields: parseObj(row.fields),
        seo: parseObj(row.seo),
        ai: parseObj(row.ai),
        status: 'draft',
        authorId: auth.user.id,
      });
      if (!res.ok) return { ok: false, message: friendlyErrors(t, res.errors, ct.fieldsSchema.fields).join(' ') };
      invalidateAndNotify('content.created', ct.slug, row.locale, res.id);
      return { ok: true, message: t('content.flashDuplicated'), newId: res.id };
    }
  }
}

const ROW_ACTIONS: RowAction[] = ['trash', 'restore', 'purge', 'publish', 'unpublish', 'duplicate'];
const isRowAction = (s: string): s is RowAction => (ROW_ACTIONS as string[]).includes(s);

/** Only allow returning to this type's list (no open redirect). */
function safeReturn(ret: string, typeSlug: string): string {
  const base = `/admin/content/${typeSlug}`;
  return ret === base || ret.startsWith(`${base}?`) ? ret.replace(/[?&](ok|err)=[^&]*/g, '').replace(/\?$/, '') : base;
}

// ── Content list ───────────────────────────────────────────────────────

const STATUS_FILTERS = ['all', 'published', 'draft', 'scheduled', 'trash'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const SORTS: Record<string, string> = {
  title: '`c`.`title` ASC',
  '-title': '`c`.`title` DESC',
  updatedAt: '`c`.`updatedAt` ASC',
  '-updatedAt': '`c`.`updatedAt` DESC',
};

adminContent.get('/content/:type', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const ct = await getTypeBySlug(c.req.param('type'));
  if (!ct) return notFoundPage(c, auth, t, t('common.unknownType'));
  if (!allowed(auth, 'read', ct.slug)) return notFoundPage(c, auth, t, t('common.forbidden'), 403);

  const locales = await getConfiguredLocales();
  const defaultLocale = await getDefaultLocale();
  const localeParam = c.req.query('locale') ?? (locales.length > 1 ? 'all' : defaultLocale);
  const locale = localeParam === 'all' || locales.includes(localeParam) ? localeParam : 'all';
  const statusParam = c.req.query('status') ?? 'all';
  const status: StatusFilter = (STATUS_FILTERS as readonly string[]).includes(statusParam) ? (statusParam as StatusFilter) : 'all';
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const sortParam = c.req.query('sort') ?? '-updatedAt';
  const sort = SORTS[sortParam] ? sortParam : '-updatedAt';
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const monthParam = c.req.query('m') ?? '';
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : '';

  const canDrafts = allowed(auth, 'readDrafts', ct.slug);
  const canOthers = allowed(auth, 'readOthersDrafts', ct.slug);

  // Visibility + locale: applies to the rows and to the per-status counts.
  const baseWhere: string[] = ['`c`.`typeSlug` = ?'];
  const baseParams: unknown[] = [ct.slug];
  if (locale !== 'all') { baseWhere.push('`c`.`locale` = ?'); baseParams.push(locale); }
  if (!canDrafts) baseWhere.push("`c`.`status` = 'published'");
  else if (!canOthers) { baseWhere.push("(`c`.`status` = 'published' OR `c`.`authorId` = ?)"); baseParams.push(auth.user.id); }

  const countRows = await query<{ status: string; scheduled: number; n: number }>(
    `SELECT \`c\`.\`status\` AS status,
            (\`c\`.\`status\` IN ('draft','review') AND \`c\`.\`scheduledAt\` IS NOT NULL AND \`c\`.\`scheduledAt\` > NOW()) AS scheduled,
            COUNT(*) AS n
       FROM \`content\` c WHERE ${baseWhere.join(' AND ')} GROUP BY 1, 2`,
    baseParams,
  );
  const counts: Record<StatusFilter, number> = { all: 0, published: 0, draft: 0, scheduled: 0, trash: 0 };
  for (const r of countRows) {
    const n = Number(r.n);
    if (r.status === 'archived') { counts.trash += n; continue; }
    counts.all += n;
    if (r.status === 'published') counts.published += n;
    else if (Number(r.scheduled) === 1) counts.scheduled += n;
    else counts.draft += n;
  }

  // Months that have entries, for the date filter (publication date, or the
  // creation date for entries that were never published).
  const dateSql = 'COALESCE(`c`.`publishedAt`, `c`.`createdAt`)';
  const monthRows = await query<{ ym: string }>(
    `SELECT DISTINCT DATE_FORMAT(${dateSql}, '%Y-%m') AS ym FROM \`content\` c
      WHERE ${baseWhere.join(' AND ')} AND \`c\`.\`status\` != 'archived' ORDER BY ym DESC LIMIT 120`,
    baseParams,
  );
  const months = monthRows.map((r) => String(r.ym)).filter(Boolean);

  const where = [...baseWhere];
  const params = [...baseParams];
  if (month) { where.push(`DATE_FORMAT(${dateSql}, '%Y-%m') = ?`); params.push(month); }
  const scheduledSql = '(`c`.`scheduledAt` IS NOT NULL AND `c`.`scheduledAt` > NOW())';
  if (status === 'all') where.push("`c`.`status` != 'archived'");
  else if (status === 'published') where.push("`c`.`status` = 'published'");
  else if (status === 'draft') where.push(`\`c\`.\`status\` IN ('draft','review') AND NOT ${scheduledSql}`);
  else if (status === 'scheduled') where.push(`\`c\`.\`status\` IN ('draft','review') AND ${scheduledSql}`);
  else where.push("`c`.`status` = 'archived'");
  if (q) {
    where.push('(`c`.`title` LIKE ? OR `c`.`slug` LIKE ?)');
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like);
  }

  const total = Number((await queryOne<{ n: number }>(
    `SELECT COUNT(*) n FROM \`content\` c WHERE ${where.join(' AND ')}`, params,
  ))?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const current = Math.min(page, pages);
  const rows = await query<ContentDbRow & { authorName: string | null }>(
    `SELECT \`c\`.*, \`u\`.\`displayName\` AS authorName
       FROM \`content\` c LEFT JOIN \`users\` u ON \`u\`.\`id\` = \`c\`.\`authorId\`
      WHERE ${where.join(' AND ')}
      ORDER BY ${SORTS[sort]}, \`c\`.\`id\` DESC
      LIMIT ${PER_PAGE} OFFSET ${(current - 1) * PER_PAGE}`,
    params,
  );

  const base = `/admin/content/${ct.slug}`;
  const href = (over: Record<string, string | number>): string => {
    const p: Record<string, string> = { locale, status, q, m: month, sort, page: String(current) };
    for (const [k, v] of Object.entries(over)) p[k] = String(v);
    const qs = Object.entries(p)
      .filter(([k, v]) => v !== '' && !(k === 'status' && v === 'all') && !(k === 'page' && v === '1') && !(k === 'sort' && v === '-updatedAt'))
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return qs ? `${base}?${qs}` : base;
  };
  const here = href({});
  const sortLink = (col: 'title' | 'updatedAt', label: string) => {
    const next = sort === col ? `-${col}` : sort === `-${col}` ? col : col === 'updatedAt' ? '-updatedAt' : 'title';
    const arrow = sort === col ? ' ↑' : sort === `-${col}` ? ' ↓' : '';
    return <a href={href({ sort: next, page: 1 })} style="color:inherit">{label}{arrow}</a>;
  };
  const site = await siteUrl();
  const canCreate = allowed(auth, 'create', ct.slug);
  const showLocale = locales.length > 1;
  const cols = 4 + (showLocale ? 1 : 0) + 1;
  const now = Date.now();

  return c.html(
    <AdminPage title={ct.labelPlural} active={ct.slug} t={t} {...pageUser(auth)}>
      <div class="top">
        <h1>{ct.labelPlural}</h1>
        {canCreate ? (
          <a class="btn" href={`${base}/new${locale !== 'all' ? `?locale=${locale}` : ''}`}>
            {t('content.newItem', { label: ct.labelSingular })}
          </a>
        ) : null}
      </div>
      <Flash flash={readFlash(c)} />
      <div class="subtabs">
        {STATUS_FILTERS.filter((s) => s === 'all' || counts[s] > 0 || s === status).map((s) => (
          <a href={href({ status: s, page: 1 })} class={s === status ? 'on' : ''}>
            {t(`content.filter.${s}`)} <span class="muted">({counts[s]})</span>
          </a>
        ))}
      </div>
      <div class="card" style="margin-bottom:14px;padding:10px 14px">
        <div class="toolbar">
          <form method="get" action={base} class="toolbar" style="margin:0;flex:1">
            {status !== 'all' ? <input type="hidden" name="status" value={status} /> : null}
            <input type="search" name="q" value={q} placeholder={t('content.searchPlaceholder', { label: ct.labelPlural })} style="min-width:220px;flex:1;max-width:340px" />
            {showLocale ? (
              <select name="locale" onchange="this.form.submit()" aria-label={t('content.locale')}>
                <option value="all" selected={locale === 'all'}>{t('content.allLocales')}</option>
                {locales.map((l) => <option value={l} selected={locale === l}>{l.toUpperCase()}</option>)}
              </select>
            ) : null}
            {months.length > 1 || month ? (
              <select name="m" onchange="this.form.submit()" aria-label={t('content.allDates')}>
                <option value="">{t('content.allDates')}</option>
                {(month && !months.includes(month) ? [month, ...months] : months).map((ym) => (
                  <option value={ym} selected={ym === month} data-month={ym}>{ym}</option>
                ))}
              </select>
            ) : null}
            <button class="btn sec sm" type="submit">{t('content.search')}</button>
            {q ? <a href={href({ q: '', page: 1 })} style="font-size:12px">{t('content.clearSearch')}</a> : null}
          </form>
          <form id="bulk" method="post" action={`${base}/bulk`} class="toolbar" style="margin:0">
            <input type="hidden" name="return" value={here} />
            <select name="action" aria-label={t('content.bulkActions')}>
              <option value="">{t('content.bulkActions')}</option>
              {status === 'trash' ? (
                <>
                  <option value="restore">{t('content.restore')}</option>
                  <option value="purge">{t('content.deletePermanently')}</option>
                </>
              ) : (
                <>
                  <option value="publish">{t('editor.publish')}</option>
                  <option value="unpublish">{t('editor.unpublish')}</option>
                  <option value="trash">{t('content.moveToTrash')}</option>
                </>
              )}
            </select>
            <button class="btn sec sm" type="submit" data-confirm={status === 'trash' ? t('content.confirmBulk') : undefined}>{t('content.apply')}</button>
          </form>
        </div>
      </div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th style="width:28px">
                <input type="checkbox" aria-label={t('content.selectAll')}
                  onclick="document.querySelectorAll('input[form=bulk][name=ids]').forEach(function(b){b.checked=event.target.checked})" />
              </th>
              <th>{sortLink('title', t('content.colTitle'))}</th>
              {showLocale ? <th>{t('content.colLocale')}</th> : null}
              <th>{t('content.colStatus')}</th>
              <th>{t('content.colAuthor')}</th>
              <th>{sortLink('updatedAt', t('content.colUpdated'))}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colspan={cols} class="muted" style="text-align:center;padding:28px">
                  {q
                    ? t('content.emptySearch', { q })
                    : status === 'trash'
                      ? t('content.emptyTrash')
                      : t('content.empty', { label: ct.labelPlural })}
                  {!q && status === 'all' && canCreate ? (
                    <div style="margin-top:10px"><a class="btn" href={`${base}/new`}>{t('content.newItem', { label: ct.labelSingular })}</a></div>
                  ) : null}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const sched = dateToIso(r.scheduledAt);
                const isScheduled = r.status !== 'published' && r.status !== 'archived' && !!sched && new Date(sched).getTime() > now;
                const path = computeUrl(r, ct, defaultLocale);
                const rowAction = (action: RowAction, label: string, opts: { danger?: boolean; confirm?: string } = {}) => (
                  <form method="post" action={`${base}/${r.id}/action`}>
                    <input type="hidden" name="return" value={here} />
                    <button class={`linkbtn${opts.danger ? ' danger' : ''}`} type="submit" name="action" value={action}
                      data-confirm={opts.confirm}>{label}</button>
                  </form>
                );
                return (
                  <tr>
                    <td><input type="checkbox" form="bulk" name="ids" value={String(r.id)} aria-label={r.title} /></td>
                    <td>
                      <a href={`${base}/${r.id}`} style="font-weight:600">{r.title || t('content.untitled')}</a>
                      <div class="muted" style="font-size:11px">/{r.slug}</div>
                      <div class="rowact">
                        {r.status === 'archived' ? (
                          <>
                            {rowAction('restore', t('content.restore'))}
                            {rowAction('purge', t('content.deletePermanently'), { danger: true, confirm: t('content.confirmPurge') })}
                          </>
                        ) : (
                          <>
                            <a href={`${base}/${r.id}`}>{t('common.edit')}</a>
                            {r.status === 'published' && path && site ? <a href={`${site}${path}`} target="_blank" rel="noopener">{t('content.view')} ↗</a> : null}
                            {canCreate ? rowAction('duplicate', t('content.duplicate')) : null}
                            {rowAction('trash', t('content.trash'), { danger: true })}
                          </>
                        )}
                      </div>
                    </td>
                    {showLocale ? <td class="muted" style="text-transform:uppercase">{r.locale}</td> : null}
                    <td>
                      <StatusBadge status={isScheduled ? 'scheduled' : r.status} t={t} />
                      {isScheduled ? <div class="muted" style="font-size:11px;margin-top:3px"><DateTime value={r.scheduledAt} /></div> : null}
                    </td>
                    <td class="muted">{r.authorName ?? '—'}</td>
                    <td class="muted"><DateTime value={r.updatedAt} /></td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <Pager page={current} pages={pages} href={(p) => href({ page: p })}
          label={t('content.pageOf', { page: current, pages, total })} />
      </div>
    </AdminPage>,
  );
});

// Bulk actions from the list.
adminContent.post('/content/:type/bulk', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const ct = await getTypeBySlug(c.req.param('type'));
  if (!ct) return notFoundPage(c, auth, t, t('common.unknownType'));
  const body = await c.req.parseBody({ all: true });
  const back = safeReturn(String(body.return ?? ''), ct.slug);
  const action = String(body.action ?? '');
  const rawIds = body.ids;
  const ids = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  if (!isRowAction(action) || action === 'duplicate') return c.redirect(withFlash(back, 'err', t('content.bulkPickAction')), 302);
  if (ids.length === 0) return c.redirect(withFlash(back, 'err', t('content.bulkPickRows')), 302);

  let done = 0;
  const problems: string[] = [];
  for (const id of ids.slice(0, 200)) {
    const row = await findById(id, true);
    if (!row || row.typeSlug !== ct.slug) continue;
    const res = await applyRowAction(auth, ct, row, action, t);
    if (res.ok) done++;
    else problems.push(`${row.title}: ${res.message}`);
  }
  if (problems.length > 0) {
    return c.redirect(withFlash(back, 'err', `${t.plural('content.bulkDone', done)} ${problems.slice(0, 3).join(' · ')}`), 302);
  }
  return c.redirect(withFlash(back, 'ok', t.plural('content.bulkDone', done)), 302);
});

// Single-row action from the list.
adminContent.post('/content/:type/:id{[0-9]+}/action', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const ct = await getTypeBySlug(c.req.param('type'));
  if (!ct) return notFoundPage(c, auth, t, t('common.unknownType'));
  const body = await c.req.parseBody();
  const back = safeReturn(String(body.return ?? ''), ct.slug);
  const action = String(body.action ?? '');
  const row = await findById(Number(c.req.param('id')), true);
  if (!row || row.typeSlug !== ct.slug || !isRowAction(action)) return c.redirect(withFlash(back, 'err', t('common.notFound')), 302);
  const res = await applyRowAction(auth, ct, row, action, t);
  if (res.ok && res.newId) return c.redirect(withFlash(`/admin/content/${ct.slug}/${res.newId}`, 'ok', res.message), 302);
  return c.redirect(withFlash(back, res.ok ? 'ok' : 'err', res.message), 302);
});

// ── Editor: new ────────────────────────────────────────────────────────

adminContent.get('/content/:type/new', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const ct = await getTypeBySlug(c.req.param('type'));
  if (!ct) return notFoundPage(c, auth, t, t('common.unknownType'));
  if (!allowed(auth, 'create', ct.slug)) return notFoundPage(c, auth, t, t('content.noCreatePermission'), 403);

  const locales = await getConfiguredLocales();
  const localeParam = c.req.query('locale');
  const locale = localeParam && locales.includes(localeParam) ? localeParam : await getDefaultLocale();

  // Creating a translation of an existing row: start from its title + slug.
  let translationOf: number | undefined;
  let defaultTitle = '';
  let defaultSlug = '';
  const sourceId = Number(c.req.query('translationOf') ?? 0);
  if (sourceId) {
    const source = await findById(sourceId, true);
    if (source && source.typeSlug === ct.slug) {
      translationOf = sourceId;
      defaultTitle = source.title;
      defaultSlug = source.slug;
    }
  }

  return c.html(
    <ContentForm
      type={ct}
      t={t}
      fields={{}}
      seo={{}}
      {...pageUser(auth)}
      availableLocales={locales}
      translationOf={translationOf}
      defaultTitle={defaultTitle}
      defaultSlug={defaultSlug}
      defaultLocale={locale}
      flash={readFlash(c)}
      meta={await editorMeta(auth, ct, null, locale)}
    />,
  );
});

// ── Editor: edit ───────────────────────────────────────────────────────

async function loadEditable(c: Context, auth: AuthContext, t: Translator): Promise<{ ct: ContentTypeRow; row: ContentDbRow } | Response> {
  const ct = await getTypeBySlug(c.req.param('type') ?? '');
  if (!ct) return notFoundPage(c, auth, t, t('common.unknownType'));
  const row = await findById(Number(c.req.param('id')), true);
  if (!row || row.typeSlug !== ct.slug) return notFoundPage(c, auth, t, t('common.notFound'));
  if (!allowed(auth, 'read', ct.slug)) return notFoundPage(c, auth, t, t('common.forbidden'), 403);
  if (row.status !== 'published') {
    const ok = row.authorId === auth.user.id
      ? allowed(auth, 'readDrafts', ct.slug)
      : allowed(auth, 'readOthersDrafts', ct.slug);
    if (!ok) return notFoundPage(c, auth, t, t('common.forbidden'), 403);
  }
  return { ct, row };
}
const isPage = (x: { ct: ContentTypeRow; row: ContentDbRow } | Response): x is Response =>
  (x as { ct?: unknown }).ct === undefined;

adminContent.get('/content/:type/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const loaded = await loadEditable(c, auth, t);
  if (isPage(loaded)) return loaded;
  const { ct, row } = loaded;
  return c.html(
    <ContentForm
      type={ct}
      t={t}
      row={row}
      fields={parseObj(row.fields)}
      seo={parseObj(row.seo)}
      ai={parseObj(row.ai)}
      {...pageUser(auth)}
      flash={readFlash(c)}
      siblings={await siblingsOf(row)}
      availableLocales={await getConfiguredLocales()}
      meta={await editorMeta(auth, ct, row, row.locale)}
    />,
  );
});

// ── Editor: save ───────────────────────────────────────────────────────

/** Re-show the editor with what the user typed plus the problems found. */
async function rerender(
  c: Context,
  auth: AuthContext,
  t: Translator,
  ct: ContentTypeRow,
  row: ContentDbRow | null,
  p: ParsedContentForm,
  errors: string[],
  notice?: string,
) {
  const fresh = row ? await findById(row.id, true) : null;
  return c.html(
    <ContentForm
      type={ct}
      t={t}
      row={fresh}
      fields={p.fields}
      seo={p.seo}
      ai={p.ai}
      {...pageUser(auth)}
      flash={notice ? { ok: notice } : undefined}
      errors={errors}
      siblings={fresh ? await siblingsOf(fresh) : []}
      availableLocales={await getConfiguredLocales()}
      translationOf={p.translationOf}
      defaultTitle={p.title}
      defaultSlug={p.slug}
      defaultLocale={p.locale}
      draftTimes={{ publishedAt: p.publishedAt, scheduledAt: p.scheduledAt }}
      meta={await editorMeta(auth, ct, fresh, fresh?.locale ?? p.locale)}
    />,
    422,
  );
}

function isFuture(iso: string): boolean {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getTime() > Date.now() + 30_000;
}

/** Everything that would stop this entry from going live. */
function publishProblems(ct: ContentTypeRow, p: { title: string; fields: Record<string, unknown>; seo: Record<string, unknown> }): ValidationError[] {
  return [...validateFields(p.fields, ct.fieldsSchema.fields), ...validateSeoForPublish(p.seo, p.title)];
}

adminContent.post('/content/:type', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const ct = await getTypeBySlug(c.req.param('type'));
  if (!ct) return notFoundPage(c, auth, t, t('common.unknownType'));
  if (!allowed(auth, 'create', ct.slug)) return notFoundPage(c, auth, t, t('content.noCreatePermission'), 403);

  const p = parseContentForm(await c.req.parseBody({ all: true }), ct.fieldsSchema.fields);
  if (!p.slug) p.slug = slugify(p.title);
  const schema = ct.fieldsSchema.fields;
  const locales = await getConfiguredLocales();
  if (!locales.includes(p.locale)) {
    return rerender(c, auth, t, ct, null, p, [t('errors.localeUnknown')]);
  }
  if (!p.title) return rerender(c, auth, t, ct, null, p, [t('errors.titleRequired')]);

  const canPublish = allowed(auth, 'publish', ct.slug, auth.user.id);
  const wantsSchedule = p.action === 'publish' && canPublish && isFuture(p.scheduledAt);
  const res = await createContent({
    type: ct.slug,
    slug: p.slug,
    locale: p.locale,
    title: p.title,
    fields: p.fields,
    seo: p.seo,
    ai: p.ai,
    status: 'draft',
    authorId: auth.user.id,
    translationOf: p.translationOf,
    scheduledAt: canPublish && isFuture(p.scheduledAt) ? toDbDatetime(p.scheduledAt) : null,
  });
  if (!res.ok) return rerender(c, auth, t, ct, null, p, friendlyErrors(t, res.errors, schema));
  invalidateAndNotify('content.created', ct.slug, p.locale, res.id);
  const back = `/admin/content/${ct.slug}/${res.id}`;
  const row = await findById(res.id, true);
  if (!row) return c.redirect(back, 302);

  if (p.action === 'publish') {
    if (!canPublish) return c.redirect(withFlash(back, 'err', t('content.noPublishPermission')), 302);
    if (wantsSchedule) {
      const seo = withDerivedMeta(p.seo, p.fields);
      const problems = publishProblems(ct, { ...p, seo });
      if (problems.length > 0) {
        await execute('UPDATE `content` SET `scheduledAt` = NULL WHERE `id` = ?', [row.id]);
        return rerender(c, auth, t, ct, row, p, friendlyErrors(t, problems, schema), t('content.savedNotScheduled'));
      }
      if (seo !== p.seo) await execute('UPDATE `content` SET `seo` = ? WHERE `id` = ?', [JSON.stringify(seo), row.id]);
      return c.redirect(withFlash(back, 'ok', t('content.flashScheduled')), 302);
    }
    const pub = await publishRow(auth, row);
    if (!pub.ok) return rerender(c, auth, t, ct, row, p, friendlyErrors(t, pub.errors, schema), t('content.savedNotPublished'));
    return c.redirect(withFlash(back, 'ok', t('content.flashPublished')), 302);
  }
  return c.redirect(withFlash(back, 'ok', t('content.flashCreated')), 302);
});

adminContent.post('/content/:type/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const loaded = await loadEditable(c, auth, t);
  if (isPage(loaded)) return loaded;
  const { ct, row: existing } = loaded;
  const schema = ct.fieldsSchema.fields;
  const id = existing.id;
  const back = `/admin/content/${ct.slug}/${id}`;
  const list = `/admin/content/${ct.slug}`;

  const p = parseContentForm(await c.req.parseBody({ all: true }), schema);

  if (p.action === 'delete' || p.action === 'restore' || p.action === 'purge') {
    const action: RowAction = p.action === 'delete' ? 'trash' : p.action;
    const res = await applyRowAction(auth, ct, existing, action, t);
    if (!res.ok) return c.redirect(withFlash(back, 'err', res.message), 302);
    return c.redirect(withFlash(action === 'restore' ? back : list, 'ok', res.message), 302);
  }

  if (!allowed(auth, 'update', ct.slug, existing.authorId)) {
    return c.redirect(withFlash(back, 'err', t('content.noUpdatePermission')), 302);
  }
  if (existing.status === 'archived') return c.redirect(withFlash(back, 'err', t('content.restoreFirst')), 302);
  if (!p.title) return rerender(c, auth, t, ct, existing, p, [t('errors.titleRequired')]);

  const canPublish = allowed(auth, 'publish', ct.slug, existing.authorId);
  const isPublished = existing.status === 'published';
  const wantsSchedule = !isPublished && p.action === 'publish' && canPublish && isFuture(p.scheduledAt);
  const goingLive = (isPublished && p.action !== 'unpublish') || p.action === 'publish';
  const seo = goingLive ? withDerivedMeta(p.seo, p.fields) : p.seo;

  // A live (or about-to-be-scheduled) entry must stay publishable.
  if ((isPublished && p.action !== 'unpublish') || wantsSchedule) {
    const problems = publishProblems(ct, { ...p, seo });
    if (problems.length > 0) return rerender(c, auth, t, ct, existing, p, friendlyErrors(t, problems, schema));
  }

  const patch: Parameters<typeof updateContent>[1] = { title: p.title, slug: p.slug, fields: p.fields, seo, ai: p.ai };
  if (canPublish) {
    const publishedAt = toDbDatetime(p.publishedAt);
    if (publishedAt && (isPublished || existing.publishedAt)) patch.publishedAt = publishedAt;
    if (!isPublished) patch.scheduledAt = isFuture(p.scheduledAt) ? toDbDatetime(p.scheduledAt) : null;
  }
  const upd = await updateContent(id, patch, auth.user.id);
  if (!upd.ok) return rerender(c, auth, t, ct, existing, p, friendlyErrors(t, upd.errors, schema));
  invalidateAndNotify('content.updated', ct.slug, existing.locale, id);

  if (p.action === 'publish') {
    if (!canPublish) return c.redirect(withFlash(back, 'err', t('content.noPublishPermission')), 302);
    if (wantsSchedule) return c.redirect(withFlash(back, 'ok', t('content.flashScheduled')), 302);
    const pub = await publishRow(auth, upd.row);
    if (!pub.ok) return rerender(c, auth, t, ct, upd.row, p, friendlyErrors(t, pub.errors, schema), t('content.savedNotPublished'));
    return c.redirect(withFlash(back, 'ok', t('content.flashPublished')), 302);
  }
  if (p.action === 'unpublish') {
    const res = await applyRowAction(auth, ct, upd.row, 'unpublish', t);
    return c.redirect(withFlash(back, res.ok ? 'ok' : 'err', res.message), 302);
  }
  return c.redirect(withFlash(back, 'ok', isPublished ? t('content.flashUpdated') : t('content.flashSaved')), 302);
});

// Duplicate from the editor (copies the saved version).
adminContent.post('/content/:type/:id{[0-9]+}/duplicate', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const loaded = await loadEditable(c, auth, t);
  if (isPage(loaded)) return loaded;
  const { ct, row } = loaded;
  const res = await applyRowAction(auth, ct, row, 'duplicate', t);
  if (!res.ok || !res.newId) return c.redirect(withFlash(`/admin/content/${ct.slug}/${row.id}`, 'err', res.message), 302);
  return c.redirect(withFlash(`/admin/content/${ct.slug}/${res.newId}`, 'ok', res.message), 302);
});

// ── Revisions ──────────────────────────────────────────────────────────

interface RevisionRow { revision: number; snapshot: unknown; reason: string | null; createdAt: unknown; authorName: string | null }

function preview(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

adminContent.get('/content/:type/:id{[0-9]+}/revisions', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const loaded = await loadEditable(c, auth, t);
  if (isPage(loaded)) return loaded;
  const { ct, row } = loaded;
  const revs = await query<RevisionRow>(
    `SELECT r.\`revision\`, r.\`snapshot\`, r.\`reason\`, r.\`createdAt\`, u.\`displayName\` AS authorName
       FROM \`contentRevisions\` r LEFT JOIN \`users\` u ON u.\`id\` = r.\`authorId\`
      WHERE r.\`contentId\` = ? ORDER BY r.\`revision\` DESC LIMIT 100`,
    [row.id],
  );
  const canRestore = allowed(auth, 'update', ct.slug, row.authorId) && row.status !== 'archived';
  const back = `/admin/content/${ct.slug}/${row.id}`;
  const reasons = ['create', 'update', 'publish', 'unpublish', 'restore'];
  return c.html(
    <AdminPage title={t('revisions.title')} active={ct.slug} t={t} {...pageUser(auth)}>
      <div class="top">
        <h1>{t('revisions.heading', { title: row.title })}</h1>
        <a class="btn sec" href={back}>{t('revisions.backToEditor')}</a>
      </div>
      <Flash flash={readFlash(c)} />
      <div class="card">
        {revs.length === 0 ? <div class="muted">{t('revisions.empty')}</div> : (
          <table>
            <thead>
              <tr><th>{t('revisions.colWhen')}</th><th>{t('revisions.colWho')}</th><th>{t('revisions.colWhat')}</th><th></th></tr>
            </thead>
            <tbody>
              {revs.map((r) => {
                const snap = parseObj(r.snapshot);
                const fields = parseObj(snap.fields);
                const isCurrent = r.revision === row.revision;
                return (
                  <tr>
                    <td style="white-space:nowrap;vertical-align:top"><DateTime value={r.createdAt} /></td>
                    <td class="muted" style="vertical-align:top">{r.authorName ?? '—'}</td>
                    <td>
                      <details>
                        <summary style="cursor:pointer">
                          {r.reason && reasons.includes(r.reason) ? t(`revisions.reason.${r.reason}`) : (r.reason ?? '')}
                          {' — '}<strong>{String(snap.title ?? '')}</strong>
                          {isCurrent ? <span class="badge b-pub" style="margin-left:8px">{t('revisions.current')}</span> : null}
                        </summary>
                        <dl class="kv" style="margin:10px 0 0;font-size:12px">
                          {ct.fieldsSchema.fields.map((def) => (
                            <>
                              <dt>{def.label ?? def.name}</dt>
                              <dd style="white-space:pre-wrap">{preview(fields[def.name])}</dd>
                            </>
                          ))}
                        </dl>
                      </details>
                    </td>
                    <td style="vertical-align:top;text-align:right">
                      {canRestore && !isCurrent ? (
                        <form method="post" action={`${back}/revisions/${r.revision}/restore`} style="margin:0">
                          <button class="btn sm sec" type="submit" data-confirm={t('revisions.confirmRestore')}>{t('revisions.restore')}</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </AdminPage>,
  );
});

adminContent.post('/content/:type/:id{[0-9]+}/revisions/:rev{[0-9]+}/restore', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const loaded = await loadEditable(c, auth, t);
  if (isPage(loaded)) return loaded;
  const { ct, row } = loaded;
  const back = `/admin/content/${ct.slug}/${row.id}`;
  if (!allowed(auth, 'update', ct.slug, row.authorId) || row.status === 'archived') {
    return c.redirect(withFlash(back, 'err', t('content.noUpdatePermission')), 302);
  }
  const rev = await queryOne<{ snapshot: unknown }>(
    'SELECT `snapshot` FROM `contentRevisions` WHERE `contentId` = ? AND `revision` = ?',
    [row.id, Number(c.req.param('rev'))],
  );
  if (!rev) return c.redirect(withFlash(`${back}/revisions`, 'err', t('common.notFound')), 302);
  const snap = parseObj(rev.snapshot);
  const restored = {
    title: String(snap.title ?? row.title),
    fields: parseObj(snap.fields),
    seo: parseObj(snap.seo),
    ai: parseObj(snap.ai),
  };
  // Don't let a restore leave a live entry in an unpublishable state.
  if (row.status === 'published') {
    const problems = publishProblems(ct, restored);
    if (problems.length > 0) {
      return c.redirect(withFlash(`${back}/revisions`, 'err', friendlyErrors(t, problems, ct.fieldsSchema.fields).join(' ')), 302);
    }
  }
  const upd = await updateContent(row.id, restored, auth.user.id);
  if (!upd.ok) return c.redirect(withFlash(`${back}/revisions`, 'err', friendlyErrors(t, upd.errors, ct.fieldsSchema.fields).join(' ')), 302);
  invalidateAndNotify('content.updated', ct.slug, row.locale, row.id);
  return c.redirect(withFlash(back, 'ok', t('revisions.flashRestored')), 302);
});
