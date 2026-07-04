// Admin UI routes (HTMX, server-rendered). Auth is cookie-session based;
// unauthenticated requests to protected pages redirect to /admin/login.

import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { AdminPage, StatusBadge } from './layout.js';
import { adminStatic } from './static.js';
import { verifyPassword, verifyDummy } from '../auth/password.js';
import { createSession, deleteSession } from '../auth/sessions.js';
import {
  checkLoginRateLimit,
  recordLoginAttempt,
  clearFailedAttemptsForEmail,
} from '../auth/ratelimit.js';
import { findUserByEmail, findRoleById, touchLastLogin } from '../auth/users.js';
import type { AuthContext } from '../auth/middleware.js';
import { query, queryOne, execute } from '../db/client.js';
import { listTypes, getTypeBySlug } from '../content/types.js';
import { listContent, findById } from '../content/content.js';
import {
  createContent,
  updateContent,
  publishContent,
  unpublishContent,
  deleteContent,
} from '../content/writer.js';
import { invalidate } from '../cache/deps.js';
import { fireEvent } from '../webhooks/dispatch.js';
import { jobStats } from '../jobs/queue.js';
import { clientIp, userAgent, isHttps } from '../routes/api/_helpers.js';
import { ContentForm, parseContentForm } from './contentEditor.js';
import { adminScreens } from './screens.js';
import { can } from '../permissions/check.js';
import { getT, makeT } from './i18n/index.js';
import { ADMIN_LANG_COOKIE, attachAdminI18n } from './i18n/middleware.js';
import { adminLocales, adminLocaleNames, coerceLocale } from './i18n/locales.js';

const SESSION_COOKIE = 'skelpoSession';

export const adminRoutes = new Hono();

// Resolve the admin UI language (user.locale → cookie → Accept-Language) and
// expose t()/locale on the context. Registered before the route mounts so it
// runs for every admin path, including the dashboard at exactly /admin.
adminRoutes.use('*', attachAdminI18n);

adminRoutes.route('/static', adminStatic);

// Secondary screens (settings, users, redirects, menus, jobs, webhooks).
adminRoutes.route('/', adminScreens);

// ── Auth gate ──────────────────────────────────────────────────────────

function gate(c: Context): AuthContext | Response {
  const auth = c.get('auth');
  if (!auth) return c.redirect('/admin/login', 302);
  return auth;
}

// Perry workaround: `x instanceof Response` is always false for the native
// fetch handle (no prototype/constructor link), so gate()'s union can't be
// discriminated by instanceof. Use a field only AuthContext carries. This is a
// type guard, so callers still narrow to AuthContext. Identical on Node/Bun.
function notAuth(x: AuthContext | Response): x is Response {
  return (x as AuthContext).user === undefined;
}

// ── Login ──────────────────────────────────────────────────────────────

adminRoutes.get('/login', (c) => {
  if (c.get('auth')) return c.redirect('/admin', 302);
  const t = getT(c);
  const err = c.req.query('err');
  return c.html(
    <AdminPage title={t('auth.signInTitle')} t={t}>
      <div class="card">
        <div class="brand" style="padding-left:0">
          Skelpo<b>CMS</b>
        </div>
        <p class="muted" style="margin-top:-6px">
          {t('auth.signInPrompt')}
        </p>
        {err ? <div class="err">{err}</div> : null}
        <form method="post" action="/admin/login">
          <label>{t('auth.email')}</label>
          <input type="email" name="email" required autofocus />
          <label>{t('auth.password')}</label>
          <input type="password" name="password" required />
          <div style="margin-top:18px">
            <button class="btn" type="submit" style="width:100%">
              {t('auth.signIn')}
            </button>
          </div>
        </form>
      </div>
    </AdminPage>,
  );
});

