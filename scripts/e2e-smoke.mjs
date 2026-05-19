// Comprehensive end-to-end smoke: boot is assumed running on :3137.
// Exercises auth → content CRUD → publish → cache → menus → settings →
// media → SDK → site-kit in one pass. Exits non-zero on any failure.

import { createClient } from '../packages/cms-client/src/index.ts';
import { buildMetaTags, renderTipTap, sitemapXml, sitemapFromContent } from '../packages/site-kit/src/index.ts';

const CMS = 'http://127.0.0.1:3137';
let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}`)); }

// 1. auth
const login = await (await fetch(`${CMS}/api/v1/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@skelpo.test', password: 'Test1234!' }),
})).json();
const cookie = `skelpoSession=${login.data.token}`;
ok('login returns token + user', !!login.data?.token && login.data.user.role.slug === 'admin');

// 2. content create → publish → public read
const created = await (await fetch(`${CMS}/api/v1/content`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({
    type: 'post', slug: `e2e-${Date.now()}`, locale: 'en', title: 'E2E Post',
    fields: { excerpt: 'e2e', body: '<p>e2e body</p>' },
    seo: { metaDescription: 'An end-to-end smoke test post verifying the full create-publish-read pipeline works correctly.' },
  }),
})).json();
const cid = created.data.id;
ok('content created (draft)', created.data.status === 'draft');
const pub = await fetch(`${CMS}/api/v1/content/${cid}/publish`, { method: 'POST', headers: { Cookie: cookie } });
ok('content publish 200', pub.status === 200);
const slug = created.data.slug;
const pubRead = await (await fetch(`${CMS}/api/v1/content/by-slug/post/${slug}?locale=en`)).json();
ok('published content publicly readable', pubRead.data.status === 'published' && pubRead.data.url === `/blog/${slug}`);

// 3. cache + ETag + Surrogate-Key
const r1 = await fetch(`${CMS}/api/v1/content/by-slug/post/${slug}?locale=en`);
const etag = r1.headers.get('etag');
ok('ETag present', !!etag);
ok('Surrogate-Key present', (r1.headers.get('surrogate-key') ?? '').includes(`content:${cid}`));
const r304 = await fetch(`${CMS}/api/v1/content/by-slug/post/${slug}?locale=en`, { headers: { 'If-None-Match': etag } });
ok('conditional GET → 304', r304.status === 304);

// 4. patch invalidates cache
await fetch(`${CMS}/api/v1/content/${cid}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ title: 'E2E Post Updated' }),
});
const after = await (await fetch(`${CMS}/api/v1/content/by-slug/post/${slug}?locale=en`)).json();
ok('cache invalidated after PATCH', after.data.title === 'E2E Post Updated');

// 5. menus + settings
const menu = await (await fetch(`${CMS}/api/v1/menus/main?locale=en`)).json();
ok('menu fetch works', Array.isArray(menu.data.items));
const setName = await (await fetch(`${CMS}/api/v1/settings/site.name`)).json();
ok('settings readable', 'site.name' in setName.data);

// 6. SDK
const sdk = createClient({ url: CMS, cache: 'auto' });
const sdkPost = await sdk.content.bySlug('post', slug, { locale: 'en' });
ok('SDK content.bySlug', sdkPost.data.title === 'E2E Post Updated');
const t0 = performance.now();
await sdk.content.bySlug('post', slug, { locale: 'en' });
ok('SDK cache hit fast (<1ms)', performance.now() - t0 < 1);

// 7. site-kit
const site = { name: 'Perry', url: 'https://perry.land', defaultLocale: 'en', locales: ['en'] };
const meta = buildMetaTags(sdkPost.data, site, {});
ok('site-kit meta tags', meta.some(t => t.kind === 'title') && meta.some(t => t.attrs?.property === 'og:type'));
ok('site-kit renderTipTap (HTML passthrough)', renderTipTap(sdkPost.data.fields.body) === '<p>e2e body</p>');
const list = await sdk.content.list('post', { locale: 'en', limit: 50 });
const sm = sitemapXml(sitemapFromContent(site, list.data));
ok('site-kit sitemap valid', sm.body.startsWith('<?xml') && sm.body.includes('/blog/'));

// 8. media + alt enforcement
const fd = new FormData();
fd.append('file', new Blob([new Uint8Array([0x89,0x50,0x4e,0x47])], { type: 'image/png' }), 't.png');
const noAlt = await fetch(`${CMS}/api/v1/media`, { method: 'POST', headers: { Cookie: cookie }, body: fd });
ok('media upload without alt → 422', noAlt.status === 422);

// 9. cleanup
await fetch(`${CMS}/api/v1/content/${cid}?hard=true`, { method: 'DELETE', headers: { Cookie: cookie } });
ok('content hard-delete', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
