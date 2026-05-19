// HTMX admin UI coverage: auth gate, login/logout, dashboard, content
// editor (GET form + POST create/publish/SEO-gate/delete), and every
// secondary screen incl. their form posts. Auto-skips without MySQL.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mysqlAvailable, resetDb, seedAdminUser } from '../helpers/db.js';
import { startServer, stopServer } from '../helpers/server.js';

const HAS_DB = mysqlAvailable();
const BASE = `http://127.0.0.1:${process.env.TEST_PORT ?? '3199'}`;
let cookie = '';

async function form(
  path: string,
  fields: Record<string, string>,
  auth = true,
): Promise<Response> {
  const body = new URLSearchParams(fields).toString();
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(auth && cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
}
const get = (p: string, auth = true) =>
  fetch(`${BASE}${p}`, { redirect: 'manual', headers: auth && cookie ? { Cookie: cookie } : {} });

before(async () => {
  if (!HAS_DB) return;
  resetDb();
  await seedAdminUser();
  await startServer();
});
after(async () => {
  if (!HAS_DB) return;
  await stopServer();
});

const IT = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: HAS_DB ? false : 'no MySQL' }, fn);

// ── Auth gate + login/logout ────────────────────────────────────────────

IT('unauth /admin → 302 to /admin/login', async () => {
  const r = await get('/admin', false);
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') ?? '', /\/admin\/login/);
});

IT('login page renders form; htmx asset served', async () => {
  const page = await (await fetch(`${BASE}/admin/login`)).text();
  assert.match(page, /name="email"/);
  assert.match(page, /name="password"/);
  assert.match(page, /Skelpo<b>CMS<\/b>/);
  const js = await fetch(`${BASE}/admin/static/htmx.min.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /javascript/);
});

IT('bad creds → 302 back to login with err', async () => {
  const r = await form('/admin/login', { email: 'admin@test.local', password: 'nope' }, false);
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') ?? '', /\/admin\/login\?err=/);
});

IT('good creds → 302 /admin + session cookie; dashboard renders', async () => {
  const r = await form('/admin/login', { email: 'admin@test.local', password: 'Test1234!' }, false);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin');
  const setCookie = r.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /skelpoSession=/);
  cookie = setCookie.split(';')[0]!;
  const dash = await (await get('/admin')).text();
  assert.match(dash, /Dashboard<\/h1>/);
  assert.match(dash, /stat-l">Pages/);
  assert.match(dash, /Recently updated/);
});

// ── Content editor ──────────────────────────────────────────────────────

let pageId = '';
const pslug = `admin-${Date.now()}`;

IT('new-content form renders all fields', async () => {
  const html = await (await get('/admin/content/page/new')).text();
  assert.match(html, /<h1>\s*New Page/);
  assert.match(html, /name="title"/);
  assert.match(html, /name="slug"/);
  assert.match(html, /name="f_body"/);
  assert.match(html, /name="seo_metaDescription"/);
});

IT('POST create page → 302 ?ok=Created; edit form populated', async () => {
  const r = await form('/admin/content/page', {
    title: 'Admin Page',
    slug: pslug,
    locale: 'en',
    f_body: '<p>hi</p>',
    seo_metaDescription:
      'A sufficiently long meta description for the admin-created page to satisfy publish validation rules.',
    action: 'save',
  });
  assert.equal(r.status, 302);
  const loc = r.headers.get('location') ?? '';
  assert.match(loc, /\/admin\/content\/page\/\d+\?ok=Created/);
  pageId = loc.match(/page\/(\d+)/)![1]!;
  const edit = await (await get(`/admin/content/page/${pageId}`)).text();
  assert.match(edit, /Edit: Admin Page/);
  assert.match(edit, new RegExp(`value="${pslug}"`));
});

IT('POST publish via action=publish → live on public API', async () => {
  const r = await form(`/admin/content/page/${pageId}`, {
    title: 'Admin Page',
    slug: pslug,
    locale: 'en',
    f_body: '<p>hi</p>',
    seo_metaDescription:
      'A sufficiently long meta description for the admin-created page to satisfy publish validation rules.',
    action: 'publish',
  });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') ?? '', /\?ok=Published/);
  const pub = await (await fetch(`${BASE}/api/v1/content/by-slug/page/${pslug}?locale=en`)).json();
  assert.equal(pub.data.status, 'published');
});

IT('SEO gate: short metaDescription + publish → ?err', async () => {
  const r = await form('/admin/content/page', {
    title: 'Bad SEO',
    slug: `bad-${Date.now()}`,
    locale: 'en',
    f_body: '<p>x</p>',
    seo_metaDescription: 'short',
    action: 'publish',
  });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') ?? '', /\?err=/);
});

IT('content list shows the created page', async () => {
  const html = await (await get('/admin/content/page')).text();
  assert.match(html, /Pages<\/h1>/);
  assert.match(html, new RegExp(pslug));
});

IT('POST delete → row archived, gone from public', async () => {
  const r = await form(`/admin/content/page/${pageId}`, { action: 'delete' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin/content/page');
  const gone = await fetch(`${BASE}/api/v1/content/by-slug/page/${pslug}?locale=en`);
  assert.equal(gone.status, 404);
});

// ── Secondary screens (render + form posts) ─────────────────────────────

IT('all secondary screens render 200', async () => {
  for (const p of ['settings', 'users', 'redirects', 'menus', 'jobs', 'webhooks']) {
    const r = await get(`/admin/${p}`);
    assert.equal(r.status, 200, `/admin/${p}`);
    const html = await r.text();
    assert.match(html, /<h1>/, `/admin/${p} has heading`);
  }
});

IT('admin redirect form → resolvable via API', async () => {
  const r = await form('/admin/redirects', {
    source: '/admin-old',
    destination: '/admin-new',
    statusCode: '301',
  });
  assert.equal(r.status, 302);
  const res = await (await fetch(`${BASE}/api/v1/redirects/resolve?path=/admin-old`)).json();
  assert.equal(res.data.destination, '/admin-new');
});

IT('admin menu-item form → appears in API menu', async () => {
  const r = await form('/admin/menus/main/items', {
    label: 'Docs',
    url: '/docs',
    sortOrder: '2',
  });
  assert.equal(r.status, 302);
  const menu = await (await fetch(`${BASE}/api/v1/menus/main?locale=en`)).json();
  assert.ok(menu.data.items.some((i: { label: string }) => i.label === 'Docs'));
});

IT('admin settings form → persisted + readable via API', async () => {
  const r = await form('/admin/settings', { 's_site.name': 'Admin Set Name' });
  assert.equal(r.status, 302);
  const s = await (await fetch(`${BASE}/api/v1/settings/site.name`)).json();
  assert.equal(s.data['site.name'], 'Admin Set Name');
});

IT('admin webhook form → created (302)', async () => {
  const r = await form('/admin/webhooks', {
    url: 'http://127.0.0.1:4999/never',
    events: 'content.published',
  });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') ?? '', /\/admin\/webhooks\?ok=/);
});

// ── Logout ──────────────────────────────────────────────────────────────

IT('logout clears session → /admin gates again', async () => {
  const r = await get('/admin/logout');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') ?? '', /\/admin\/login/);
  // Old cookie no longer authenticates.
  const after = await fetch(`${BASE}/admin`, {
    redirect: 'manual',
    headers: { Cookie: cookie },
  });
  assert.equal(after.status, 302, 'session invalidated server-side');
});
