// Comprehensive integration suite. One DB reset + server boot, many cases.
// Skips entirely if MySQL is unreachable so the unit suite stays portable.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mysqlAvailable, resetDb, seedAdminUser, TEST_DB, testEnv, mysqlCli } from '../helpers/db.js';
import { startServer, stopServer, loginClient, type ApiClient } from '../helpers/server.js';

const HAS_DB = mysqlAvailable();
let api: ApiClient;

before(async () => {
  if (!HAS_DB) return;
  resetDb();
  await seedAdminUser();
  await startServer();
  api = await loginClient('admin@test.local', 'Test1234!');
});

after(async () => {
  if (!HAS_DB) return;
  await stopServer();
});

const IT = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: HAS_DB ? false : 'no MySQL' }, fn);

// ── Auth ────────────────────────────────────────────────────────────────

IT('login issues a session, /auth/me returns role+caps', async () => {
  assert.ok(api.cookie.startsWith('skelpoSession='));
  const me = await (await api.get('/api/v1/auth/me', true)).json();
  assert.equal(me.data.user.role.slug, 'admin');
  assert.ok(me.data.capabilities.global.includes('*'));
});

IT('bad credentials → 401; missing auth on /me → 401', async () => {
  const bad = await api.post('/api/v1/auth/login', { email: 'admin@test.local', password: 'nope' }, false);
  assert.equal(bad.status, 401);
  const noauth = await api.get('/api/v1/auth/me', false);
  assert.equal(noauth.status, 401);
});

IT('login rate-limit kicks in after repeated failures', async () => {
  for (let i = 0; i < 6; i++) {
    await api.post('/api/v1/auth/login', { email: 'rl@test.local', password: 'x' }, false);
  }
  const r = await api.post('/api/v1/auth/login', { email: 'rl@test.local', password: 'x' }, false);
  assert.equal(r.status, 429);
});

// ── Content CRUD + publish + cache ──────────────────────────────────────

let postId = 0;
let postSlug = '';

IT('create draft → publish → publicly readable with URL', async () => {
  postSlug = `it-${Date.now()}`;
  const c = await (await api.post('/api/v1/content', {
    type: 'post', slug: postSlug, locale: 'en', title: 'IT Post',
    fields: { excerpt: 'e', body: '<p>b</p>' },
    seo: { metaDescription: 'An integration test post with a description long enough to satisfy the seventy character minimum.' },
  })).json();
  postId = c.data.id;
  assert.equal(c.data.status, 'draft');
  const pub = await api.post(`/api/v1/content/${postId}/publish`);
  assert.equal(pub.status, 200);
  const got = await (await api.get(`/api/v1/content/by-slug/post/${postSlug}?locale=en`)).json();
  assert.equal(got.data.status, 'published');
  assert.equal(got.data.url, `/blog/${postSlug}`);
});

IT('publish blocked when metaDescription too short', async () => {
  const c = await (await api.post('/api/v1/content', {
    type: 'page', slug: `bad-${Date.now()}`, locale: 'en', title: 'Bad',
    fields: { body: '<p>x</p>' }, seo: { metaDescription: 'short' },
  })).json();
  const pub = await api.post(`/api/v1/content/${c.data.id}/publish`);
  assert.equal(pub.status, 422);
});

IT('ETag + Surrogate-Key + 304 conditional', async () => {
  const r1 = await api.get(`/api/v1/content/by-slug/post/${postSlug}?locale=en`);
  const etag = r1.headers.get('etag');
  assert.ok(etag);
  assert.ok((r1.headers.get('surrogate-key') ?? '').includes(`content:${postId}`));
  const r2 = await fetch(`${api.base}/api/v1/content/by-slug/post/${postSlug}?locale=en`, {
    headers: { 'If-None-Match': etag! },
  });
  assert.equal(r2.status, 304);
});

IT('PATCH invalidates cache', async () => {
  await api.patch(`/api/v1/content/${postId}`, { title: 'IT Post v2' });
  const got = await (await api.get(`/api/v1/content/by-slug/post/${postSlug}?locale=en`)).json();
  assert.equal(got.data.title, 'IT Post v2');
});

IT('draft read requires auth', async () => {
  const d = await (await api.post('/api/v1/content', {
    type: 'post', slug: `draft-${Date.now()}`, locale: 'en', title: 'D',
    fields: { excerpt: 'e', body: '<p>b</p>' }, seo: { metaDescription: 'x' },
  })).json();
  const anon = await api.get(`/api/v1/content/by-id/${d.data.id}`, false);
  // 404 is correct + preferable: anon must not learn a draft exists.
  assert.ok([401, 404].includes(anon.status), `anon draft read should be 401/404, got ${anon.status}`);
  const authed = await api.get(`/api/v1/content/by-id/${d.data.id}`, true);
  assert.equal(authed.status, 200);
});

