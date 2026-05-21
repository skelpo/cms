// Admin UI routes (HTMX, server-rendered). Auth is cookie-session based;
// unauthenticated requests to protected pages redirect to /admin/login.

import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { AdminPage, StatusBadge } from './layout.js';
import { adminStatic } from './static.js';
import { verifyPassword } from '../auth/password.js';
import { createSession, deleteSession } from '../auth/sessions.js';
import {
  checkLoginRateLimit,
  recordLoginAttempt,
  clearFailedAttemptsForEmail,
} from '../auth/ratelimit.js';
import { findUserByEmail, findRoleById, touchLastLogin } from '../auth/users.js';
import type { AuthContext } from '../auth/middleware.js';
import { query, queryOne } from '../db/client.js';
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
import { clientIp, userAgent } from '../routes/api/_helpers.js';
import { ContentForm, parseContentForm } from './contentEditor.js';
import { adminScreens } from './screens.js';
import { can } from '../permissions/check.js';

const SESSION_COOKIE = 'skelpoSession';

export const adminRoutes = new Hono();

adminRoutes.route('/static', adminStatic);

// Secondary screens (settings, users, redirects, menus, jobs, webhooks).
adminRoutes.route('/', adminScreens);

// ── Auth gate ──────────────────────────────────────────────────────────

function gate(c: Context): AuthContext | Response {
  const auth = c.get('auth');
  if (!auth) return c.redirect('/admin/login', 302);
  return auth;
}

// ── Login ──────────────────────────────────────────────────────────────

adminRoutes.get('/login', (c) => {
  if (c.get('auth')) return c.redirect('/admin', 302);
  const err = c.req.query('err');
  return c.html(
    <AdminPage title="Sign in">
      <div class="card">
        <div class="brand" style="padding-left:0">
          Skelpo<b>CMS</b>
        </div>
        <p class="muted" style="margin-top:-6px">
          Sign in to the admin.
        </p>
        {err ? <div class="err">{err}</div> : null}
        <form method="post" action="/admin/login">
          <label>Email</label>
          <input type="email" name="email" required autofocus />
          <label>Password</label>
          <input type="password" name="password" required />
          <div style="margin-top:18px">
            <button class="btn" type="submit" style="width:100%">
              Sign in
            </button>
          </div>
        </form>
      </div>
    </AdminPage>,
  );
});

adminRoutes.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? '').trim().toLowerCase();
  const password = String(form.password ?? '');
  const ip = clientIp(c);

  const rate = await checkLoginRateLimit(email, ip);
  if (!rate.allowed) {
    return c.redirect('/admin/login?err=' + encodeURIComponent('Too many attempts, try later'), 302);
  }
  const user = await findUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    await recordLoginAttempt(email, ip, false);
    return c.redirect('/admin/login?err=' + encodeURIComponent('Invalid credentials'), 302);
  }
  const { token, expiresAt } = await createSession(user.id, { ip, userAgent: userAgent(c) });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.req.url.startsWith('https://'),
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

// ── Dashboard ──────────────────────────────────────────────────────────

adminRoutes.get('/', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
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
    <AdminPage title="Dashboard" active="dashboard" user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>Dashboard</h1>
        <span class="muted">Signed in as {auth.user.displayName}</span>
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
                Maintenance mode: <span style={`color:${maintenanceOn ? 'var(--acc2)' : 'var(--ok)'}`}>{maintenanceOn ? 'ON' : 'OFF'}</span>
              </div>
              <div class="muted" style="font-size:12px;margin-top:3px">
                {maintenanceOn
                  ? 'The public site is showing a "we\'ll be right back" page. Admins with the preview link still get through.'
                  : 'The public site is live and serving traffic normally.'}
              </div>
            </div>
            <form method="post" action="/admin/maintenance/toggle" style="margin:0">
              <button class="btn" type="submit" style={maintenanceOn ? 'background:var(--ok);color:#06281c' : ''}>
                {maintenanceOn ? 'Turn maintenance OFF' : 'Turn maintenance ON'}
              </button>
            </form>
          </div>
          {maintenanceOn && previewLink ? (
            <div style="margin-top:12px;padding:10px 12px;background:var(--panel2);border-radius:6px;font-size:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <span class="muted">Preview link (share with admins so they can still browse):</span>
              <code style="background:var(--bg);padding:4px 8px;border-radius:4px;flex:1;min-width:300px;overflow:auto;font-size:11px">{previewLink}</code>
              <form method="post" action="/admin/maintenance/rotate-token" style="margin:0">
                <button class="btn sm sec" type="submit" title="Rotate the preview token; old links stop working">Rotate</button>
              </form>
            </div>
          ) : null}
          <div class="muted" style="font-size:11px;margin-top:10px;line-height:1.5">
            Edit the message shown to visitors:{' '}
            <a href="/admin/settings/site.maintenanceTitle">Title</a> · <a href="/admin/settings/site.maintenanceMessage">Body</a>
          </div>
        </div>
      ) : null}

      <div class="grid g4">
        <div class="card">
          <div class="stat">{pages?.n ?? 0}</div>
          <div class="stat-l">Pages</div>
        </div>
        <div class="card">
          <div class="stat">{posts?.n ?? 0}</div>
          <div class="stat-l">Posts</div>
        </div>
        <div class="card">
          <div class="stat">{docs?.n ?? 0}</div>
          <div class="stat-l">Docs</div>
        </div>
        <div class="card">
          <div class="stat">{users?.n ?? 0}</div>
          <div class="stat-l">Users</div>
        </div>
      </div>
      <div class="card" style="margin-top:18px">
        <h3 style="margin-top:0">Recently updated</h3>
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Status</th>
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
                  <StatusBadge status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top:18px">
        <h3 style="margin-top:0">Job queue</h3>
        <div class="muted">
          {Object.entries(jobsByStatus)
            .map(([k, v]) => `${k}: ${v}`)
            .join('  ·  ') || 'idle'}
        </div>
      </div>
    </AdminPage>,
  );
});

