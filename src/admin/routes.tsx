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

  const [pages, posts, docs, users, jobsByStatus] = await Promise.all([
    queryOne<{ n: number }>("SELECT COUNT(*) n FROM `content` WHERE `typeSlug`='page'"),
    queryOne<{ n: number }>("SELECT COUNT(*) n FROM `content` WHERE `typeSlug`='post'"),
    queryOne<{ n: number }>("SELECT COUNT(*) n FROM `content` WHERE `typeSlug`='doc'"),
    queryOne<{ n: number }>('SELECT COUNT(*) n FROM `users`'),
    jobStats(),
  ]);
  const recent = await query<{ id: number; title: string; typeSlug: string; status: string; updatedAt: unknown }>(
    'SELECT `id`,`title`,`typeSlug`,`status`,`updatedAt` FROM `content` ORDER BY `updatedAt` DESC LIMIT 8',
  );

  return c.html(
    <AdminPage title="Dashboard" active="dashboard" user={auth.user}>
      <div class="top">
        <h1>Dashboard</h1>
        <span class="muted">Signed in as {auth.user.displayName}</span>
      </div>
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

// ── Content list ───────────────────────────────────────────────────────

adminRoutes.get('/content/:type', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  const typeSlug = c.req.param('type');
  const types = await listTypes();
  const t = types.find((x) => x.slug === typeSlug);
  if (!t) return c.html(<AdminPage title="Not found" user={auth.user}>Unknown type</AdminPage>, 404);

  const { rows } = await listContent({
    typeSlug,
    status: ['draft', 'review', 'published', 'archived'],
    includeDrafts: true,
    limit: 100,
    sort: '-updatedAt',
  });

  return c.html(
    <AdminPage title={t.labelPlural} active={typeSlug} user={auth.user}>
      <div class="top">
        <h1>{t.labelPlural}</h1>
        <a class="btn" href={`/admin/content/${typeSlug}/new`}>
          + New {t.labelSingular}
        </a>
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
                  No {t.labelPlural.toLowerCase()} yet.
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

// ── Content editor: new ────────────────────────────────────────────────

adminRoutes.get('/content/:type/new', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  const t = await getTypeBySlug(c.req.param('type'));
  if (!t) return c.html(<AdminPage title="404" user={auth.user}>Unknown type</AdminPage>, 404);
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'create', t.slug)) {
    return c.html(<AdminPage title="Forbidden" user={auth.user}>No create permission for {t.slug}</AdminPage>, 403);
  }
  return c.html(<ContentForm type={t} fields={{}} seo={{}} user={auth.user} />);
});

// ── Content editor: edit (must come AFTER /new) ────────────────────────

adminRoutes.get('/content/:type/:id{[0-9]+}', async (c) => {
  const auth = gate(c);
  if (auth instanceof Response) return auth;
  const t = await getTypeBySlug(c.req.param('type'));
  if (!t) return c.html(<AdminPage title="404" user={auth.user}>Unknown type</AdminPage>, 404);
  const row = await findById(Number(c.req.param('id')), true);
  if (!row) return c.html(<AdminPage title="404" user={auth.user}>Not found</AdminPage>, 404);
  const fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields;
  const seo = typeof row.seo === 'string' ? JSON.parse(row.seo) : row.seo;
  const flash = c.req.query('ok')
    ? { ok: c.req.query('ok')! }
    : c.req.query('err')
      ? { err: c.req.query('err')! }
      : undefined;
  return c.html(
    <ContentForm type={t} row={row} fields={fields} seo={seo} user={auth.user} flash={flash} />,
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
  if (!t) return c.html(<AdminPage title="404" user={auth.user}>Unknown type</AdminPage>, 404);
  if (!can({ userId: auth.user.id, caps: auth.role.capabilities }, 'create', t.slug)) {
    return c.html(<AdminPage title="Forbidden" user={auth.user}>No create permission</AdminPage>, 403);
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
  if (!t) return c.html(<AdminPage title="404" user={auth.user}>Unknown type</AdminPage>, 404);
  const existing = await findById(id, true);
  if (!existing) return c.html(<AdminPage title="404" user={auth.user}>Not found</AdminPage>, 404);

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