adminRoutes.post('/login', async (c) => {
  const t = getT(c);
  const form = await c.req.parseBody();
  const email = String(form.email ?? '').trim().toLowerCase();
  const password = String(form.password ?? '');
  const ip = clientIp(c);

  const rate = await checkLoginRateLimit(email, ip);
  if (!rate.allowed) {
    return c.redirect('/admin/login?err=' + encodeURIComponent(t('auth.tooManyAttempts')), 302);
  }
  const user = await findUserByEmail(email);
  if (!user) {
    await verifyDummy(); // equalize timing vs the real compare path (anti-enumeration)
    await recordLoginAttempt(email, ip, false);
    return c.redirect('/admin/login?err=' + encodeURIComponent(t('auth.invalidCredentials')), 302);
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    await recordLoginAttempt(email, ip, false);
    return c.redirect('/admin/login?err=' + encodeURIComponent(t('auth.invalidCredentials')), 302);
  }
  // Fail CLOSED for TOTP-enabled accounts until real verification ships — the
  // admin path must not issue a session on password alone. (Matches the API.)
  if (user.totpVerified === 1) {
    await recordLoginAttempt(email, ip, false);
    return c.redirect('/admin/login?err=' + encodeURIComponent('Two-factor authentication is enabled for this account, but verification is not yet available. Contact an administrator.'), 302);
  }
  const { token, expiresAt } = await createSession(user.id, { ip, userAgent: userAgent(c) });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    expires: expiresAt,
  });
  await touchLastLogin(user.id);
  await clearFailedAttemptsForEmail(email);
  await recordLoginAttempt(email, ip, true);
  return c.redirect('/admin', 302);
});

adminRoutes.get('/logout', async (c) => {
  const tok = getCookie(c, SESSION_COOKIE);
  if (tok) await deleteSession(tok);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/admin/login', 302);
});

// ── Profile (per-user preferences: display language) ───────────────────

/** Persist the current user's locale + mirror it into the lang cookie so
 *  the choice survives even before the next DB read. */
function rememberLocale(c: Context, userId: number, locale: string): Promise<unknown> {
  setCookie(c, ADMIN_LANG_COOKIE, locale, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return execute('UPDATE `users` SET `locale` = ? WHERE `id` = ?', [locale, userId]);
}

/** Only allow same-app return targets (no open redirect). */
function safeAdminReturn(ret: string): string {
  return ret.startsWith('/admin') && !ret.startsWith('/admin/login') ? ret : '/admin';
}

adminRoutes.get('/profile', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const current = coerceLocale(auth.user.locale) ?? t.locale;
  const flash = c.req.query('ok');
  return c.html(
    <AdminPage title={t('profile.title')} active="profile" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{t('profile.heading')}</h1>
      </div>
      {flash ? <div class="ok">{decodeURIComponent(flash)}</div> : null}
      <div class="card" style="max-width:520px">
        <p class="muted" style="margin-top:0">{t('profile.intro')}</p>
        <form method="post" action="/admin/profile">
          <label>{t('profile.email')}</label>
          <input type="text" value={auth.user.email} disabled />
          <label>{t('profile.role')}</label>
          <input type="text" value={auth.role.label} disabled />
          <label>{t('profile.displayLanguage')}</label>
          <select name="locale">
            {adminLocales.map((l) => (
              <option value={l} selected={l === current}>{adminLocaleNames[l]}</option>
            ))}
          </select>
          <div class="muted" style="font-size:12px;margin-top:6px">{t('profile.languageHint')}</div>
          <div style="margin-top:18px">
            <button class="btn" type="submit">{t('profile.save')}</button>
          </div>
        </form>
      </div>
    </AdminPage>,
  );
});

adminRoutes.post('/profile', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const body = await c.req.parseBody();
  const locale = coerceLocale(String(body.locale ?? ''));
  if (locale) await rememberLocale(c, auth.user.id, locale);
  // Flash in the (possibly new) language.
  const t = locale ? makeT(locale) : getT(c);
  return c.redirect('/admin/profile?ok=' + encodeURIComponent(t('profile.flashSaved')), 302);
});

// Quick language switcher from the sidebar — saves and returns to the page
// the user was on.
adminRoutes.post('/profile/language', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const body = await c.req.parseBody();
  const locale = coerceLocale(String(body.locale ?? ''));
  if (locale) await rememberLocale(c, auth.user.id, locale);
  return c.redirect(safeAdminReturn(String(body.return ?? '/admin')), 302);
});

// ── Dashboard ──────────────────────────────────────────────────────────

