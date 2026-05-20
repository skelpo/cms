// Migrate perry.land's roadmap (~/projects/perry/landing/src/app/[locale]/roadmap/page.tsx)
// into Skelpo CMS:
//   - creates content type `roadmap` (single-row, with a `milestones` repeater)
//   - creates the single `roadmap/roadmap` row, populating all milestones
//
// The original component is a hand-coded array of 4 sections × N milestones
// each: {title, description}. We flatten to one repeater list, tagging each
// entry with its `status` (shipped | inProgress | planned | vision).
//
// Idempotent: re-running upserts the row.

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
const authHeaders = { 'Content-Type': 'application/json', Cookie: `skelpoSession=${token}` };
console.log('Authenticated.');

// ── 1. Parse the original roadmap source ────────────────────────────

const src = await readFile(join(LANDING, 'src/app/[locale]/roadmap/page.tsx'), 'utf8');

// Each section block starts at `labelKey: "<status>"` and ends at the
// next `labelKey:` or at the array closer `];`.
const labelRe = /labelKey:\s*"([^"]+)"/g;
const labelHits = [...src.matchAll(labelRe)];
const sectionsArrayEnd = src.indexOf('\n];', labelHits[labelHits.length - 1].index);

const milestones = [];
let sortOrder = 1;
for (let i = 0; i < labelHits.length; i++) {
  const status = labelHits[i][1];
  const sectionStart = labelHits[i].index;
  const sectionEnd = i + 1 < labelHits.length ? labelHits[i + 1].index : sectionsArrayEnd;
  const body = src.slice(sectionStart, sectionEnd);

  // Each milestone: `{ title: "...", description: "..." }`. Decode the
  // captured TS string via JSON.parse so \uXXXX, \n, \", \\ all resolve.
  const decodeTsString = (raw) => JSON.parse(`"${raw}"`);
  const mRe = /title:\s*"((?:\\.|[^"\\])*)"\s*,\s*description:\s*"((?:\\.|[^"\\])*)"/g;
  for (const m of body.matchAll(mRe)) {
    milestones.push({
      title: decodeTsString(m[1]),
      description: decodeTsString(m[2]),
      status,
      sortOrder: sortOrder++,
    });
  }
}

const byStatus = milestones.reduce((acc, m) => ((acc[m.status] = (acc[m.status] ?? 0) + 1), acc), {});
console.log(`Parsed ${milestones.length} milestones:`, byStatus);

// ── 2. Create the `roadmap` content type if missing ────────────────

const types = await (await fetch(`${CMS}/api/v1/types`)).json();
const hasRoadmap = (types.data ?? []).some((t) => t.slug === 'roadmap');
const fieldsSchema = {
  version: 1,
  fields: [
    { name: 'subtitle',   type: 'textarea', label: 'Subtitle',   translatable: true, required: false },
    { name: 'milestones', type: 'repeater', label: 'Milestones', required: false,
      repeater: { fields: [
        { name: 'title',       type: 'text',     label: 'Title',       translatable: true, required: true },
        { name: 'description', type: 'textarea', label: 'Description', translatable: true, required: true },
        { name: 'status',      type: 'select',   label: 'Status',      required: true,
          validation: { options: ['shipped', 'inProgress', 'planned', 'vision'] } },
        { name: 'sortOrder',   type: 'number',   label: 'Sort order',  required: false },
      ] },
    },
  ],
};

if (!hasRoadmap) {
  const r = await fetch(`${CMS}/api/v1/types`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({
      slug: 'roadmap',
      labelSingular: 'Roadmap',
      labelPlural: 'Roadmaps',
      isRoutable: true,
      urlPattern: '/roadmap',
      icon: 'flag',
      fieldsSchema,
    }),
  });
  if (!r.ok) throw new Error(`create type: ${r.status} ${await r.text()}`);
  console.log('Created content type: roadmap');
} else {
  // Type already exists — make sure the schema has our fields. The CMS
  // diff/migration applies any additions transparently.
  const r = await fetch(`${CMS}/api/v1/types/roadmap`, {
    method: 'PATCH', headers: authHeaders,
    body: JSON.stringify({ fieldsSchema }),
  });
  if (!r.ok) {
    const body = await r.text();
    if (!body.includes('no changes') && !body.includes('identical')) {
      console.log(`(type already present, schema PATCH said: ${r.status} ${body.slice(0, 140)})`);
    }
  }
}

// ── 3. Upsert the single `roadmap/roadmap` row ──────────────────────

const subtitleEn = "Where Perry is today and where it's headed. Native compilation, ecosystem coverage, and the path to v1.";

const existing = await fetch(`${CMS}/api/v1/content/by-slug/roadmap/roadmap?locale=en`);
const fieldsBody = { subtitle: subtitleEn, milestones };

if (existing.ok) {
  const row = (await existing.json()).data;
  const upd = await fetch(`${CMS}/api/v1/content/${row.id}`, {
    method: 'PATCH', headers: authHeaders,
    body: JSON.stringify({ fields: fieldsBody }),
  });
  if (!upd.ok) throw new Error(`PATCH row: ${upd.status} ${await upd.text()}`);
  console.log(`Updated roadmap row #${row.id} with ${milestones.length} milestones.`);
} else {
  const cr = await fetch(`${CMS}/api/v1/content`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({
      type: 'roadmap',
      slug: 'roadmap',
      locale: 'en',
      title: 'Roadmap',
      status: 'draft',
      fields: fieldsBody,
      seo: { metaDescription: subtitleEn.slice(0, 160) },
    }),
  });
  if (!cr.ok) throw new Error(`POST row: ${cr.status} ${await cr.text()}`);
  const { data } = await cr.json();
  await fetch(`${CMS}/api/v1/content/${data.id}/publish`, { method: 'POST', headers: authHeaders });
  console.log(`Created + published roadmap row #${data.id} with ${milestones.length} milestones.`);
}

console.log('\nDone.');
