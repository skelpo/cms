// Migrates perry.land's blog catalog into a running Skelpo CMS.
//
// Reads ~/projects/perry/landing/src/lib/blog.ts for post metadata and
// src/content/blog/<slug>/en.tsx for body content (JSX → cleaned HTML),
// then creates + publishes each as a `post` via the CMS API.
//
// Safe + idempotent: skips posts whose slug already exists. Touches only
// the CMS database, never the perry/landing source.
//
// Usage:
//   node scripts/import-perry-landing.mjs \
//     --cms http://127.0.0.1:3137 \
//     --landing ~/projects/perry/landing \
//     --email admin@skelpo.test --password 'Test1234!'

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function expand(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

const CMS = arg('cms', 'http://127.0.0.1:3137');
const LANDING = expand(arg('landing', join(homedir(), 'projects/perry/landing')));
const EMAIL = arg('email', 'admin@skelpo.test');
const PASSWORD = arg('password', 'Test1234!');

// ── Parse blog.ts metadata ─────────────────────────────────────────────

function parseBlogRegistry(src) {
  // Pull each { slug, title, date, excerpt, tags } object. The file is
  // hand-authored with a stable shape, so a tolerant block parser works.
  const posts = [];
  const re = /\{\s*slug:\s*"([^"]+)",\s*title:\s*"((?:[^"\\]|\\.)*)",\s*date:\s*"([^"]+)",\s*excerpt:\s*\n?\s*"((?:[^"\\]|\\.)*)",\s*tags:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    posts.push({
      slug: m[1],
      title: m[2].replace(/\\"/g, '"'),
      date: m[3],
      excerpt: m[4].replace(/\\"/g, '"').replace(/\s+/g, ' ').trim(),
      tags: m[5]
        .split(',')
        .map((t) => t.trim().replace(/^"|"$/g, ''))
        .filter(Boolean),
    });
  }
  return posts;
}

// ── JSX → cleaned HTML ─────────────────────────────────────────────────

function jsxToHtml(jsx) {
  let s = jsx;
  // Strip the component wrapper.
  s = s.replace(/^[\s\S]*?return\s*\(\s*/, '');
  s = s.replace(/\s*\)\s*;\s*}\s*$/, '');
  s = s.replace(/^\s*<>\s*/, '').replace(/\s*<\/>\s*$/, '');

  // Code blocks: <pre><code>{`...`}</code></pre> → keep inner, unescape.
  s = s.replace(
    /<pre>\s*<code(?:\s+className="[^"]*")?>\s*\{`([\s\S]*?)`\}\s*<\/code>\s*<\/pre>/g,
    (_, code) => {
      const text = code
        .replace(/\\`/g, '`')
        .replace(/\\\$/g, '$')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<pre><code>${text}</code></pre>`;
    },
  );

  // Inline code with template literal.
  s = s.replace(/<code(?:\s+className="[^"]*")?>\{`([^`]*)`\}<\/code>/g, (_, c) =>
    `<code>${c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`,
  );

  // Remove className attributes (string and expression forms).
  s = s.replace(/\s+className=("[^"]*"|\{[^}]*\})/g, '');
  // JSX whitespace tokens.
  s = s.replace(/\{"\s*"\}/g, ' ').replace(/\{' '\}/g, ' ').replace(/\{`\s*`\}/g, ' ');
  // Common JSX-escaped entities → real chars (HTML keeps them fine).
  s = s.replace(/\{"—"\}/g, '—');
  // Leftover simple JSX string expressions {"..."} → contents.
  s = s.replace(/\{"((?:[^"\\]|\\.)*)"\}/g, (_, t) => t.replace(/\\"/g, '"'));
  // Self-closing normalization for <br/> <hr/> already valid HTML.
  // Collapse excess whitespace between tags.
  s = s.replace(/>\s+</g, '> <').trim();
  return s;
}

async function loadBody(slug) {
  const p = join(LANDING, 'src/content/blog', slug, 'en.tsx');
  try {
    const jsx = await readFile(p, 'utf8');
    const html = jsxToHtml(jsx);
    // Sanity: must contain at least one tag and be non-trivial.
    if (html.length > 40 && /<\/?[a-z]/i.test(html)) return html;
  } catch {
    /* no content file */
  }
  return null;
}

// ── CMS API ────────────────────────────────────────────────────────────

async function login() {
  const r = await fetch(`${CMS}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  // Body token IS the session id; auth middleware reads it from the
  // skelpoSession cookie (Bearer path only matches apiTokens).
  return j.data.token;
}

async function postExists(token, slug) {
  const r = await fetch(
    `${CMS}/api/v1/content/by-slug/post/${slug}?locale=en`,
    { headers: { Cookie: `skelpoSession=${token}` } },
  );
  return r.ok;
}

async function createPost(token, post, bodyHtml) {
  const metaDescription =
    post.excerpt.length >= 70
      ? post.excerpt.slice(0, 160)
      : (post.excerpt + ' — Perry is a native TypeScript compiler.').slice(0, 160);
  const res = await fetch(`${CMS}/api/v1/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `skelpoSession=${token}` },
    body: JSON.stringify({
      type: 'post',
      slug: post.slug,
      locale: 'en',
      title: post.title,
      status: 'draft',
      fields: {
        excerpt: post.excerpt.slice(0, 280),
        body: bodyHtml ?? `<p>${post.excerpt}</p>`,
        tags: post.tags,
      },
      seo: { metaDescription },
      ai: { summary: post.excerpt.slice(0, 200) },
    }),
  });
  if (!res.ok) throw new Error(`create ${post.slug}: ${res.status} ${await res.text()}`);
  const { data } = await res.json();
  // publish
  const pub = await fetch(`${CMS}/api/v1/content/${data.id}/publish`, {
    method: 'POST',
    headers: { Cookie: `skelpoSession=${token}` },
  });
  if (!pub.ok) throw new Error(`publish ${post.slug}: ${pub.status} ${await pub.text()}`);
  return data.id;
}

// ── Main ───────────────────────────────────────────────────────────────

const blogSrc = await readFile(join(LANDING, 'src/lib/blog.ts'), 'utf8');
const posts = parseBlogRegistry(blogSrc);
console.log(`Parsed ${posts.length} posts from blog.ts`);

const token = await login();
console.log('Authenticated.');

let created = 0, skipped = 0, withBody = 0, failed = 0;
for (const post of posts) {
  if (await postExists(token, post.slug)) {
    skipped++;
    continue;
  }
  const body = await loadBody(post.slug);
  try {
    const id = await createPost(token, post, body);
    if (body) withBody++;
    created++;
    console.log(`  + #${id} ${post.slug}${body ? ' (with body)' : ' (excerpt only)'}`);
  } catch (e) {
    failed++;
    console.log(`  ! ${post.slug} FAILED: ${(e.message || e).slice(0, 160)}`);
  }
}

console.log(
  `\nDone. created=${created} skipped(existing)=${skipped} failed=${failed} withBody=${withBody}/${created}`,
);