adminRoutes.get('/', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const canManageSettings = can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageSettings');

  const [pages, posts, docs, users, jobsByStatus, maintRow, previewRow, siteUrlRow] = await Promise.all([
    queryOne<{ n: number }>("SELECT COUNT(*) n FROM `content` WHERE `typeSlug`='page'"),
    queryOne<{ n: number }>("SELECT COUNT(*) n FROM `content` WHERE `typeSlug`='post'"),
    queryOne<{ n: number }>("SELECT COUNT(*) n FROM `content` WHERE `typeSlug`='doc'"),
    queryOne<{ n: number }>('SELECT COUNT(*) n FROM `users`'),
    jobStats(),
    queryOne<{ value: unknown }>("SELECT `value` FROM `settings` WHERE `keyName` = 'site.maintenance'"),
    queryOne<{ value: unknown }>("SELECT `value` FROM `settings` WHERE `keyName` = 'site.previewToken'"),
    queryOne<{ value: unknown }>("SELECT `value` FROM `settings` WHERE `keyName` = 'site.url'"),
  ]);
  const maintenanceOn = maintRow?.value === true;
  const previewToken = typeof previewRow?.value === 'string' ? previewRow.value : null;
  const siteUrl = typeof siteUrlRow?.value === 'string' ? siteUrlRow.value : '';
  const previewLink = siteUrl && previewToken ? `${siteUrl.replace(/\/+$/, '')}/?preview=${encodeURIComponent(previewToken)}` : null;
  const flash = c.req.query('ok');

  const recent = await query<{ id: number; title: string; typeSlug: string; status: string; updatedAt: unknown }>(
    'SELECT `id`,`title`,`typeSlug`,`status`,`updatedAt` FROM `content` ORDER BY `updatedAt` DESC LIMIT 8',
  );

  return c.html(
    <AdminPage title={t('dashboard.title')} active="dashboard" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{t('dashboard.title')}</h1>
        <span class="muted">{t('dashboard.signedInAs', { name: auth.user.displayName })}</span>
      </div>
      {flash ? <div class="ok">{decodeURIComponent(flash)}</div> : null}

      {/* Maintenance status — prominent if on, low-key if off. Hidden for
          users without manageSettings (matches sidebar gating). */}
      {canManageSettings ? (
        <div class="card" style={`margin-bottom:18px;${maintenanceOn
          ? 'border-color:#f59e0b;background:linear-gradient(0deg,rgba(245,158,11,.08),rgba(245,158,11,.08))'
          : ''}`}>
          <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
            <div style={`width:10px;height:10px;border-radius:999px;background:${maintenanceOn ? '#f59e0b' : '#34d399'};box-shadow:0 0 0 4px ${maintenanceOn ? 'rgba(245,158,11,.18)' : 'rgba(52,211,153,.16)'};flex-shrink:0`} />
            <div style="flex:1;min-width:240px">
              <div style="font-weight:600;font-size:14px">
                {t('dashboard.maintenanceMode')} <span style={`color:${maintenanceOn ? 'var(--acc2)' : 'var(--ok)'}`}>{maintenanceOn ? t('dashboard.on') : t('dashboard.off')}</span>
              </div>
              <div class="muted" style="font-size:12px;margin-top:3px">
                {maintenanceOn
                  ? t('dashboard.maintenanceOnDesc')
                  : t('dashboard.maintenanceOffDesc')}
              </div>
            </div>
            <form method="post" action="/admin/maintenance/toggle" style="margin:0">
              <button class="btn" type="submit" style={maintenanceOn ? 'background:var(--ok);color:#06281c' : ''}>
                {maintenanceOn ? t('dashboard.turnOff') : t('dashboard.turnOn')}
              </button>
            </form>
          </div>
          {maintenanceOn && previewLink ? (
            <div style="margin-top:12px;padding:10px 12px;background:var(--panel2);border-radius:6px;font-size:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <span class="muted">{t('dashboard.previewLinkLabel')}</span>
              <code style="background:var(--bg);padding:4px 8px;border-radius:4px;flex:1;min-width:300px;overflow:auto;font-size:11px">{previewLink}</code>
              <form method="post" action="/admin/maintenance/rotate-token" style="margin:0">
                <button class="btn sm sec" type="submit" title={t('dashboard.rotateTitle')}>{t('dashboard.rotate')}</button>
              </form>
            </div>
          ) : null}
          <div class="muted" style="font-size:11px;margin-top:10px;line-height:1.5">
            {t('dashboard.editVisitorMessage')}{' '}
            <a href="/admin/settings/site.maintenanceTitle">{t('dashboard.visitorTitle')}</a> · <a href="/admin/settings/site.maintenanceMessage">{t('dashboard.visitorBody')}</a>
          </div>
        </div>
      ) : null}

      <div class="grid g4">
        <div class="card">
          <div class="stat">{pages?.n ?? 0}</div>
          <div class="stat-l">{t('dashboard.statPages')}</div>
        </div>
        <div class="card">
          <div class="stat">{posts?.n ?? 0}</div>
          <div class="stat-l">{t('dashboard.statPosts')}</div>
        </div>
        <div class="card">
          <div class="stat">{docs?.n ?? 0}</div>
          <div class="stat-l">{t('dashboard.statDocs')}</div>
        </div>
        <div class="card">
          <div class="stat">{users?.n ?? 0}</div>
          <div class="stat-l">{t('dashboard.statUsers')}</div>
        </div>
      </div>
      <div class="card" style="margin-top:18px">
        <h3 style="margin-top:0">{t('dashboard.recentlyUpdated')}</h3>
        <table>
          <thead>
            <tr>
              <th>{t('dashboard.colTitle')}</th>
              <th>{t('dashboard.colType')}</th>
              <th>{t('dashboard.colStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr>
                <td>
                  <a href={`/admin/content/${r.typeSlug}/${r.id}`}>{r.title}</a>
                </td>
                <td class="muted">{r.typeSlug}</td>
                <td>
                  <StatusBadge status={r.status} t={t} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top:18px">
        <h3 style="margin-top:0">{t('dashboard.jobQueue')}</h3>
        <div class="muted">
          {Object.entries(jobsByStatus)
            .map(([k, v]) => `${k}: ${v}`)
            .join('  ·  ') || t('common.idle')}
        </div>
      </div>
    </AdminPage>,
  );
});

// ── Maintenance: toggle + rotate preview token ─────────────────────────

import { setSetting, invalidateSettingsCache } from '../settings/store.js';

adminRoutes.post('/maintenance/toggle', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageSettings')) {
    return c.redirect('/admin?ok=' + encodeURIComponent(t('dashboard.flashPermDenied')), 302);
  }
  const current = await queryOne<{ value: unknown }>(
    "SELECT `value` FROM `settings` WHERE `keyName` = 'site.maintenance'",
  );
  const next = !(current?.value === true);
  await setSetting('site.maintenance', next, auth.user.id);
  invalidate(['setting:site.maintenance']);
  invalidateSettingsCache();
  return c.redirect('/admin?ok=' + encodeURIComponent(
    next ? t('dashboard.flashMaintOn') : t('dashboard.flashMaintOff'),
  ), 302);
});

