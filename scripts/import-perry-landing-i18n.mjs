// Migrate non-en blog post translations from perry.land. For each post
// already in CMS (en row exists), walks src/content/blog/<slug>/<l>.tsx
// for every l ≠ en, converts JSX → HTML (same cleaner as import-perry-
// landing.mjs), creates a translated post linked via translationOf to
// the en sibling. Idempotent: skips locales that already exist.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

const CMS = arg('cms', 'http://127.0.0.1:3137');
const LANDING = expand(arg('landing', join(homedir(), 'projects/perry/landing')));
const EMAIL = arg('email', 'admin@skelpo.test');
const PASSWORD = arg('password', 'Test1234!');

// ── JSX → HTML (same cleaner as import-perry-landing.mjs) ──────────────

function jsxToHtml(jsx) {
  let s = jsx;
  s = s.replace(/^[\s\S]*?return\s*\(\s*/, '');
  s = s.replace(/\s*\)\s*;\s*}\s*$/, '');
  s = s.replace(/^\s*<>\s*/, '').replace(/\s*<\/>\s*$/, '');
  s = s.replace(
    /<pre>\s*<code(?:\s+className="[^"]*")?>\s*\{`([\s\S]*?)`\}\s*<\/code>\s*<\/pre>/g,
    (_, code) => {
      const text = code
        .replace(/\\`/g, '`')
        .replace(/\\\$/g, '$')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<pre><code>${text}</code></pre>`;
    },
  );
  s = s.replace(/<code(?:\s+className="[^"]*")?>\{`([^`]*)`\}<\/code>/g, (_, c) =>
    `<code>${c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`,
  );
  s = s.replace(/\s+className=("[^"]*"|\{[^}]*\})/g, '');
  s = s.replace(/\{"\s*"\}/g, ' ').replace(/\{' '\}/g, ' ').replace(/\{`\s*`\}/g, ' ');
  s = s.replace(/\{"—"\}/g, '—');
  s = s.replace(/\{"((?:[^"\\]|\\.)*)"\}/g, (_, t) => t.replace(/\\"/g, '"'));
  s = s.replace(/>\s+</g, '> <').trim();
  return s;
}

// ── CMS API ────────────────────────────────────────────────────────────

async function login() {
  const r = await fetch(`${CMS}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login: ${r.status}`);
  const { data } = await r.json();
  return data.token;
}

async function getEnPost(token, slug) {
  const r = await fetch(`${CMS}/api/v1/content/by-slug/post/${slug}?locale=en`, {
    headers: { Cookie: `skelpoSession=${token}` },
  });
  if (!r.ok) return null;
  const { data } = await r.json();
  return data;
}

async function existsLocale(token, slug, locale) {
  const r = await fetch(`${CMS}/api/v1/content/by-slug/post/${slug}?locale=${locale}`, {
    headers: { Cookie: `skelpoSession=${token}` },
  });
  return r.ok;
}

async function createTranslation(token, enPost, locale, title, bodyHtml, excerpt) {
  const md =
    (excerpt && excerpt.length >= 70 ? excerpt : (excerpt || enPost.fields.excerpt || enPost.title)).slice(0, 160);
  const body = {
    type: 'post',
    slug: enPost.slug,
    locale,
    title,
    status: 'draft',
    translationOf: enPost.id,
    fields: {
      excerpt: (excerpt ?? enPost.fields.excerpt ?? '').slice(0, 280),
      body: bodyHtml ?? `<p>${excerpt ?? enPost.fields.excerpt ?? ''}</p>`,
      tags: enPost.fields.tags ?? [],
    },
    seo: { metaDescription: md.length < 70 ? (md + ' — Perry is a native TypeScript compiler.').slice(0, 160) : md },
    ai: { summary: (excerpt ?? enPost.fields.excerpt ?? '').slice(0, 200) },
  };
  const res = await fetch(`${CMS}/api/v1/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `skelpoSession=${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create ${enPost.slug}/${locale}: ${res.status} ${await res.text()}`);
  const { data } = await res.json();
  const pub = await fetch(`${CMS}/api/v1/content/${data.id}/publish`, {
    method: 'POST', headers: { Cookie: `skelpoSession=${token}` },
  });
  if (!pub.ok) throw new Error(`publish ${enPost.slug}/${locale}: ${pub.status} ${await pub.text()}`);
  return data.id;
}

// Try to extract a localized title/excerpt from the JSX content file's
// first <h1>/<p>; falls back to the en metadata.
function sniffLocalTitleExcerpt(jsx, fallbackTitle, fallbackExcerpt) {
  const titleM = jsx.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const pM = jsx.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  const strip = (s) => s
    .replace(/<[^>]+>/g, '')
    .replace(/\{[^}]+\}/g, '')
    .replace(/\s+/g, ' ')
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .trim();
  const title = titleM ? strip(titleM[1]).slice(0, 200) : null;
  const excerpt = pM ? strip(pM[1]).slice(0, 280) : null;
  return { title: title || fallbackTitle, excerpt: excerpt || fallbackExcerpt };
}

// ── Main ───────────────────────────────────────────────────────────────

const token = await login();
console.log('Authenticated.');

const blogDir = join(LANDING, 'src/content/blog');
const slugs = (await readdir(blogDir)).filter((s) => !s.startsWith('.'));
console.log(`Found ${slugs.length} blog slug dirs.`);

let created = 0, skipped = 0, failed = 0, withBody = 0;
for (const slug of slugs) {
  const en = await getEnPost(token, slug);
  if (!en) { console.log(`  ! ${slug}: no en post in CMS (skip)`); continue; }

  const files = (await readdir(join(blogDir, slug))).filter((f) => f.endsWith('.tsx') && f !== 'en.tsx');
  for (const f of files) {
    const locale = f.replace(/\.tsx$/, '');
    if (await existsLocale(token, slug, locale)) { skipped++; continue; }
    try {
      const jsx = await readFile(join(blogDir, slug, f), 'utf8');
      const bodyHtml = jsxToHtml(jsx);
      const okBody = bodyHtml.length > 40 && /<\/?[a-z]/i.test(bodyHtml);
      const { title, excerpt } = sniffLocalTitleExcerpt(jsx, en.title, en.fields.excerpt);
      await createTranslation(token, en, locale, title, okBody ? bodyHtml : null, excerpt);
      created++;
      if (okBody) withBody++;
    } catch (e) {
      failed++;
      console.log(`  ! ${slug}/${locale}: ${(e.message || e).slice(0, 160)}`);
    }
  }
}
console.log(
  `\nDone. created=${created} skipped(existing)=${skipped} failed=${failed} withBody=${withBody}/${created}`,
);
