// Migrate perry.land's showcase + compare data into Skelpo CMS.
//
// - Creates a `showcase` custom content type and one row per project.
// - Stores `compareItems` as a single setting (small enough; not editorial).
//
// Idempotent.

import { readFile } from 'node:fs/promises';
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

async function login() {
  const r = await fetch(`${CMS}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login: ${r.status}`);
  return (await r.json()).data.token;
}

const token = await login();
console.log('Authenticated.');

// ── 1. Showcase content type ──────────────────────────────────────────

const types = await (await fetch(`${CMS}/api/v1/types`)).json();
const hasShowcase = (types.data ?? []).some((t) => t.slug === 'showcase');
if (!hasShowcase) {
  const r = await fetch(`${CMS}/api/v1/types`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `skelpoSession=${token}` },
    body: JSON.stringify({
      slug: 'showcase',
      labelSingular: 'Showcase Project',
      labelPlural: 'Showcase Projects',
      isRoutable: true,
      urlPattern: '/showcase/:slug',
      icon: 'sparkles',
      fieldsSchema: {
        version: 1,
        fields: [
          { name: 'tagline',     type: 'text',         label: 'Tagline', translatable: true, required: true, validation: { maxLength: 160 } },
          { name: 'description', type: 'textarea',     label: 'Description', translatable: true },
          { name: 'platforms',   type: 'multiselect',  label: 'Platforms', validation: { options: ['macOS','iOS','iPadOS','watchOS','tvOS','Android','Linux','Windows','Wasm','Web'] } },
          { name: 'tags',        type: 'multiselect',  label: 'Tags' },
          { name: 'githubUrl',   type: 'url',          label: 'GitHub URL' },
          { name: 'logoUrl',     type: 'url',          label: 'Logo URL' },
          { name: 'hasFeaturePage', type: 'boolean',   label: 'Has feature page' },
        ],
      },
    }),
  });
  if (!r.ok) throw new Error(`create showcase type: ${r.status} ${await r.text()}`);
  console.log('  + content type: showcase');
}

// ── 2. Migrate showcase rows ──────────────────────────────────────────

// Parse the showcase TS source to extract the array (tolerant: matches
// each `{ slug: "...", name: "...", tagline: "...", description: "...",
// platforms: [...], githubUrl: "...", tags: [...], hasFeaturePage: ...,
// logoUrl: "..." }` literal).
const src = await readFile(join(LANDING, 'src/lib/showcase.ts'), 'utf8');
const projects = [];
const block = src.match(/showcaseProjects:\s*ShowcaseProject\[\]\s*=\s*\[([\s\S]*?)^\];/m);
if (!block) throw new Error('could not locate showcaseProjects literal');
const arrBody = block[1];
const objRe = /\{([\s\S]*?)\}\s*,?\s*(?=\{|$)/g;
let m;
while ((m = objRe.exec(arrBody)) !== null) {
  const body = m[1];
  const field = (name, pat) => {
    const r = body.match(new RegExp(`${name}:\\s*${pat}`));
    return r ? r[1] : null;
  };
  const list = (name) => {
    const r = body.match(new RegExp(`${name}:\\s*\\[([^\\]]*)\\]`));
    return r ? r[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : [];
  };
  const slug = field('slug', '"([^"]+)"');
  if (!slug) continue;
  projects.push({
    slug,
    name: field('name', '"([^"]+)"') ?? slug,
    tagline: (field('tagline', '"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"') ?? '').replace(/\\"/g, '"'),
    description: (field('description', '\\s*\n?\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"') ?? '').replace(/\\"/g, '"').replace(/\s+/g, ' ').trim(),
    platforms: list('platforms'),
    githubUrl: field('githubUrl', '"([^"]+)"') ?? '',
    tags: list('tags'),
    hasFeaturePage: /hasFeaturePage:\s*true/.test(body),
    logoUrl: field('logoUrl', '"([^"]+)"') ?? '',
  });
}
console.log(`Parsed ${projects.length} showcase projects.`);

let created = 0, skipped = 0;
for (const p of projects) {
  const ex = await fetch(`${CMS}/api/v1/content/by-slug/showcase/${p.slug}?locale=en`);
  if (ex.ok) { skipped++; continue; }
  const md = (p.description.length >= 70 ? p.description : (p.description + ' — A native app built with Perry.')).slice(0, 160);
  const body = {
    type: 'showcase',
    slug: p.slug,
    locale: 'en',
    title: p.name,
    status: 'draft',
    fields: {
      tagline: p.tagline.slice(0, 160),
      description: p.description,
      platforms: p.platforms,
      tags: p.tags,
      githubUrl: p.githubUrl,
      logoUrl: p.logoUrl,
      hasFeaturePage: p.hasFeaturePage,
    },
    seo: { metaDescription: md },
    ai: { summary: p.tagline.slice(0, 200) },
  };
  const res = await fetch(`${CMS}/api/v1/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `skelpoSession=${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) { console.log(`  ! ${p.slug}: ${res.status} ${(await res.text()).slice(0,140)}`); continue; }
  const { data } = await res.json();
  await fetch(`${CMS}/api/v1/content/${data.id}/publish`, { method: 'POST', headers: { Cookie: `skelpoSession=${token}` } });
  console.log(`  + showcase/${p.slug}`);
  created++;
}
console.log(`Showcase: created=${created} skipped=${skipped}`);

// ── 3. Compare items → settings ──────────────────────────────────────

const cmpSrc = await readFile(join(LANDING, 'src/lib/compare.ts'), 'utf8');
const cmpItems = [];
const arr = cmpSrc.match(/compareItems:\s*CompareItem\[\]\s*=\s*\[([\s\S]*?)^\];/m);
if (arr) {
  const re = /\{[\s\S]*?slug:\s*"([^"]+)",\s*competitor:\s*"([^"]+)",\s*category:\s*"([^"]+)",\s*updated:\s*"([^"]+)"[\s\S]*?\}/g;
  let mm;
  while ((mm = re.exec(arr[1])) !== null) {
    cmpItems.push({ slug: mm[1], competitor: mm[2], category: mm[3], updated: mm[4] });
  }
}
await fetch(`${CMS}/api/v1/settings/compare.items`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Cookie: `skelpoSession=${token}` },
  body: JSON.stringify({ value: cmpItems }),
});
console.log(`compare.items → ${cmpItems.length} entries`);

console.log('\nDone.');
