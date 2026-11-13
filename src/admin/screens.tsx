// Settings screens: the tabbed settings forms and the per-key editor. Server-rendered; forms POST to handlers that call the
// store/writer functions directly (already inside an authed session).

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import { AdminPage } from './layout.js';
import { query } from '../db/client.js';
import type { AuthContext } from '../auth/middleware.js';
import { can } from '../permissions/check.js';
import { getT, type Translator } from './i18n/index.js';
import { getAllSettings, setSetting, invalidateSettingsCache, deleteSetting, isSensitiveSettingKey } from '../settings/store.js';
import { listTypes } from '../content/types.js';
import { config } from '../config.js';
import { getEmailBackend, escapeHtml } from '../email/adapter.js';
import { invalidate } from '../cache/deps.js';
import { fireEvent } from '../webhooks/dispatch.js';
import { MEDIA_PICKER_SCRIPT } from './contentEditor.js';

export const adminScreens = new Hono();

function gate(c: Context): AuthContext | Response {
  const auth = c.get('auth');
  if (!auth) return c.redirect('/admin/login', 302);
  return auth;
}
// Perry workaround: `instanceof Response` is always false for native fetch
// handles, so discriminate gate()'s union by a field only AuthContext carries.
// Type guard → callers still narrow to AuthContext. Identical on Node/Bun.
function notAuth(x: AuthContext | Response): x is Response {
  return (x as AuthContext).user === undefined;
}
function need(c: Context, auth: AuthContext, cap: Parameters<typeof can>[1]): boolean {
  return can({ userId: auth.user.id, caps: auth.role.capabilities }, cap);
}

// ── Settings ───────────────────────────────────────────────────────────

// ── Settings index: group by prefix (i18n, site, seo, …). No JSON dump. ──

function describeShape(v: unknown, t: Translator): string {
  if (v === null || v === undefined) return t('settings.describe.empty');
  if (Array.isArray(v)) {
    if (v.length === 0) return t('settings.describe.emptyList');
    if (v.every((x) => typeof x === 'string')) return t.plural('settings.describe.tags', v.length);
    if (v.every((x) => typeof x === 'object' && x !== null && !Array.isArray(x))) return t.plural('settings.describe.entries', v.length);
    return t.plural('settings.describe.items', v.length);
  }
  if (typeof v === 'object') {
    const leaves = countLeaves(v);
    return t.plural('settings.describe.fields', leaves);
  }
  if (typeof v === 'string') {
    const s = v as string;
    return s.length === 0 ? t('settings.describe.empty') : s.length <= 40 ? `"${s}"` : t('settings.describe.chars', { n: s.length });
  }
  return String(v);
}

function countLeaves(o: unknown): number {
  if (o === null || o === undefined) return 0;
  if (typeof o !== 'object') return 1;
  if (Array.isArray(o)) return o.reduce<number>((n, x) => n + countLeaves(x), 0);
  return Object.values(o as Record<string, unknown>).reduce<number>((n, x) => n + countLeaves(x), 0);
}

// ── Settings: friendly tabbed forms; the raw key list lives under Advanced ──

const SETTINGS_TABS = ['general', 'seo', 'email', 'maintenance', 'advanced'] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

