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
import { createPendingLogin, usePendingLogin, clearPendingLogin, verifyTotpForUser } from '../auth/totp.js';
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
import { adminSite } from './siteScreens.js';
import { adminTypes } from './typeScreens.js';
import { adminAccount } from './account.js';
import { adminContent } from './contentRoutes.js';
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
adminRoutes.route('/', adminSite);
adminRoutes.route('/', adminTypes);
adminRoutes.route('/', adminAccount);
adminRoutes.route('/', adminContent);

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
        {err ? <div class="err" role="alert">{err}</div> : null}
        {c.req.query('ok') ? <div class="ok" role="status">{c.req.query('ok')}</div> : null}
        <form method="post" action="/admin/login">
          <label>{t('auth.email')}</label>
          <input type="email" name="email" required autofocus />
          <label>{t('auth.password')}</label>
          <input type="password" name="password" required autocomplete="current-password" />
          <div style="margin-top:18px">
            <button class="btn" type="submit" style="width:100%">
              {t('auth.signIn')}
            </button>
          </div>
        </form>
        <p style="text-align:center;font-size:12px;margin:14px 0 0">
          <a href="/admin/forgot-password">{t('auth.forgotPassword')}</a>
        </p>
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
  // Two-factor accounts get a short-lived ticket instead of a session; the
  // code step below turns it into one.
  if (user.totpVerified === 1) {
    c.header('Cache-Control', 'no-store');
    return c.html(<TwoFactorPage t={t} ticket={createPendingLogin(user.id, email)} />);
  }
  await completeLogin(c, user.id, email, ip);
  return c.redirect('/admin', 302);
});

async function completeLogin(c: Context, userId: number, email: string, ip: string): Promise<void> {
  const { token, expiresAt } = await createSession(userId, { ip, userAgent: userAgent(c) });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    expires: expiresAt,
  });
  await touchLastLogin(userId);
  await clearFailedAttemptsForEmail(email);
  await recordLoginAttempt(email, ip, true);
}

const TwoFactorPage = ({ t, ticket, err }: { t: ReturnType<typeof getT>; ticket: string; err?: string }) => (
  <AdminPage title={t('auth.twoFactorTitle')} t={t}>
    <div class="card">
      <div class="brand" style="padding-left:0">
        Skelpo<b>CMS</b>
      </div>
      <h2 style="font-size:16px;margin:0 0 6px">{t('auth.twoFactorTitle')}</h2>
      <p class="muted" style="margin-top:0">{t('auth.twoFactorPrompt')}</p>
      {err ? <div class="err" role="alert">{err}</div> : null}
      <form method="post" action="/admin/login/code">
        <input type="hidden" name="ticket" value={ticket} />
        <label for="code">{t('auth.twoFactorCode')}</label>
        <input type="text" name="code" id="code" required autofocus inputmode="numeric" pattern="[0-9 ]*" maxlength={7}
          autocomplete="one-time-code" style="font-size:20px;letter-spacing:4px;text-align:center" />
        <div style="margin-top:18px">
          <button class="btn" type="submit" style="width:100%">{t('auth.twoFactorVerify')}</button>
        </div>
      </form>
      <p class="help" style="text-align:center">{t('auth.twoFactorLost')}</p>
    </div>
    <p style="text-align:center;font-size:12px;margin-top:14px"><a href="/admin/login">{t('account.backToSignIn')}</a></p>
  </AdminPage>
);