adminRoutes.post('/maintenance/rotate-token', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageSettings')) {
    return c.redirect('/admin', 302);
  }
  // 32 url-safe random chars (≈192 bits).
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const tok = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  await setSetting('site.previewToken', tok, auth.user.id);
  invalidate(['setting:site.previewToken']);
  invalidateSettingsCache();
  return c.redirect('/admin?ok=' + encodeURIComponent(t('dashboard.flashTokenRotated')), 302);
});

// ── Content types index ────────────────────────────────────────────────

adminRoutes.get('/types', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const types = await listTypes();
  // Per-type row counts (any locale)
  const counts = new Map<string, number>();
  for (const ct of types) {
    const r = await queryOne<{ n: number }>(
      'SELECT COUNT(*) n FROM `content` WHERE `typeSlug` = ?',
      [ct.slug],
    );
    counts.set(ct.slug, r?.n ?? 0);
  }
  return c.html(
    <AdminPage title={t('types.title')} active="types" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{t('types.title')}</h1>
        <span class="muted">{t.plural('types.count', types.length)}</span>
      </div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>{t('types.colType')}</th>
              <th>{t('types.colLabel')}</th>
              <th>{t('types.colUrlPattern')}</th>
              <th>{t('types.colRows')}</th>
              <th>{t('types.colSchemaRev')}</th>
            </tr>
          </thead>
          <tbody>
            {types.map((ct) => (
              <tr>
                <td>
                  <a href={`/admin/content/${ct.slug}`}>{ct.slug}</a>
                </td>
                <td class="muted">{ct.labelPlural}</td>
                <td class="muted">{ct.urlPattern ?? '—'}</td>
                <td class="muted">{counts.get(ct.slug) ?? 0}</td>
                <td class="muted">v{ct.currentRevision ?? 1}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminPage>,
  );
});

// ── Content list ───────────────────────────────────────────────────────

adminRoutes.get('/content/:type', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const typeSlug = c.req.param('type');
  const types = await listTypes();
  const ct = types.find((x) => x.slug === typeSlug);
  if (!ct) return c.html(<AdminPage title={t('common.notFound')} t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('common.unknownType')}</AdminPage>, 404);

  const ctx = { userId: auth.user.id, caps: auth.role.capabilities };
  if (!can(ctx, 'read', ct.slug)) {
    return c.html(<AdminPage title={t('common.forbidden')} t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('common.forbidden')}</AdminPage>, 403);
  }

  // Locale filter — defaults to en. "all" shows every locale (useful for
  // diffing translation coverage). Available locales come from site.locales.
  const sel = c.req.query('locale') ?? 'en';
  let availableLocales: string[] = ['en'];
  try {
    const sl = await queryOne<{ value: unknown }>(
      "SELECT `value` FROM `settings` WHERE `keyName` = 'site.locales'",
    );
    if (sl) {
      const v = typeof sl.value === 'string' ? JSON.parse(sl.value) : sl.value;
      if (Array.isArray(v) && v.length > 0) availableLocales = v as string[];
    }
  } catch { /* default to en */ }

  const canDrafts = can(ctx, 'readDrafts', ct.slug);
  const canOthers = can(ctx, 'readOthersDrafts', ct.slug);
  const { rows: allRows } = await listContent({
    typeSlug,
    locale: sel === 'all' ? undefined : sel,
    status: canDrafts ? ['draft', 'review', 'published', 'archived'] : ['published'],
    includeDrafts: canDrafts,
    limit: 200,
    sort: '-updatedAt',
  });
  // Without readOthersDrafts, hide other people's unpublished rows (keep every
  // published row + the caller's own drafts).
  const rows = (canDrafts && !canOthers)
    ? allRows.filter((r) => r.status === 'published' || r.authorId === auth.user.id)
    : allRows;

  const rowsLabel = t.plural('common.rows', rows.length);
  return c.html(
    <AdminPage title={ct.labelPlural} active={typeSlug} t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{ct.labelPlural}</h1>
        <a class="btn" href={`/admin/content/${typeSlug}/new`}>
          {t('content.newItem', { label: ct.labelSingular })}
        </a>
      </div>
      <div class="card" style="margin-bottom:14px;padding:10px 14px">
        <form method="get" style="display:flex;align-items:center;gap:10px;margin:0">
          <label class="muted" for="locale-sel" style="margin:0">{t('content.locale')}</label>
          <select name="locale" id="locale-sel" onchange="this.form.submit()" style="background:#15161c;border:1px solid #333;color:#ccc;padding:4px 8px;border-radius:4px">
            <option value="all" selected={sel === 'all'}>{t('content.allLocales')}</option>
            {availableLocales.map((l) => (
              <option value={l} selected={sel === l}>{l}</option>
            ))}
          </select>
          <span class="muted" style="margin-left:auto;font-size:12px">
            {sel !== 'all'
              ? t('content.rowsInLocale', { count: rowsLabel, locale: sel })
              : t('content.rowsAllLocales', { count: rowsLabel })}
          </span>
        </form>
      </div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>{t('content.colTitle')}</th>
              <th>{t('content.colSlug')}</th>
              <th>{t('content.colLocale')}</th>
              <th>{t('content.colStatus')}</th>
              <th>{t('content.colUpdated')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colspan={5} class="muted">
                  {sel !== 'all'
                    ? t('content.emptyInLocale', { label: ct.labelPlural.toLowerCase(), locale: sel })
                    : t('content.empty', { label: ct.labelPlural.toLowerCase() })}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr>
                  <td>
                    <a href={`/admin/content/${typeSlug}/${r.id}`}>{r.title}</a>
                  </td>
                  <td class="muted">{r.slug}</td>
                  <td class="muted">{r.locale}</td>
                  <td>
                    <StatusBadge status={r.status} t={t} />
                  </td>
                  <td class="muted">{String(r.updatedAt).slice(0, 10)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </AdminPage>,
  );
});

// Read `site.locales` (universe of locales) for translation tabs.
async function readSiteLocales(): Promise<string[]> {
  try {
    const r = await queryOne<{ value: unknown }>(
      "SELECT `value` FROM `settings` WHERE `keyName` = 'site.locales'",
    );
    if (!r) return ['en'];
    // JSON column: driver may return either the raw string or a pre-parsed value.
    const v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
    if (Array.isArray(v) && v.length > 0) return v as string[];
  } catch { /* fall through */ }
  return ['en'];
}

// ── Content editor: new ────────────────────────────────────────────────

adminRoutes.get('/content/:type/new', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const ct = await getTypeBySlug(c.req.param('type'));
  if (!ct) return c.html(<AdminPage title="404" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('common.unknownType')}</AdminPage>, 404);
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'create', ct.slug)) {
    return c.html(<AdminPage title={t('common.forbidden')} t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('content.noCreatePermissionFor', { slug: ct.slug })}</AdminPage>, 403);
  }

  // If creating a translation of an existing row, pre-populate slug + title
  // from the source row and render locale tabs alongside the form.
  const translationOfParam = c.req.query('translationOf');
  const localeParam = c.req.query('locale');
  let siblings: { id: number; locale: string; status: string }[] = [];
  let availableLocales: string[] = [];
  let defaultTitle = '';
  let defaultSlug = '';
  let defaultLocale = localeParam ?? 'en';
  let translationOf: number | undefined;

  if (translationOfParam) {
    const sourceId = Number(translationOfParam);
    const source = await findById(sourceId, true);
    if (source && source.typeSlug === ct.slug) {
      translationOf = sourceId;
      defaultTitle = source.title;
      defaultSlug = source.slug;
      siblings = await query<{ id: number; locale: string; status: string }>(
        'SELECT `id`, `locale`, `status` FROM `content` WHERE `translationGroupId` = ? AND `typeSlug` = ? ORDER BY `locale`',
        [source.translationGroupId, ct.slug],
      );
      availableLocales = await readSiteLocales();
    }
  }

  return c.html(
    <ContentForm
      type={ct}
      t={t}
      fields={{}}
      seo={{}}
      user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}
      siblings={siblings}
      availableLocales={availableLocales}
      translationOf={translationOf}
      defaultTitle={defaultTitle}
      defaultSlug={defaultSlug}
      defaultLocale={defaultLocale}
    />,
  );
});