async function saveSetting(key: string, value: unknown, auth: AuthContext): Promise<void> {
  await setSetting(key, value, auth.user.id);
  invalidate([`setting:${key}`]);
  invalidate(['settings:all']);
  void fireEvent('setting.changed', { key }, [`setting:${key}`, 'settings:all']);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

adminScreens.get('/settings', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!need(c, auth, 'manageSettings')) {
    return c.html(<AdminPage title={t('common.forbidden')} t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('common.forbidden')}</AdminPage>, 403);
  }
  const all = await getAllSettings();
  const tabParam = c.req.query('tab') ?? 'general';
  const tab: SettingsTab = (SETTINGS_TABS as readonly string[]).includes(tabParam) ? (tabParam as SettingsTab) : 'general';
  const ok = c.req.query('ok');
  const err = c.req.query('err');

  const locales = Array.isArray(all['site.locales']) ? (all['site.locales'] as unknown[]).map(String) : ['en'];
  const defaultLocale = str(all['site.defaultLocale']) || locales[0] || 'en';
  const hiddenTypes = Array.isArray(all['admin.hiddenTypes']) ? (all['admin.hiddenTypes'] as unknown[]).map(String) : [];
  const types = (await listTypes()).filter((ct) => !['form', 'errorPage'].includes(ct.slug));
  const org = (all['seo.organizationSchema'] && typeof all['seo.organizationSchema'] === 'object'
    ? all['seo.organizationSchema'] : {}) as Record<string, unknown>;
  const maintenanceOn = all['site.maintenance'] === true;
  const previewToken = str(all['site.previewToken']);
  const siteUrl = str(all['site.url']).replace(/\/+$/, '');
  const previewLink = siteUrl && previewToken ? `${siteUrl}/?preview=${encodeURIComponent(previewToken)}` : null;

  // Advanced: every key, grouped by its prefix.
  const groups = new Map<string, { key: string; value: unknown }[]>();
  for (const key of Object.keys(all).sort()) {
    const prefix = key.includes('.') ? key.slice(0, key.indexOf('.')) : 'general';
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push({ key, value: all[key] });
  }

  return c.html(
    <AdminPage title={t('settings.title')} active="settings" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top"><h1>{t('settings.title')}</h1></div>
      <div class="tabs">
        {SETTINGS_TABS.map((s) => (
          <a href={`/admin/settings?tab=${s}`} class={s === tab ? 'on' : ''}>{t(`settings.tab.${s}`)}</a>
        ))}
      </div>
      {ok ? <div class="ok" role="status">{ok}</div> : null}
      {err ? <div class="err" role="alert">{err}</div> : null}

      {tab === 'general' ? (
        <form method="post" action="/admin/settings-form/general" class="card" style="max-width:720px" data-guard="1">
          <label for="site_name" style="margin-top:0">{t('settings.siteName')}</label>
          <input type="text" name="site_name" id="site_name" value={str(all['site.name'])} required />
          <label for="site_tagline">{t('settings.tagline')}</label>
          <input type="text" name="site_tagline" id="site_tagline" value={str(all['site.tagline'])} />
          <div class="help">{t('settings.taglineHelp')}</div>
          <label for="site_url">{t('settings.siteUrl')}</label>
          <input type="url" name="site_url" id="site_url" value={str(all['site.url'])} required placeholder="https://www.example.com" />
          <div class="help">{t('settings.siteUrlHelp')}</div>
          <label for="site_locales">{t('settings.languages')}</label>
          <input type="text" name="site_locales" id="site_locales" value={locales.join(', ')} required pattern="[A-Za-z, \-]+" />
          <div class="help">{t('settings.languagesHelp')}</div>
          <label for="site_defaultLocale">{t('settings.defaultLanguage')}</label>
          <select name="site_defaultLocale" id="site_defaultLocale" style="max-width:200px">
            {locales.map((l) => <option value={l} selected={l === defaultLocale}>{l}</option>)}
          </select>
          <div class="help">{t('settings.defaultLanguageHelp')}</div>
          <label>{t('settings.menuTypes')}</label>
          <div style="display:flex;flex-wrap:wrap;gap:2px 18px">
            {types.map((ct) => (
              <label class="check">
                <input type="checkbox" name="shown_types" value={ct.slug} checked={!hiddenTypes.includes(ct.slug)} /> {ct.labelPlural}
              </label>
            ))}
          </div>
          <div class="help">{t('settings.menuTypesHelp')}</div>
          <div style="margin-top:18px"><button class="btn" type="submit">{t('settings.saveChanges')}</button></div>
        </form>
      ) : null}

      {tab === 'seo' ? (
        <form method="post" action="/admin/settings-form/seo" class="card" style="max-width:720px" data-guard="1">
          <label for="seo_robots" style="margin-top:0">{t('settings.searchVisibility')}</label>
          <select name="seo_robots" id="seo_robots">
            <option value="index,follow" selected={!str(all['seo.robots']).includes('noindex')}>{t('settings.searchVisible')}</option>
            <option value="noindex,nofollow" selected={str(all['seo.robots']).includes('noindex')}>{t('settings.searchHidden')}</option>
          </select>
          <div class="help">{t('settings.searchVisibilityHelp')}</div>
          <h3 style="margin-top:22px">{t('settings.organization')}</h3>
          <div class="help" style="margin-top:0">{t('settings.organizationHelp')}</div>
          <label for="org_name">{t('settings.orgName')}</label>
          <input type="text" name="org_name" id="org_name" value={str(org.name)} />
          <label for="org_url">{t('settings.orgUrl')}</label>
          <input type="url" name="org_url" id="org_url" value={str(org.url)} placeholder={siteUrl} />
          <label for="org_logo">{t('settings.orgLogo')}</label>
          <input type="url" name="org_logo" id="org_logo" value={str(org.logo)} placeholder="https://…/logo.png" />
          <div style="margin-top:18px"><button class="btn" type="submit">{t('settings.saveChanges')}</button></div>
        </form>
      ) : null}

      {tab === 'email' ? (
        <div class="card" style="max-width:720px">
          <dl class="kv">
            <dt>{t('settings.emailDelivery')}</dt>
            <dd>
              {config.email.backend === 'log'
                ? <span class="badge b-arch">{t('settings.emailOff')}</span>
                : <span class="badge b-pub">{t('settings.emailOn', { backend: config.email.backend })}</span>}
            </dd>
            <dt>{t('settings.emailFrom')}</dt>
            <dd>{config.email.fromName} &lt;{config.email.from}&gt;</dd>
          </dl>
          <div class="help">
            {config.email.backend === 'log' ? t('settings.emailOffHelp') : t('settings.emailOnHelp')}
          </div>
          <form method="post" action="/admin/settings-form/email-test" style="margin-top:16px">
            <button class="btn sec" type="submit">{t('settings.emailSendTest', { email: auth.user.email })}</button>
          </form>
        </div>
      ) : null}

      {tab === 'maintenance' ? (
        <>
          <div class="card" style={`max-width:720px;margin-bottom:14px;${maintenanceOn ? 'border-color:var(--acc)' : ''}`}>
            <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
              <div style="flex:1;min-width:240px">
                <div style="font-weight:600;font-size:14px">
                  {t('dashboard.maintenanceMode')}{' '}
                  <span style={`color:${maintenanceOn ? 'var(--acc2)' : 'var(--ok)'}`}>{maintenanceOn ? t('dashboard.on') : t('dashboard.off')}</span>
                </div>
                <div class="help">{maintenanceOn ? t('dashboard.maintenanceOnDesc') : t('dashboard.maintenanceOffDesc')}</div>
              </div>
              <form method="post" action="/admin/maintenance/toggle" style="margin:0">
                <button class={maintenanceOn ? 'btn' : 'btn sec'} type="submit"
                  data-confirm={maintenanceOn ? undefined : t('settings.maintenanceConfirm')}>
                  {maintenanceOn ? t('dashboard.turnOff') : t('dashboard.turnOn')}
                </button>
              </form>
            </div>
            {previewLink ? (
              <div style="margin-top:14px">
                <div class="help">{t('dashboard.previewLinkLabel')}</div>
                <code class="secret">{previewLink}</code>
                <div class="toolbar">
                  <button type="button" class="btn sm sec" data-copy={previewLink} data-copied={t('common.copied')}>{t('common.copy')}</button>
                  <form method="post" action="/admin/maintenance/rotate-token" style="margin:0">
                    <button class="btn sm sec" type="submit" title={t('dashboard.rotateTitle')} data-confirm={t('dashboard.rotateTitle')}>{t('dashboard.rotate')}</button>
                  </form>
                </div>
              </div>
            ) : (
              <form method="post" action="/admin/maintenance/rotate-token" style="margin:14px 0 0">
                <button class="btn sm sec" type="submit">{t('settings.createPreviewLink')}</button>
              </form>
            )}
          </div>
          <form method="post" action="/admin/settings-form/maintenance" class="card" style="max-width:720px" data-guard="1">
            <h3>{t('settings.maintenanceMessage')}</h3>
            <label for="m_title">{t('dashboard.visitorTitle')}</label>
            <input type="text" name="m_title" id="m_title" value={str(all['site.maintenanceTitle'])} />
            <label for="m_message">{t('dashboard.visitorBody')}</label>
            <textarea name="m_message" id="m_message" rows={4}>{str(all['site.maintenanceMessage'])}</textarea>
            <div style="margin-top:18px"><button class="btn" type="submit">{t('settings.saveChanges')}</button></div>
          </form>
        </>
      ) : null}

      {tab === 'advanced' ? (
        <>
          <div class="help" style="margin:0 0 14px">{t('settings.advancedIntro')}</div>
          {[...groups.entries()].map(([group, items]) => (
            <div class="card" style="margin-bottom:14px">
              <h3 style="margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:var(--mut)">{group}</h3>
              <table>
                <tbody>
                  {items.map((it) => (
                    <tr>
                      <td style="width:40%">
                        <a href={`/admin/settings/${encodeURIComponent(it.key)}`}>{it.key}</a>
                      </td>
                      <td class="muted">{isSensitiveSettingKey(it.key) ? '••••••' : describeShape(it.value, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <form method="post" action="/admin/settings-form/add" class="card">
            <h3>{t('settings.addSetting')}</h3>
            <div class="toolbar" style="margin-top:10px">
              <input type="text" name="key" required pattern="[A-Za-z][A-Za-z0-9_.\-]*" maxlength={128} placeholder={t('settings.addKeyPlaceholder')} style="min-width:240px" />
              <input type="text" name="value" placeholder={t('settings.value')} style="min-width:240px;flex:1" />
              <button class="btn sec" type="submit">{t('common.add')}</button>
            </div>
          </form>
        </>
      ) : null}
    </AdminPage>,
  );
});

adminScreens.post('/settings-form/:tab', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const tab = c.req.param('tab');
  const back = (name: string) => `/admin/settings?tab=${name}`;
  if (!need(c, auth, 'manageSettings')) return c.redirect(`${back('general')}&err=${encodeURIComponent(t('common.forbidden'))}`, 302);
  const body = await c.req.parseBody({ all: true });
  const one = (k: string): string => {
    const v = body[k];
    return String((Array.isArray(v) ? v[v.length - 1] : v) ?? '').trim();
  };
  const saved = (name: string) => c.redirect(`${back(name)}&ok=${encodeURIComponent(t('settings.flashSaved'))}`, 302);
  const failed = (name: string, message: string) => c.redirect(`${back(name)}&err=${encodeURIComponent(message)}`, 302);

  if (tab === 'general') {
    const locales = [...new Set(one('site_locales').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    if (locales.length === 0 || !locales.every((l) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(l))) {
      return failed('general', t('settings.errLanguages'));
    }
    if (!/^https?:\/\/[^\s]+$/.test(one('site_url'))) return failed('general', t('settings.errSiteUrl'));
    if (!one('site_name')) return failed('general', t('settings.errSiteName'));
    // Refuse to drop a language that still has content: it would vanish from the admin.
    const used = await query<{ locale: string }>("SELECT DISTINCT `locale` FROM `content` WHERE `status` != 'archived'");
    const orphaned = used.map((r) => r.locale).filter((l) => !locales.includes(l));
    if (orphaned.length > 0) return failed('general', t('settings.errLanguageInUse', { locales: orphaned.join(', ') }));
    const def = locales.includes(one('site_defaultLocale')) ? one('site_defaultLocale') : locales[0]!;
    const shownRaw = body.shown_types;
    const shown = (Array.isArray(shownRaw) ? shownRaw : shownRaw ? [shownRaw] : []).map(String);
    const hidden = (await listTypes()).map((ct) => ct.slug).filter((s) => !['form', 'errorPage'].includes(s) && !shown.includes(s));
    await saveSetting('site.name', one('site_name'), auth);
    await saveSetting('site.tagline', one('site_tagline'), auth);
    await saveSetting('site.url', one('site_url').replace(/\/+$/, ''), auth);
    await saveSetting('site.locales', locales, auth);
    await saveSetting('site.defaultLocale', def, auth);
    await saveSetting('admin.hiddenTypes', hidden, auth);
    return saved('general');
  }
  if (tab === 'seo') {
    const all = await getAllSettings();
    const prev = (all['seo.organizationSchema'] && typeof all['seo.organizationSchema'] === 'object'
      ? all['seo.organizationSchema'] : { '@type': 'Organization' }) as Record<string, unknown>;
    const org: Record<string, unknown> = { ...prev, name: one('org_name') };
    if (one('org_url')) org.url = one('org_url'); else delete org.url;
    if (one('org_logo')) org.logo = one('org_logo'); else delete org.logo;
    await saveSetting('seo.robots', one('seo_robots') === 'noindex,nofollow' ? 'noindex,nofollow' : 'index,follow', auth);
    await saveSetting('seo.organizationSchema', org, auth);
    return saved('seo');
  }
  if (tab === 'maintenance') {
    await saveSetting('site.maintenanceTitle', one('m_title'), auth);
    await saveSetting('site.maintenanceMessage', one('m_message'), auth);
    return saved('maintenance');
  }
  if (tab === 'email-test') {
    try {
      const name = str((await getAllSettings())['site.name']) || 'Skelpo CMS';
      await getEmailBackend().send({
        to: auth.user.email,
        subject: t('settings.emailTestSubject', { site: name }),
        text: t('settings.emailTestBody', { site: name }),
        html: `<p>${escapeHtml(t('settings.emailTestBody', { site: name }))}</p>`,
      });
    } catch (e) {
      return failed('email', t('settings.emailTestFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
    return c.redirect(`${back('email')}&ok=${encodeURIComponent(
      config.email.backend === 'log' ? t('settings.emailTestLogged') : t('settings.emailTestSent', { email: auth.user.email }),
    )}`, 302);
  }
  if (tab === 'add') {
    const key = one('key');
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) return failed('advanced', t('settings.errKey'));
    const all = await getAllSettings();
    if (key in all) return failed('advanced', t('settings.errKeyExists', { key }));
    await saveSetting(key, one('value'), auth);
    return c.redirect(`/admin/settings/${encodeURIComponent(key)}?ok=${encodeURIComponent(t('settings.flashSaved'))}`, 302);
  }
  return c.redirect(back('general'), 302);
});

// ── Settings: per-key edit page (shape-aware UI, no JSON) ────────────────

interface FlatLeaf { path: string; value: string; multiline: boolean }

/** Walk a nested object and yield every leaf with its dot-path. */
function flattenLeaves(o: unknown, prefix = ''): FlatLeaf[] {
  if (o === null || o === undefined) return prefix ? [{ path: prefix, value: '', multiline: false }] : [];
  if (typeof o !== 'object') {
    const s = String(o);
    return [{ path: prefix, value: s, multiline: s.includes('\n') || s.length > 80 }];
  }
  if (Array.isArray(o)) {
    return o.flatMap((v, i) => flattenLeaves(v, prefix ? `${prefix}.${i}` : String(i)));
  }
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    flattenLeaves(v, prefix ? `${prefix}.${k}` : k),
  );
}

/** Read a dot-path from a value (used to keep leaf types stable on save). */
function getPath(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Set a dot-path on a target object, coercing array indexes from numeric segments. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const nextNumeric = /^\d+$/.test(parts[i + 1]!);
    if (!(k in cur) || typeof cur[k] !== 'object' || cur[k] === null) {
      cur[k] = nextNumeric ? [] : {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Settings values that hold a media id (e.g. `page.heroes.news.image`,
 *  `footer.awards[].image`) get the visual media picker instead of a number
 *  input — the editor never has to look an id up in the library. */
const IMAGE_FIELD_RE = /^(image|logo|photo|heroimage|icon|thumbnail|cover|bild)$/i;
const isImageField = (path: string) => IMAGE_FIELD_RE.test(path.split('.').pop() ?? '');

const ImageField: FC<{ name: string; value: string; t: Translator }> = ({ name, value, t }) => (
  <div
    class="skelpo-imgfield"
    style="display:flex;gap:14px;align-items:flex-start;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:12px"
  >
    <div
      class="skelpo-imgfield-preview"
      style="width:96px;height:96px;background:var(--bg);border:1px solid var(--line);border-radius:6px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0"
    >
      {value ? (
        <img src={`/api/v1/media/${value}/raw`} alt="" style="width:100%;height:100%;object-fit:cover;display:block" />
      ) : (
        <span class="muted" style="font-size:11px">{t('editor.noImage')}</span>
      )}
    </div>
    <div style="flex:1;min-width:0">
      <div class="muted" style="font-size:11px;margin-bottom:8px">
        {value ? t('editor.mediaRef', { id: value }) : t('editor.noImageSelected')}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button type="button" class="btn sm" onclick={`skelpoOpenMediaPicker('${name}')`}>
          {value ? t('editor.change') : t('editor.pickImage')}
        </button>
        {value ? (
          <button type="button" class="btn sm sec" onclick={`skelpoClearMediaField('${name}')`}>{t('editor.clear')}</button>
        ) : null}
      </div>
      <input type="hidden" name={name} value={value} data-skelpo-imgfield-input={name} />
    </div>
  </div>
);

function shapeOf(v: unknown): 'string' | 'multiline' | 'number' | 'boolean' | 'tags' | 'repeater' | 'tree' | 'empty' {
  if (v === null || v === undefined) return 'empty';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return v.length > 80 || v.includes('\n') ? 'multiline' : 'string';
  if (Array.isArray(v)) {
    if (v.length === 0) return 'tags';
    if (v.every((x) => typeof x === 'string')) return 'tags';
    if (v.every((x) => typeof x === 'object' && x !== null && !Array.isArray(x))) return 'repeater';
    return 'tree';
  }
  return 'tree';
}

adminScreens.get('/settings/:keyName', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const keyName = decodeURIComponent(c.req.param('keyName'));
  const all = await getAllSettings();
  if (!(keyName in all)) {
    return c.html(<AdminPage title={t('common.notFound')} t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('settings.notFound', { key: keyName })}</AdminPage>, 404);
  }
  const value = all[keyName];
  const shape = shapeOf(value);
  const flash = c.req.query('ok') ? { ok: c.req.query('ok')! } : undefined;

  return c.html(
    <AdminPage title={keyName} active="settings" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1 style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:18px">{keyName}</h1>
        <a class="btn sec" href="/admin/settings?tab=advanced">{t('settings.allSettings')}</a>
      </div>
      <div class="muted" style="margin-bottom:14px;font-size:12px">{t(`settings.shape.${shape}`)}</div>
      {flash?.ok ? <div class="ok">{flash.ok}</div> : null}
      <form method="post" action={`/admin/settings/${encodeURIComponent(keyName)}`} class="card">
        <input type="hidden" name="shape" value={shape} />
        {shape === 'string' ? (
          <div><label>{t('settings.value')}</label><input type="text" name="v" value={String(value ?? '')} /></div>
        ) : null}
        {shape === 'multiline' ? (
          <div><label>{t('settings.value')}</label><textarea name="v" rows={8}>{String(value ?? '')}</textarea></div>
        ) : null}
        {shape === 'number' ? (
          <div><label>{t('settings.value')}</label><input type="number" name="v" value={String(value ?? '')} /></div>
        ) : null}
        {shape === 'boolean' ? (
          <div><label>{t('settings.value')}</label>
            <select name="v">
              <option value="false" selected={value !== true}>{t('common.no')}</option>
              <option value="true" selected={value === true}>{t('common.yes')}</option>
            </select>
          </div>
        ) : null}
        {shape === 'tags' ? (
          <div>
            <label>{t('settings.itemsOnePerLine')}</label>
            <textarea name="v" rows={Math.min(20, Math.max(3, (value as string[]).length + 1))}>
              {(value as string[]).join('\n')}
            </textarea>
            <div class="muted" style="font-size:12px;margin-top:6px">{t.plural('common.items', (value as string[]).length)}</div>
          </div>
        ) : null}
        {shape === 'repeater' ? <RepeaterEditor value={value as Record<string, unknown>[]} t={t} /> : null}
        {shape === 'tree' ? <TreeEditor value={value as Record<string, unknown>} t={t} /> : null}
        {shape === 'empty' ? (
          <div class="muted">
            {t('settings.emptyDelete')}{' '}
            <button type="submit" class="btn sm sec" formaction={`/admin/settings/${encodeURIComponent(keyName)}/delete`} formnovalidate>
              {t('settings.deleteSetting')}
            </button>
          </div>
        ) : null}
        <div style="margin-top:18px;display:flex;gap:8px">
          <button class="btn" type="submit">{t('settings.save')}</button>
          <a class="btn sec" href="/admin/settings?tab=advanced">{t('settings.cancel')}</a>
        </div>
      </form>
      {/* Media picker for image-valued settings (same dialog as the content editor) */}
      <script
        dangerouslySetInnerHTML={{
          __html: `window.SKELPO_I18N=${JSON.stringify({
            pickTitle: t('media.pickTitle'),
            close: t('media.close'),
            loading: t('media.loading'),
            mediaRef: t('editor.mediaRef'),
            noImage: t('editor.noImage'),
            noImageSelected: t('editor.noImageSelected'),
          })};`,
        }}
      />
      <script dangerouslySetInnerHTML={{ __html: MEDIA_PICKER_SCRIPT }} />
    </AdminPage>,
  );
});

const RepeaterEditor: FC<{ value: Record<string, unknown>[]; t: Translator }> = ({ value, t }) => {
  if (value.length === 0) return <div class="muted">{t('settings.noEntries')}</div>;
  const fieldNames = Array.from(new Set(value.flatMap((row) => Object.keys(row))));
  return (
    <>
      <input type="hidden" name="rep_count" value={String(value.length)} />
      {value.map((row, i) => (
        <div class="card" style="background:var(--panel2);margin-bottom:10px;padding:14px">
          <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">#{i + 1}</div>
          {fieldNames.map((field) => {
            const v = row[field];
            const isMulti = typeof v === 'string' && (v.includes('\n') || v.length > 80);
            const name = `rep_${i}_${field}`;
            return (
              <div>
                <label>{field}</label>
                {isImageField(field) ? (
                  <ImageField name={name} value={String(v ?? '')} t={t} />
                ) : isMulti ? (
                  <textarea name={name} rows={3}>{String(v ?? '')}</textarea>
                ) : (
                  <input type="text" name={name} value={String(v ?? '')} />
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div class="muted" style="font-size:12px;margin-top:4px">{t('settings.editExistingOnly')}</div>
    </>
  );
};

const TreeEditor: FC<{ value: Record<string, unknown>; t: Translator }> = ({ value, t }) => {
  const leaves = flattenLeaves(value);
  // Group by top-level segment so big i18n bundles render as collapsed cards.
  const groups = new Map<string, FlatLeaf[]>();
  for (const leaf of leaves) {
    const top = leaf.path.split('.')[0]!;
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top)!.push(leaf);
  }
  return (
    <>
      <input type="hidden" name="tree_count" value={String(leaves.length)} />
      {[...groups.entries()].map(([groupName, items]) => (
        <details style="background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:12px 14px;margin-bottom:8px" open={leaves.length < 50}>
          <summary style="cursor:pointer;font-weight:600;color:var(--acc2)">
            {groupName} <span class="muted" style="font-weight:400;font-size:12px">({t.plural('common.fields', items.length)})</span>
          </summary>
          <div style="margin-top:12px">
            {items.map((leaf) => (
              <div>
                <label style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px">{leaf.path}</label>
                {isImageField(leaf.path) ? (
                  <ImageField name={`leaf_${leaf.path}`} value={leaf.value} t={t} />
                ) : leaf.multiline ? (
                  <textarea name={`leaf_${leaf.path}`} rows={3}>{leaf.value}</textarea>
                ) : (
                  <input type="text" name={`leaf_${leaf.path}`} value={leaf.value} />
                )}
              </div>
            ))}
          </div>
        </details>
      ))}
    </>
  );
};

adminScreens.post('/settings/:keyName', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!need(c, auth, 'manageSettings')) {
    return c.redirect('/admin/settings?ok=' + encodeURIComponent(t('common.forbidden')), 302);
  }
  const keyName = decodeURIComponent(c.req.param('keyName'));
  const body = await c.req.parseBody();
  const shape = String(body.shape ?? 'string');
  let newValue: unknown;

  switch (shape) {
    case 'string':
    case 'multiline':
      newValue = String(body.v ?? '');
      break;
    case 'number':
      newValue = body.v === '' ? null : Number(body.v);
      break;
    case 'boolean':
      newValue = String(body.v) === 'true';
      break;
    case 'tags':
      newValue = String(body.v ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      break;
    case 'repeater': {
      const all = await getAllSettings();
      const original = all[keyName] as Record<string, unknown>[];
      const count = Number(body.rep_count ?? 0);
      const result: Record<string, unknown>[] = [];
      for (let i = 0; i < count; i++) {
        const orig = original[i] ?? {};
        const row: Record<string, unknown> = { ...orig };
        for (const field of Object.keys(orig)) {
          const v = body[`rep_${i}_${field}`];
          if (v !== undefined) {
            const prev = orig[field];
            // Preserve number types if the original was numeric.
            if (typeof prev === 'number') row[field] = Number(v);
            else if (typeof prev === 'boolean') row[field] = String(v) === 'true';
            else row[field] = String(v);
          }
        }
        result.push(row);
      }
      newValue = result;
      break;
    }
    case 'tree': {
      const all = await getAllSettings();
      const original = all[keyName];
      const result: Record<string, unknown> = {};
      for (const [field, raw] of Object.entries(body)) {
        if (!field.startsWith('leaf_')) continue;
        const path = field.slice('leaf_'.length);
        // Preserve the original leaf type — media ids stay numbers, not "141".
        const prev = getPath(original, path);
        const str = String(raw);
        const value =
          typeof prev === 'number' && str.trim() !== '' && !Number.isNaN(Number(str)) ? Number(str)
          : typeof prev === 'boolean' ? str === 'true'
          : str;
        setPath(result, path, value);
      }
      newValue = result;
      break;
    }
    default:
      newValue = String(body.v ?? '');
  }

  await setSetting(keyName, newValue, auth.user.id);
  invalidate([`setting:${keyName}`]);
  invalidateSettingsCache();
  invalidate(['settings:all']);
  void fireEvent('setting.changed', { key: keyName }, [`setting:${keyName}`, 'settings:all']);
  return c.redirect(`/admin/settings/${encodeURIComponent(keyName)}?ok=${encodeURIComponent(t('content.flashSaved'))}`, 302);
});

adminScreens.post('/settings/:keyName/delete', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!need(c, auth, 'manageSettings')) {
    return c.redirect('/admin/settings?ok=' + encodeURIComponent(t('common.forbidden')), 302);
  }
  const keyName = decodeURIComponent(c.req.param('keyName'));
  await deleteSetting(keyName);
  invalidate([`setting:${keyName}`]);
  invalidateSettingsCache();
  invalidate(['settings:all']);
  void fireEvent('setting.changed', { key: keyName, deleted: true }, [`setting:${keyName}`, 'settings:all']);
  return c.redirect('/admin/settings?tab=advanced&ok=' + encodeURIComponent(t('content.flashSaved')), 302);
});