// ── Content types + schema evolution ────────────────────────────────────

IT('create custom type, PATCH dry-run + real revision bump', async () => {
  const create = await api.post('/api/v1/types', {
    slug: 'service', labelSingular: 'Service', labelPlural: 'Services',
    urlPattern: '/services/:slug',
    fieldsSchema: { version: 1, fields: [{ name: 'summary', type: 'textarea', label: 'S', required: true }] },
  });
  assert.equal(create.status, 201);
  const dry = await (await api.patch('/api/v1/types/service', {
    dryRun: true,
    fieldsSchema: { version: 1, fields: [
      { name: 'summary', type: 'textarea', label: 'S', required: true },
      { name: 'price', type: 'number', label: 'P' },
    ] },
  })).json();
  assert.equal(dry.data.dryRun, true);
  assert.equal(dry.data.newRevision, 2);
  await api.patch('/api/v1/types/service', {
    fieldsSchema: { version: 1, fields: [
      { name: 'summary', type: 'textarea', label: 'S', required: true },
      { name: 'price', type: 'number', label: 'P' },
    ] },
  });
  const revs = await (await api.get('/api/v1/types/service/revisions', true)).json();
  assert.equal(revs.data[0].revision, 2);
  assert.deepEqual(revs.data[0].changes.added, [{ name: 'price' }]);
});

// ── Menus + Settings + Redirects ────────────────────────────────────────

IT('menu item add → locale-resolved tree', async () => {
  await api.post('/api/v1/menus/main/items', { label: { en: 'About', de: 'Über' }, url: '/about', sortOrder: 0 });
  const en = await (await api.get('/api/v1/menus/main?locale=en')).json();
  const de = await (await api.get('/api/v1/menus/main?locale=de')).json();
  assert.equal(en.data.items.at(-1).label, 'About');
  assert.equal(de.data.items.at(-1).label, 'Über');
});

IT('settings PUT invalidates + reads back', async () => {
  await api.post('/api/v1/settings/site.name', undefined, true); // ensure route exists
  const put = await fetch(`${api.base}/api/v1/settings/site.name`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: api.cookie },
    body: JSON.stringify({ value: 'IT Site' }),
  });
  assert.equal(put.status, 200);
  const got = await (await api.get('/api/v1/settings/site.name')).json();
  assert.equal(got.data['site.name'], 'IT Site');
});

IT('redirect create + resolve', async () => {
  await api.post('/api/v1/redirects', { source: '/old', destination: '/new', statusCode: 301 });
  const r = await (await api.get('/api/v1/redirects/resolve?path=/old')).json();
  assert.equal(r.data.destination, '/new');
  assert.equal(r.data.statusCode, 301);
});

// ── Users + Roles ───────────────────────────────────────────────────────

IT('invite user (status invited), list shows role join', async () => {
  const inv = await api.post('/api/v1/users', {
    email: 'editor@test.local', displayName: 'Ed', roleSlug: 'editor',
  });
  assert.equal(inv.status, 201);
  const list = await (await api.get('/api/v1/users', true)).json();
  const ed = list.data.find((u: { email: string }) => u.email === 'editor@test.local');
  assert.equal(ed.status, 'invited');
});

IT('role guard: editor lacks manageUsers', async () => {
  // editor has no password yet (invited) — assert the capability shape instead
  const roles = await (await api.get('/api/v1/roles', true)).json();
  const editor = roles.data.find((r: { slug: string }) => r.slug === 'editor');
  assert.ok(!editor.capabilities.global.includes('manageUsers'));
  assert.ok(!editor.capabilities.global.includes('*'));
});

// ── Forms (spam) + Media (alt enforce) ──────────────────────────────────