// ── Content editor: edit (must come AFTER /new) ────────────────────────

adminRoutes.get('/content/:type/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const ct = await getTypeBySlug(c.req.param('type'));
  if (!ct) return c.html(<AdminPage title="404" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('common.unknownType')}</AdminPage>, 404);
  const row = await findById(Number(c.req.param('id')), true);
  if (!row) return c.html(<AdminPage title="404" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('common.notFound')}</AdminPage>, 404);
  const ctx = { userId: auth.user.id, caps: auth.role.capabilities };
  if (!can(ctx, 'read', ct.slug)) {
    return c.html(<AdminPage title={t('common.forbidden')} t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('common.forbidden')}</AdminPage>, 403);
  }
  if (row.status !== 'published') {
    const allowed = row.authorId === auth.user.id
      ? can(ctx, 'readDrafts', ct.slug)
      : can(ctx, 'readOthersDrafts', ct.slug);
    if (!allowed) {
      return c.html(<AdminPage title={t('common.forbidden')} t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('common.forbidden')}</AdminPage>, 403);
    }
  }
  const fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields;
  const seo = typeof row.seo === 'string' ? JSON.parse(row.seo) : row.seo;
  const flash = c.req.query('ok')
    ? { ok: c.req.query('ok')! }
    : c.req.query('err')
      ? { err: c.req.query('err')! }
      : undefined;

  // Translation siblings (other-locale rows in the same translation group).
  const [siblings, availableLocales] = await Promise.all([
    query<{ id: number; locale: string; status: string }>(
      'SELECT `id`, `locale`, `status` FROM `content` WHERE `translationGroupId` = ? AND `typeSlug` = ? ORDER BY `locale`',
      [row.translationGroupId, ct.slug],
    ),
    readSiteLocales(),
  ]);

  return c.html(
    <ContentForm
      type={ct}
      t={t}
      row={row}
      fields={fields}
      seo={seo}
      user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}
      flash={flash}
      siblings={siblings}
      availableLocales={availableLocales}
    />,
  );
});