adminRoutes.post('/login/code', async (c) => {
  const t = getT(c);
  const form = await c.req.parseBody();
  const ticket = String(form.ticket ?? '');
  const ip = clientIp(c);
  const expired = () => c.redirect('/admin/login?err=' + encodeURIComponent(t('auth.twoFactorExpired')), 302);
  const p = usePendingLogin(ticket);
  if (!p) return expired();
  const rate = await checkLoginRateLimit(p.email, ip);
  if (!rate.allowed) {
    clearPendingLogin(ticket);
    return c.redirect('/admin/login?err=' + encodeURIComponent(t('auth.tooManyAttempts')), 302);
  }
  const user = await findUserByEmail(p.email);
  if (!user || user.id !== p.userId || user.totpVerified !== 1) {
    clearPendingLogin(ticket);
    return expired();
  }
  if (!(await verifyTotpForUser(user.id, user.totpSecret, String(form.code ?? '')))) {
    await recordLoginAttempt(p.email, ip, false);
    c.header('Cache-Control', 'no-store');
    return c.html(<TwoFactorPage t={t} ticket={ticket} err={t('auth.twoFactorWrong')} />, 401);
  }
  clearPendingLogin(ticket);
  await completeLogin(c, user.id, p.email, ip);
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
  const ctx = { userId: auth.user.id, caps: auth.role.capabilities };
  const canManageSettings = can(ctx, 'manageSettings');
  const canManageJobs = can(ctx, 'manageJobs');

  const hidden = await getHiddenTypes();
  const types = (await listTypes())
    .filter((ct) => !['form', 'errorPage'].includes(ct.slug) && !hidden.includes(ct.slug))
    .filter((ct) => can(ctx, 'read', ct.slug));
  const typeLabel = new Map(types.map((ct) => [ct.slug, ct.labelSingular]));

  const [countRows, mediaRow, jobsByStatus, maintenance, siteUrlRaw, siteNameRaw] = await Promise.all([
    query<{ typeSlug: string; status: string; n: number }>(
      "SELECT `typeSlug`, `status`, COUNT(*) n FROM `content` WHERE `status` != 'archived' GROUP BY `typeSlug`, `status`"),
    queryOne<{ n: number }>('SELECT COUNT(*) n FROM `media`'),
    canManageJobs ? jobStats() : Promise.resolve({} as Record<string, number>),
    getSetting<unknown>('site.maintenance', false),
    getSetting<unknown>('site.url', ''),
    getSetting<unknown>('site.name', ''),
  ]);
  const counts = new Map<string, { published: number; drafts: number }>();
  for (const r of countRows) {
    const cur = counts.get(r.typeSlug) ?? { published: 0, drafts: 0 };
    if (r.status === 'published') cur.published += Number(r.n); else cur.drafts += Number(r.n);
    counts.set(r.typeSlug, cur);
  }
  const siteUrl = typeof siteUrlRaw === 'string' && /^https?:\/\//.test(siteUrlRaw) ? siteUrlRaw : '';
  const siteName = typeof siteNameRaw === 'string' && siteNameRaw.trim() ? siteNameRaw.trim() : 'Skelpo CMS';
  const failedJobs = Number(jobsByStatus.failed ?? 0) + Number(jobsByStatus.dead ?? 0);

  const slugs = types.map((ct) => ct.slug);
  const recent = slugs.length === 0 ? [] : await query<{
    id: number; title: string; typeSlug: string; status: string; locale: string; updatedAt: unknown; authorId: number | null; authorName: string | null;
  }>(
    `SELECT c.\`id\`, c.\`title\`, c.\`typeSlug\`, c.\`status\`, c.\`locale\`, c.\`updatedAt\`, c.\`authorId\`, u.\`displayName\` AS authorName
       FROM \`content\` c LEFT JOIN \`users\` u ON u.\`id\` = c.\`authorId\`
      WHERE c.\`status\` != 'archived' AND c.\`typeSlug\` IN (${slugs.map(() => '?').join(',')})
      ORDER BY c.\`updatedAt\` DESC LIMIT 30`,
    slugs,
  );
  // Same visibility rules as the lists: no drafts you may not read.
  const visibleRecent = recent.filter((r) => r.status === 'published'
    || (r.authorId === auth.user.id ? can(ctx, 'readDrafts', r.typeSlug) : can(ctx, 'readOthersDrafts', r.typeSlug))).slice(0, 8);
  const creatable = types.filter((ct) => can(ctx, 'create', ct.slug));
  const flash = c.req.query('ok');
  const err = c.req.query('err');

  return c.html(
    <AdminPage title={t('dashboard.title')} active="dashboard" t={t} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{t('dashboard.welcome', { name: auth.user.displayName })}</h1>
        {siteUrl ? <a class="btn sec" href={siteUrl} target="_blank" rel="noopener">{t('nav.visitSite')} ↗</a> : null}
      </div>
      {flash ? <div class="ok" role="status">{flash}</div> : null}
      {err ? <div class="err" role="alert">{err}</div> : null}

      {maintenance === true ? (
        <div class="err" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <span style="flex:1">{t('dashboard.maintenanceBanner', { site: siteName })}</span>
          {canManageSettings ? <a class="btn sm sec" href="/admin/settings?tab=maintenance">{t('dashboard.maintenanceManage')}</a> : null}
        </div>
      ) : null}
      {canManageJobs && failedJobs > 0 ? (
        <div class="err">{t.plural('dashboard.failedJobs', failedJobs)} <a href="/admin/jobs">{t('dashboard.failedJobsLink')}</a></div>
      ) : null}

      {creatable.length > 0 ? (
        <div class="card" style="margin-bottom:14px">
          <h3>{t('dashboard.quickCreate')}</h3>
          <div class="toolbar" style="margin-top:10px">
            {creatable.map((ct) => (
              <a class="btn sec" href={`/admin/content/${ct.slug}/new`}>{t('content.newItem', { label: ct.labelSingular })}</a>
            ))}
          </div>
        </div>
      ) : null}

      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">
        {types.map((ct) => {
          const n = counts.get(ct.slug) ?? { published: 0, drafts: 0 };
          return (
            <a class="card" href={`/admin/content/${ct.slug}`} style="text-decoration:none;color:inherit">
              <div class="stat">{n.published}</div>
              <div class="stat-l">{ct.labelPlural}</div>
              <div class="muted" style="font-size:12px;margin-top:6px">
                {n.drafts > 0 ? t.plural('dashboard.draftsCount', n.drafts) : t('dashboard.noDrafts')}
              </div>
            </a>
          );
        })}
        <a class="card" href="/admin/media" style="text-decoration:none;color:inherit">
          <div class="stat">{Number(mediaRow?.n ?? 0)}</div>
          <div class="stat-l">{t('nav.media')}</div>
        </a>
      </div>

      <div class="card" style="margin-top:18px">
        <h3>{t('dashboard.recentlyUpdated')}</h3>
        {visibleRecent.length === 0 ? <div class="muted" style="margin-top:8px">{t('dashboard.nothingYet')}</div> : (
          <table style="margin-top:8px">
            <thead>
              <tr>
                <th>{t('dashboard.colTitle')}</th>
                <th>{t('dashboard.colType')}</th>
                <th>{t('dashboard.colStatus')}</th>
                <th>{t('content.colAuthor')}</th>
                <th>{t('content.colUpdated')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleRecent.map((r) => (
                <tr>
                  <td>
                    <a href={`/admin/content/${r.typeSlug}/${r.id}`}>{r.title}</a>{' '}
                    <span class="muted" style="font-size:11px;text-transform:uppercase">{r.locale}</span>
                  </td>
                  <td class="muted">{typeLabel.get(r.typeSlug) ?? r.typeSlug}</td>
                  <td><StatusBadge status={r.status} t={t} /></td>
                  <td class="muted">{r.authorName ?? '—'}</td>
                  <td class="muted"><DateTime value={r.updatedAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AdminPage>,
  );
});

// ── Maintenance: toggle + rotate preview token ─────────────────────────

import { setSetting, invalidateSettingsCache, getSetting } from '../settings/store.js';
import { getHiddenTypes } from './layout.js';
import { DateTime } from './helpers.js';

adminRoutes.post('/maintenance/toggle', async (c) => {
  const auth = gate(c);
  if (notAuth(auth)) return auth;
  const t = getT(c);
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageSettings')) {
    return c.redirect('/admin?err=' + encodeURIComponent(t('dashboard.flashPermDenied')), 302);
  }
  const current = await queryOne<{ value: unknown }>(
    "SELECT `value` FROM `settings` WHERE `keyName` = 'site.maintenance'",
  );
  const next = !(current?.value === true);
  await setSetting('site.maintenance', next, auth.user.id);
  invalidate(['setting:site.maintenance']);
  invalidateSettingsCache();
  void fireEvent('setting.changed', { key: 'site.maintenance' }, ['setting:site.maintenance', 'settings:all']);
  return c.redirect('/admin/settings?tab=maintenance&ok=' + encodeURIComponent(
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
  return c.redirect('/admin/settings?tab=maintenance&ok=' + encodeURIComponent(t('dashboard.flashTokenRotated')), 302);
});