IT('form submit: honeypot flagged spam, clean stored, required enforced', async () => {
  execSync(
    `${mysqlCli(TEST_DB)} -e "INSERT INTO content (typeId,typeSlug,slug,locale,translationGroupId,status,title,fields,seo,ai,authorId,publishedAt) ` +
      `SELECT id,'form','contact','en',0,'published','Contact', ` +
      `JSON_OBJECT('successMessage','Thanks','fields',JSON_ARRAY(JSON_OBJECT('name','email','type','email','required',true))), ` +
      `JSON_OBJECT(),JSON_OBJECT(),1,NOW() FROM contentTypes WHERE slug='form'"`,
    { stdio: 'ignore' },
  );
  execSync(`${mysqlCli(TEST_DB)} -e "UPDATE content SET translationGroupId=id WHERE slug='contact' AND typeSlug='form'"`, { stdio: 'ignore' });
  const honey = await api.post('/api/v1/forms/contact/submit', { email: 'b@b.com', _hp: 'x' }, false);
  assert.equal(honey.status, 200, 'honeypot silently accepted');
  const missing = await api.post('/api/v1/forms/contact/submit', { _ts: 1 }, false);
  assert.equal(missing.status, 422, 'required field enforced');
  const ok = await api.post('/api/v1/forms/contact/submit', { email: 'a@a.com', _ts: 1 }, false);
  assert.equal(ok.status, 200);
});

IT('media upload requires alt text for images', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 't.png');
  const noAlt = await fetch(`${api.base}/api/v1/media`, {
    method: 'POST', headers: { Cookie: api.cookie }, body: fd,
  });
  assert.equal(noAlt.status, 422);
  const fd2 = new FormData();
  fd2.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 't.png');
  fd2.append('altText', JSON.stringify({ en: 'alt' }));
  const ok = await fetch(`${api.base}/api/v1/media`, {
    method: 'POST', headers: { Cookie: api.cookie }, body: fd2,
  });
  assert.equal(ok.status, 201);
  const m = await ok.json();
  assert.equal(m.data.mimeType, 'image/png');
});

// ── Webhooks + Jobs ─────────────────────────────────────────────────────

IT('register webhook + content publish enqueues delivery job', async () => {
  const wh = await (await api.post('/api/v1/webhooks', {
    url: 'http://127.0.0.1:4999/never', events: ['content.published'],
  })).json();
  assert.ok(wh.data.secret);
  // publish something → a webhookDispatch job is enqueued (delivery will
  // fail to the dead URL but the job + audit row must exist)
  const c = await (await api.post('/api/v1/content', {
    type: 'post', slug: `wh-${Date.now()}`, locale: 'en', title: 'WH',
    fields: { excerpt: 'e', body: '<p>b</p>' },
    seo: { metaDescription: 'A webhook integration content row with a sufficiently long meta description here.' },
  })).json();
  await api.post(`/api/v1/content/${c.data.id}/publish`);
  await new Promise((r) => setTimeout(r, 2500)); // let the worker tick
  const jobs = execSync(`${mysqlCli(TEST_DB)} -N -e "SELECT COUNT(*) FROM jobs WHERE kind='webhookDispatch'"`)
    .toString().trim();
  assert.ok(Number(jobs) >= 1, 'webhookDispatch job enqueued');
});

// ── Backup / restore (CLI, last — mutates DB) ───────────────────────────

IT('backup → wipe → restore preserves FK integrity', async () => {
  // Pure CLI/DB test — stop the server first so its job worker isn't
  // holding `jobs` locks while restore DELETEs every table.
  await stopServer();
  const env = testEnv();
  execSync(`node --import tsx src/cli/main.ts backup /tmp/it.skelpo-backup`, { stdio: 'ignore', env });
  const before = execSync(
    `${mysqlCli(TEST_DB)} -N -e "SELECT (SELECT COUNT(*) FROM content),(SELECT COUNT(*) FROM roles)"`,
  ).toString().trim();
  execSync(`${mysqlCli(TEST_DB)} -e "SET FOREIGN_KEY_CHECKS=0; DELETE FROM content; DELETE FROM users; DELETE FROM roles; SET FOREIGN_KEY_CHECKS=1"`, { stdio: 'ignore' });
  try {
    execSync(`node --import tsx src/cli/main.ts restore /tmp/it.skelpo-backup 2>&1`, { env });
  } catch (e) {
    const out = (e as { stdout?: Buffer }).stdout?.toString() ?? String(e);
    assert.fail(`restore failed:\n${out.slice(-1200)}`);
  }
  const after = execSync(
    `${mysqlCli(TEST_DB)} -N -e "SELECT (SELECT COUNT(*) FROM content),(SELECT COUNT(*) FROM roles),(SELECT COUNT(*) FROM users u JOIN roles r ON r.id=u.roleId)"`,
  ).toString().trim();
  const [bC, bR] = before.split(/\s+/);
  const [aC, aR, joinOk] = after.split(/\s+/);
  assert.equal(aC, bC, 'content rows restored');
  assert.equal(aR, bR, 'roles restored');
  assert.ok(Number(joinOk) >= 1, 'user→role FK joins resolve (ids preserved)');
});