// ── Content editor: create (POST) ──────────────────────────────────────

function invalidateAndNotify(event: Parameters<typeof fireEvent>[0], typeSlug: string, locale: string, id: number): void {
  invalidate([`content:${id}`]);
  invalidate([`type-list:${typeSlug}:${locale}`], { prefix: true });
  void fireEvent(event, { id, type: typeSlug, locale }, [`content:${id}`, `type-list:${typeSlug}:${locale}`]);
}

adminRoutes.post('/content/:type', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const ct = await getTypeBySlug(c.req.param('type'));
  if (!ct) return c.html(<AdminPage title="404" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('common.unknownType')}</AdminPage>, 404);
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'create', ct.slug)) {
    return c.html(<AdminPage title={t('common.forbidden')} t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('content.noCreatePermission')}</AdminPage>, 403);
  }
  const body = await c.req.parseBody();
  const p = parseContentForm(body, ct.fieldsSchema.fields);
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
  });
  if (!res.ok) {
    return c.redirect(
      `/admin/content/${ct.slug}/new?err=` +
        encodeURIComponent(res.errors[0]?.message ?? t('content.validationFailed')),
      302,
    );
  }
  invalidateAndNotify('content.created', ct.slug, p.locale, res.id);
  let dest = `/admin/content/${ct.slug}/${res.id}?ok=${encodeURIComponent(t('content.flashCreated'))}`;
  if (p.action === 'publish') {
    const pub = await publishContent(res.id, auth.user.id);
    if (pub.ok) {
      invalidateAndNotify('content.published', ct.slug, p.locale, res.id);
      dest = `/admin/content/${ct.slug}/${res.id}?ok=${encodeURIComponent(t('content.flashPublished'))}`;
    } else {
      dest = `/admin/content/${ct.slug}/${res.id}?err=` +
        encodeURIComponent(t('content.savedPublishBlocked', { reason: pub.errors[0]?.message ?? '' }));
    }
  }
  return c.redirect(dest, 302);
});