// ── Maintenance: toggle + rotate preview token ─────────────────────────

import { setSetting, invalidateSettingsCache } from '../settings/store.js';

adminRoutes.post('/maintenance/toggle', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'manageSettings')) {
    return c.redirect('/admin?ok=' + encodeURIComponent('Permission denied (manageSettings required).'), 302);
  }
  const current = await queryOne<{ value: unknown }>(
    "SELECT `value` FROM `settings` WHERE `keyName` = 'site.maintenance'",
  );
  const next = !(current?.value === true);
  await setSetting('site.maintenance', next, auth.user.id);
  invalidate(['setting:site.maintenance']);
  invalidateSettingsCache();
  return c.redirect('/admin?ok=' + encodeURIComponent(
    next ? 'Maintenance mode is now ON.' : 'Maintenance mode is now OFF.',
  ), 302);
});

adminRoutes.post('/maintenance/rotate-token', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
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
  return c.redirect('/admin?ok=' + encodeURIComponent('Preview token rotated. Old preview links no longer work.'), 302);
});

// ── Content types index ────────────────────────────────────────────────

adminRoutes.get('/types', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  const types = await listTypes();
  // Per-type row counts (any locale)
  const counts = new Map<string, number>();
  for (const t of types) {
    const r = await queryOne<{ n: number }>(
      'SELECT COUNT(*) n FROM `content` WHERE `typeSlug` = ?',
      [t.slug],
    );
    counts.set(t.slug, r?.n ?? 0);
  }
  return c.html(
    <AdminPage title="Content Types" active="types" user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>Content Types</h1>
        <span class="muted">{types.length} types</span>
      </div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Label</th>
              <th>URL pattern</th>
              <th>Rows</th>
              <th>Schema rev</th>
            </tr>
          </thead>
          <tbody>
            {types.map((t) => (
              <tr>
                <td>
                  <a href={`/admin/content/${t.slug}`}>{t.slug}</a>
                </td>
                <td class="muted">{t.labelPlural}</td>
                <td class="muted">{t.urlPattern ?? '—'}</td>
                <td class="muted">{counts.get(t.slug) ?? 0}</td>
                <td class="muted">v{t.currentRevision ?? 1}</td>
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
  if (auth instanceof Response) return auth;
  const typeSlug = c.req.param('type');
  const types = await listTypes();
  const t = types.find((x) => x.slug === typeSlug);
  if (!t) return c.html(<AdminPage title="Not found" user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>Unknown type</AdminPage>, 404);

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

  const { rows } = await listContent({
    typeSlug,
    locale: sel === 'all' ? undefined : sel,
    status: ['draft', 'review', 'published', 'archived'],
    includeDrafts: true,
    limit: 200,
    sort: '-updatedAt',
  });

  return c.html(
    <AdminPage title={t.labelPlural} active={typeSlug} user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>
      <div class="top">
        <h1>{t.labelPlural}</h1>
        <a class="btn" href={`/admin/content/${typeSlug}/new`}>
          + New {t.labelSingular}
        </a>
      </div>
      <div class="card" style="margin-bottom:14px;padding:10px 14px">
        <form method="get" style="display:flex;align-items:center;gap:10px;margin:0">
          <label class="muted" for="locale-sel" style="margin:0">Locale</label>
          <select name="locale" id="locale-sel" onchange="this.form.submit()" style="background:#15161c;border:1px solid #333;color:#ccc;padding:4px 8px;border-radius:4px">
            <option value="all" selected={sel === 'all'}>All locales</option>
            {availableLocales.map((l) => (
              <option value={l} selected={sel === l}>{l}</option>
            ))}
          </select>
          <span class="muted" style="margin-left:auto;font-size:12px">
            {rows.length} {rows.length === 1 ? 'row' : 'rows'}{sel !== 'all' ? ` (locale: ${sel})` : ' (all locales)'}
          </span>
        </form>
      </div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Slug</th>
              <th>Locale</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colspan={5} class="muted">
                  No {t.labelPlural.toLowerCase()} yet{sel !== 'all' ? ` in locale "${sel}"` : ''}.
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
                    <StatusBadge status={r.status} />
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
  if (auth instanceof Response) return auth;
  const t = await getTypeBySlug(c.req.param('type'));
  if (!t) return c.html(<AdminPage title="404" user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>Unknown type</AdminPage>, 404);
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'create', t.slug)) {
    return c.html(<AdminPage title="Forbidden" user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>No create permission for {t.slug}</AdminPage>, 403);
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
    if (source && source.typeSlug === t.slug) {
      translationOf = sourceId;
      defaultTitle = source.title;
      defaultSlug = source.slug;
      siblings = await query<{ id: number; locale: string; status: string }>(
        'SELECT `id`, `locale`, `status` FROM `content` WHERE `translationGroupId` = ? AND `typeSlug` = ? ORDER BY `locale`',
        [source.translationGroupId, t.slug],
      );
      availableLocales = await readSiteLocales();
    }
  }

  return c.html(
    <ContentForm
      type={t}
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
  if (auth instanceof Response) return auth;
  const t = await getTypeBySlug(c.req.param('type'));
  if (!t) return c.html(<AdminPage title="404" user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>Unknown type</AdminPage>, 404);
  const row = await findById(Number(c.req.param('id')), true);
  if (!row) return c.html(<AdminPage title="404" user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>Not found</AdminPage>, 404);
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
      [row.translationGroupId, t.slug],
    ),
    readSiteLocales(),
  ]);

  return c.html(
    <ContentForm
      type={t}
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
  if (auth instanceof Response) return auth;
  const t = await getTypeBySlug(c.req.param('type'));
  if (!t) return c.html(<AdminPage title="404" user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>Unknown type</AdminPage>, 404);
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'create', t.slug)) {
    return c.html(<AdminPage title="Forbidden" user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>No create permission</AdminPage>, 403);
  }
  const body = await c.req.parseBody();
  const p = parseContentForm(body, t.fieldsSchema.fields);
  const res = await createContent({
    type: t.slug,
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
      `/admin/content/${t.slug}/new?err=` +
        encodeURIComponent(res.errors[0]?.message ?? 'Validation failed'),
      302,
    );
  }
  invalidateAndNotify('content.created', t.slug, p.locale, res.id);
  let dest = `/admin/content/${t.slug}/${res.id}?ok=Created`;
  if (p.action === 'publish') {
    const pub = await publishContent(res.id, auth.user.id);
    if (pub.ok) {
      invalidateAndNotify('content.published', t.slug, p.locale, res.id);
      dest = `/admin/content/${t.slug}/${res.id}?ok=Published`;
    } else {
      dest = `/admin/content/${t.slug}/${res.id}?err=` +
        encodeURIComponent('Saved as draft; publish blocked: ' + (pub.errors[0]?.message ?? ''));
    }
  }
  return c.redirect(dest, 302);
});

