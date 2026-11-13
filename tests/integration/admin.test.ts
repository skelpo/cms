// HTMX admin UI coverage: auth gate, login/logout, dashboard, content
// editor (GET form + POST create/publish/SEO-gate/delete), and every
// secondary screen incl. their form posts. Auto-skips without MySQL.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mysqlAvailable, resetDb, seedAdminUser, mysqlCli, TEST_DB } from '../helpers/db.js';
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
  assert.match(dash, /Welcome, Admin<\/h1>/);
  assert.match(dash, /stat-l">Pages/);
  assert.match(dash, /Recently edited/);
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

IT('POST create page → 302 ?ok=Draft created; edit form populated', async () => {
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
  assert.match(loc, /\/admin\/content\/page\/\d+\?ok=Draft/);
  pageId = loc.match(/page\/(\d+)/)![1]!;
  const edit = await (await get(`/admin/content/page/${pageId}`)).text();
  assert.match(edit, /Edit Page/);
  assert.match(edit, /value="Admin Page"/);
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

IT('SEO gate: short metaDescription + publish → form re-shown with the problem, input kept', async () => {
  const r = await form('/admin/content/page', {
    title: 'Bad SEO',
    slug: `bad-${Date.now()}`,
    locale: 'en',
    f_body: '<p>x</p>',
    seo_metaDescription: 'short',
    action: 'publish',
  });
  assert.equal(r.status, 422);
  const html = await r.text();
  assert.match(html, /between 70 and 160 characters/);
  assert.match(html, /value="Bad SEO"/, 'typed title is kept');
  assert.match(html, />short<\/textarea>/, 'typed description is kept');
});

IT('content list shows the created page', async () => {
  const html = await (await get('/admin/content/page')).text();
  assert.match(html, /Pages<\/h1>/);
  assert.match(html, new RegExp(pslug));
});

IT('POST delete → row archived, gone from public', async () => {
  const r = await form(`/admin/content/page/${pageId}`, { action: 'delete' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') ?? '', /^\/admin\/content\/page\?ok=/);
  const gone = await fetch(`${BASE}/api/v1/content/by-slug/page/${pslug}?locale=en`);
  assert.equal(gone.status, 404);
});

// ── Secondary screens (render + form posts) ─────────────────────────────

IT('all secondary screens render 200', async () => {
  for (const p of ['settings', 'settings?tab=advanced', 'users', 'profile', 'media', 'forms', 'types', 'types/page', 'redirects', 'menus', 'jobs', 'webhooks']) {
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
    label_en: 'Docs',
    url: '/docs',
  });
  assert.equal(r.status, 302);
  const menu = await (await fetch(`${BASE}/api/v1/menus/main?locale=en`)).json();
  assert.ok(menu.data.items.some((i: { label: string }) => i.label === 'Docs'));
});

IT('admin settings form → persisted + readable via API', async () => {
  // Settings are edited per-key at /admin/settings/:keyName (shape-aware form),
  // not a bulk /admin/settings POST.
  const r = await form('/admin/settings/site.name', { shape: 'string', v: 'Admin Set Name' });
  assert.equal(r.status, 302);
  const s = await (await fetch(`${BASE}/api/v1/settings/site.name`)).json();
  assert.equal(s.data['site.name'], 'Admin Set Name');
});

IT('admin webhook form → created; secret shown on the page, never in a URL', async () => {
  const r = await form('/admin/webhooks', {
    url: 'http://127.0.0.1:4999/never',
    events: 'content.published',
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('location'), null);
  assert.match(await r.text(), /class="secret">[0-9a-f]{64}</);
});

// ── Editor data safety ──────────────────────────────────────────────────

const mysqlOut = (sql: string): string =>
  execSync(`${mysqlCli(TEST_DB)} -N -B -r`, { input: sql, encoding: 'utf8' }).trim();

IT('free-form tags + AI summary survive an edit; trash can be restored', async () => {
  const slug = `post-${Date.now()}`;
  const fields = {
    title: 'Tagged Post',
    slug,
    locale: 'en',
    f_excerpt: 'An excerpt that is long enough to be used as the search description of this test post.',
    f_body: 'Body text.',
    seo_metaDescription: '',
    ai_summary: 'A neutral summary.',
  };
  // The seeded `post` type has free-form tags (a multiselect with no fixed options).
  const created = await form('/admin/content/post', { ...fields, f_tags: 'alpha, beta', action: 'publish' });
  assert.equal(created.status, 302, await created.text());
  const loc = created.headers.get('location') ?? '';
  assert.match(loc, /\?ok=Published/, 'search description is derived from the excerpt');
  const id = loc.match(/post\/(\d+)/)![1]!;
  assert.equal(mysqlOut(`SELECT JSON_EXTRACT(fields,'$.tags') FROM content WHERE id=${id};`), '["alpha", "beta"]');

  const edit = await (await get(`/admin/content/post/${id}`)).text();
  assert.match(edit, />A neutral summary\.<\/textarea>/, 'AI summary is shown, not blanked');
  const saved = await form(`/admin/content/post/${id}`, { ...fields, f_tags: 'alpha, beta', seo_metaDescription: fields.f_excerpt, action: 'save' });
  assert.equal(saved.status, 302);
  assert.equal(mysqlOut(`SELECT JSON_UNQUOTE(JSON_EXTRACT(ai,'$.summary')) FROM content WHERE id=${id};`), 'A neutral summary.');
  assert.equal(mysqlOut(`SELECT JSON_EXTRACT(fields,'$.tags') FROM content WHERE id=${id};`), '["alpha", "beta"]');

  const trashed = await form(`/admin/content/post/${id}/action`, { action: 'trash', return: '/admin/content/post' });
  assert.equal(trashed.status, 302);
  assert.match(await (await get('/admin/content/post?status=trash')).text(), new RegExp(slug));
  await form(`/admin/content/post/${id}/action`, { action: 'restore', return: '/admin/content/post' });
  assert.equal(mysqlOut(`SELECT status FROM content WHERE id=${id};`), 'draft');
});

// ── Accounts ────────────────────────────────────────────────────────────

IT('invite → accept-invite sets a password and signs in', async () => {
  const r = await form('/admin/users', { displayName: 'New Editor', email: 'new.editor@test.local', roleSlug: 'editor', password: '' });
  assert.equal(r.status, 302);
  const token = mysqlOut("SELECT inviteToken FROM users WHERE email='new.editor@test.local';");
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.match(await (await get('/admin/users')).text(), new RegExp(`accept-invite\\?token=${token}`), 'link can be copied by the admin');
  const page = await get(`/admin/accept-invite?token=${token}`, false);
  assert.equal(page.status, 200);
  const done = await form('/admin/accept-invite', { token, password: 'EditorPass99', confirm: 'EditorPass99' }, false);
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/admin');
  assert.match(done.headers.get('set-cookie') ?? '', /skelpoSession=/);
  assert.equal(mysqlOut("SELECT status FROM users WHERE email='new.editor@test.local';"), 'active');
  const login = await form('/admin/login', { email: 'new.editor@test.local', password: 'EditorPass99' }, false);
  assert.equal(login.headers.get('location'), '/admin');
});

IT('forgot-password stores a hashed single-use token; same answer for unknown addresses', async () => {
  const known = await form('/admin/forgot-password', { email: 'new.editor@test.local' }, false);
  const unknown = await form('/admin/forgot-password', { email: 'nobody@test.local' }, false);
  assert.equal(known.headers.get('location'), unknown.headers.get('location'));
  assert.equal(mysqlOut("SELECT COUNT(*) FROM passwordResets p JOIN users u ON u.id=p.userId WHERE u.email='new.editor@test.local';"), '1');
  assert.equal((await get('/admin/reset-password?token=' + 'a'.repeat(64), false)).status, 404);
});

IT('profile: password change needs the current password', async () => {
  const bad = await form('/admin/profile/password', { current: 'wrong', password: 'Another123!', confirm: 'Another123!' });
  assert.match(bad.headers.get('location') ?? '', /\?err=/);
  const good = await form('/admin/profile/password', { current: 'Test1234!', password: 'Test1234!', confirm: 'Test1234!' });
  assert.match(good.headers.get('location') ?? '', /\?ok=/);
  cookie = (good.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.equal((await get('/admin/profile')).status, 200, 'this device stays signed in');
});

IT('settings form saves friendly fields; hidden content types leave the menu', async () => {
  const r = await form('/admin/settings-form/general', {
    site_name: 'Friendly Site', site_tagline: 'Hello', site_url: 'https://example.com',
    site_locales: 'en', site_defaultLocale: 'en', shown_types: 'page',
  });
  assert.match(r.headers.get('location') ?? '', /tab=general&ok=/);
  const dash = await (await get('/admin')).text();
  assert.match(dash, /<title>[^<]*Friendly Site<\/title>/);
  assert.doesNotMatch(dash, /href="\/admin\/content\/doc"/);
});

IT('content list offers a month filter', async () => {
  const month = new Date().toISOString().slice(0, 7);
  const ok = await get(`/admin/content/page?m=${month}`);
  assert.equal(ok.status, 200);
  assert.equal((await get('/admin/content/page?m=not-a-month')).status, 200);
});

IT('media: replacing a file keeps the id and link, and caches revalidate', async () => {
  const png = (w: number) => {
    const b = new Uint8Array(40);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, w, 0, 0, 0, 7]);
    return b;
  };
  const send = (path: string, name: string, bytes: Uint8Array, type: string) => {
    const fd = new FormData();
    fd.append('file', new Blob([bytes as BlobPart], { type }), name);
    return fetch(`${BASE}${path}`, { method: 'POST', body: fd, redirect: 'manual', headers: { Cookie: cookie } });
  };
  const up = (await (await send('/admin/media/upload', 'one.png', png(5), 'image/png')).json()) as { data: { id: number } };
  const id = up.data.id;
  const before = await fetch(`${BASE}/api/v1/media/${id}/raw`);
  assert.match(before.headers.get('cache-control') ?? '', /immutable/);
  await before.arrayBuffer();

  const wrong = await send(`/admin/media/${id}/replace`, 'doc.pdf', new TextEncoder().encode('x'), 'application/pdf');
  assert.match(wrong.headers.get('location') ?? '', /\?err=/, 'an image cannot become a document');

  const done = await send(`/admin/media/${id}/replace`, 'two.png', png(9), 'image/png');
  assert.match(done.headers.get('location') ?? '', /\?ok=/);
  const raw = await fetch(`${BASE}/api/v1/media/${id}/raw`);
  assert.equal(new Uint8Array(await raw.arrayBuffer())[19], 9, 'same URL serves the new bytes');
  assert.match(raw.headers.get('cache-control') ?? '', /must-revalidate/);
  const etag = raw.headers.get('etag') ?? '';
  assert.ok(etag);
  const cached = await fetch(`${BASE}/api/v1/media/${id}/raw`, { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304);
  assert.match(await (await get(`/admin/media/${id}`)).text(), /two\.png/);
});

IT('menus: drag-and-drop order is saved; partial lists are refused', async () => {
  for (const label of ['First', 'Second', 'Third']) {
    await form('/admin/menus/footer/items', { label_en: label, url: `/${label.toLowerCase()}` });
  }
  const ids = () => get('/admin/menus?m=footer').then((r) => r.text())
    .then((html) => [...html.matchAll(/data-menu-item="(\d+)"/g)].map((m) => m[1]!));
  const start = await ids();
  assert.equal(start.length, 3);
  const wanted = [start[2]!, start[0]!, start[1]!];
  const r = await form('/admin/menus/footer/reorder', { ids: wanted.join(',') });
  assert.equal(r.status, 200);
  assert.deepEqual(await ids(), wanted);
  assert.equal((await form('/admin/menus/footer/reorder', { ids: start.slice(1).join(',') })).status, 422);
  assert.equal((await form('/admin/menus/footer/reorder', { ids: `${start[0]},${start[0]},${start[1]}` })).status, 422);
});

IT('visual editor assets are served; unknown files are not', async () => {
  const js = await fetch(`${BASE}/admin/static/tui/toastui-editor-all.min.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /javascript/);
  await js.arrayBuffer();
  assert.equal((await fetch(`${BASE}/admin/static/tui/toastui-editor.min.css`)).status, 200);
  assert.equal((await fetch(`${BASE}/admin/static/tui/..%2F..%2Fhtmx.min.js`)).status, 404);
  const editor = await (await get('/admin/content/page/new')).text();
  assert.match(editor, /data-autosave="/);
});

IT('two-step sign-in: set up, required at sign-in, codes single-use, admin can turn it off', async () => {
  const { totpAt } = await import('../../src/auth/totp.js');
  const setup = await (await form('/admin/profile/2fa/start', {})).text();
  const secret = (setup.match(/<code class="secret">([A-Z2-7 ]+)<\/code>/)?.[1] ?? '').replace(/ /g, '');
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.match(setup, /<svg /, 'QR code is rendered inline');

  const bad = await form('/admin/profile/2fa/confirm', { code: '000000' });
  assert.equal(bad.status, 200, 'a wrong code keeps the setup open');
  const on = await form('/admin/profile/2fa/confirm', { code: await totpAt(secret) });
  assert.match(on.headers.get('location') ?? '', /\?ok=/);

  // Password alone no longer signs in.
  const step1 = await form('/admin/login', { email: 'admin@test.local', password: 'Test1234!' }, false);
  assert.equal(step1.status, 200);
  assert.equal(step1.headers.get('set-cookie'), null, 'no session before the code');
  const ticket = (await step1.text()).match(/name="ticket" value="([0-9a-f]+)"/)?.[1] ?? '';
  assert.ok(ticket);
  assert.equal((await form('/admin/login/code', { ticket, code: '12345' }, false)).status, 401);
  const code = await totpAt(secret);
  const step2 = await form('/admin/login/code', { ticket, code }, false);
  assert.equal(step2.status, 302);
  assert.match(step2.headers.get('location') ?? '', /\/admin$/);
  const fresh = (step2.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.match(fresh, /^skelpoSession=/);

  // The same code cannot be replayed, and the ticket is spent.
  assert.equal((await form('/admin/login/code', { ticket, code }, false)).status, 302);
  const again = await form('/admin/login', { email: 'admin@test.local', password: 'Test1234!' }, false);
  const ticket2 = (await again.text()).match(/name="ticket" value="([0-9a-f]+)"/)?.[1] ?? '';
  assert.equal((await form('/admin/login/code', { ticket: ticket2, code }, false)).status, 401);

  // The JSON API follows the same rule.
  const api = (body: Record<string, string>) => fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const noCode = await api({ email: 'admin@test.local', password: 'Test1234!' });
  assert.equal(noCode.status, 401);
  assert.equal(((await noCode.json()) as { error: { details?: { totpRequired?: boolean } } }).error.details?.totpRequired, true);
  const withCode = await api({ email: 'admin@test.local', password: 'Test1234!', totpCode: await totpAt(secret, Date.now() + 30_000) });
  assert.equal(withCode.status, 200);
  await withCode.arrayBuffer();

  // An administrator sees a reset button for another user who has it on.
  const mk = await form('/admin/users', { email: 'twofa@test.local', displayName: 'Two Fa', password: 'Test1234!', roleSlug: 'viewer' });
  assert.match(mk.headers.get('location') ?? '', /\?ok=/);
  execSync(`${mysqlCli(TEST_DB)} -e "UPDATE users SET totpSecret='${secret}', totpVerified=1 WHERE email='twofa@test.local'"`);
  cookie = fresh;
  const usersHtml = await (await get('/admin/users')).text();
  const otherId = usersHtml.match(/\/admin\/users\/(\d+)"[^>]*>(?:(?!\/admin\/users\/)[\s\S])*?twofa@test\.local/)?.[1]
    ?? [...usersHtml.matchAll(/\/admin\/users\/(\d+)/g)].map((m) => m[1]!).filter((x) => x !== '1').pop() ?? '';
  const editHtml = await (await get(`/admin/users/${otherId}`)).text();
  assert.match(editHtml, /twofa@test\.local/);
  assert.match(editHtml, new RegExp(`/admin/users/${otherId}/reset-2fa`), 'reset button is offered');
  const reset = await form(`/admin/users/${otherId}/reset-2fa`, {});
  assert.match(reset.headers.get('location') ?? '', /\?ok=/);
  assert.doesNotMatch(await (await get(`/admin/users/${otherId}`)).text(), /reset-2fa/);
  const otherLogin = await form('/admin/login', { email: 'twofa@test.local', password: 'Test1234!' }, false);
  assert.equal(otherLogin.status, 302, 'after the reset the password alone signs in');

  // Turning it off needs the password.
  cookie = fresh;
  const wrongPw = await form('/admin/profile/2fa/disable', { current: 'nope' });
  assert.match(wrongPw.headers.get('location') ?? '', /\?err=/);
  const off = await form('/admin/profile/2fa/disable', { current: 'Test1234!' });
  assert.match(off.headers.get('location') ?? '', /\?ok=/);
  const plain = await form('/admin/login', { email: 'admin@test.local', password: 'Test1234!' }, false);
  assert.equal(plain.status, 302, 'password sign-in works again');
  cookie = (plain.headers.get('set-cookie') ?? '').split(';')[0]!;
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