// ── Content editor: update / publish / unpublish / delete (POST) ───────

adminRoutes.post('/content/:type/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  const ct = await getTypeBySlug(c.req.param('type'));
  const id = Number(c.req.param('id'));
  if (!ct) return c.html(<AdminPage title="404" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('common.unknownType')}</AdminPage>, 404);
  const existing = await findById(id, true);
  if (!existing) return c.html(<AdminPage title="404" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>{t('common.notFound')}</AdminPage>, 404);

  const body = await c.req.parseBody();
  const p = parseContentForm(body, ct.fieldsSchema.fields);
  const back = `/admin/content/${ct.slug}/${id}`;

  if (p.action === 'delete') {
    if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'delete', ct.slug, existing.authorId)) {
      return c.redirect(`${back}?err=${encodeURIComponent(t('content.noDeletePermission'))}`, 302);
    }
    await deleteContent(id, false);
    invalidateAndNotify('content.deleted', ct.slug, existing.locale, id);
    return c.redirect(`/admin/content/${ct.slug}`, 302);
  }

  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'update', ct.slug, existing.authorId)) {
    return c.redirect(`${back}?err=${encodeURIComponent(t('content.noUpdatePermission'))}`, 302);
  }

  const upd = await updateContent(
    id,
    { title: p.title, slug: p.slug, fields: p.fields, seo: p.seo, ai: p.ai },
    auth.user.id,
  );
  if (!upd.ok) {
    return c.redirect(`${back}?err=` + encodeURIComponent(upd.errors[0]?.message ?? t('content.updateFailed')), 302);
  }
  invalidateAndNotify('content.updated', ct.slug, existing.locale, id);

  if (p.action === 'publish') {
    if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'publish', ct.slug, existing.authorId)) {
      return c.redirect(`${back}?err=${encodeURIComponent(t('content.noPublishPermission'))}`, 302);
    }
    const pub = await publishContent(id, auth.user.id);
    if (!pub.ok) {
      return c.redirect(`${back}?err=` + encodeURIComponent(t('content.publishBlocked', { reason: pub.errors[0]?.message ?? '' })), 302);
    }
    invalidateAndNotify('content.published', ct.slug, existing.locale, id);
    return c.redirect(`${back}?ok=${encodeURIComponent(t('content.flashPublished'))}`, 302);
  }
  if (p.action === 'unpublish') {
    await unpublishContent(id, auth.user.id);
    invalidateAndNotify('content.unpublished', ct.slug, existing.locale, id);
    return c.redirect(`${back}?ok=${encodeURIComponent(t('content.flashUnpublished'))}`, 302);
  }
  return c.redirect(`${back}?ok=${encodeURIComponent(t('content.flashSaved'))}`, 302);
});