// ── Content editor: update / publish / unpublish / delete (POST) ───────

adminRoutes.post('/content/:type/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  const t = await getTypeBySlug(c.req.param('type'));
  const id = Number(c.req.param('id'));
  if (!t) return c.html(<AdminPage title="404" user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>Unknown type</AdminPage>, 404);
  const existing = await findById(id, true);
  if (!existing) return c.html(<AdminPage title="404" user={{ ...auth.user, roleSlug: auth.role.slug }} caps={auth.role.capabilities}>Not found</AdminPage>, 404);

  const body = await c.req.parseBody();
  const p = parseContentForm(body, t.fieldsSchema.fields);
  const back = `/admin/content/${t.slug}/${id}`;

  if (p.action === 'delete') {
    if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'delete', t.slug, existing.authorId)) {
      return c.redirect(`${back}?err=No+delete+permission`, 302);
    }
    await deleteContent(id, false);
    invalidateAndNotify('content.deleted', t.slug, existing.locale, id);
    return c.redirect(`/admin/content/${t.slug}`, 302);
  }

  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'update', t.slug, existing.authorId)) {
    return c.redirect(`${back}?err=No+update+permission`, 302);
  }

  const upd = await updateContent(
    id,
    { title: p.title, slug: p.slug, fields: p.fields, seo: p.seo, ai: p.ai },
    auth.user.id,
  );
  if (!upd.ok) {
    return c.redirect(`${back}?err=` + encodeURIComponent(upd.errors[0]?.message ?? 'Update failed'), 302);
  }
  invalidateAndNotify('content.updated', t.slug, existing.locale, id);

  if (p.action === 'publish') {
    if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'publish', t.slug, existing.authorId)) {
      return c.redirect(`${back}?err=No+publish+permission`, 302);
    }
    const pub = await publishContent(id, auth.user.id);
    if (!pub.ok) {
      return c.redirect(`${back}?err=` + encodeURIComponent('Publish blocked: ' + (pub.errors[0]?.message ?? '')), 302);
    }
    invalidateAndNotify('content.published', t.slug, existing.locale, id);
    return c.redirect(`${back}?ok=Published`, 302);
  }
  if (p.action === 'unpublish') {
    await unpublishContent(id, auth.user.id);
    invalidateAndNotify('content.unpublished', t.slug, existing.locale, id);
    return c.redirect(`${back}?ok=Unpublished`, 302);
  }
  return c.redirect(`${back}?ok=Saved`, 302);
});
