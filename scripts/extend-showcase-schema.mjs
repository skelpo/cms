// Extend the `showcase` content type with the structured fields needed
// to power rich custom showcase pages (hero badge + headline, CTAs,
// repeater of features, "how it's built" steps, platform details, and a
// screenshot gallery). Then populate the `pry` row with the same data
// that perry.land's hand-coded /showcase/pry page used to read from the
// `pry.*` i18n bundle.
//
// Idempotent. Safe to re-run.

const CMS = process.env.CMS_URL ?? 'http://127.0.0.1:3137';
const EMAIL = process.env.CMS_EMAIL ?? 'admin@skelpo.test';
const PASSWORD = process.env.CMS_PASSWORD ?? 'Test1234!';

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

// ── 1. Extend showcase type schema ──────────────────────────────────

const richFields = [
  { name: 'headline',        type: 'text',     label: 'Hero headline',          translatable: true, required: false, validation: { maxLength: 120 } },
  { name: 'badge',           type: 'text',     label: 'Hero badge',             translatable: true, required: false, validation: { maxLength: 40 } },
  { name: 'ctaPrimary',      type: 'text',     label: 'Primary CTA label',      translatable: true, required: false },
  { name: 'ctaPrimaryUrl',   type: 'url',      label: 'Primary CTA URL',        required: false },
  { name: 'ctaSecondary',    type: 'text',     label: 'Secondary CTA label',    translatable: true, required: false },
  { name: 'ctaSecondaryUrl', type: 'url',      label: 'Secondary CTA URL',      required: false },
  { name: 'features',        type: 'repeater', label: 'Features',               required: false,
    repeater: { fields: [
      { name: 'title',       type: 'text',     label: 'Title',                  translatable: true, required: true },
      { name: 'description', type: 'textarea', label: 'Description',            translatable: true, required: true },
    ]} },
  { name: 'howItsBuilt',     type: 'repeater', label: "How it's built",         required: false,
    repeater: { fields: [
      { name: 'title',       type: 'text',     label: 'Step title',             translatable: true, required: true },
      { name: 'description', type: 'textarea', label: 'Step description',       translatable: true, required: true },
    ]} },
  { name: 'platformDetails', type: 'repeater', label: 'Platform details',       required: false,
    repeater: { fields: [
      { name: 'name',        type: 'text',     label: 'Platform',               required: true },
      { name: 'framework',   type: 'text',     label: 'UI framework',           required: true },
      { name: 'status',      type: 'text',     label: 'Status',                 translatable: true, required: true },
    ]} },
  { name: 'gallery',         type: 'gallery',  label: 'Screenshot gallery',     required: false },
  { name: 'galleryNote',     type: 'textarea', label: 'Note under gallery',     translatable: true, required: false },
];

const current = await (await fetch(`${CMS}/api/v1/types/showcase`)).json();
if (!current.data) throw new Error('showcase type not found');
const currentFields = current.data.fieldsSchema.fields ?? [];
const have = new Set(currentFields.map((f) => f.name));
const merged = [...currentFields];
let added = 0;
for (const f of richFields) {
  if (have.has(f.name)) continue;
  merged.push(f);
  added++;
}
if (added > 0) {
  const r = await fetch(`${CMS}/api/v1/types/showcase`, {
    method: 'PATCH', headers: authHeaders,
    body: JSON.stringify({ fieldsSchema: { version: (current.data.fieldsSchema.version ?? 1), fields: merged } }),
  });
  if (!r.ok) throw new Error(`PATCH showcase: ${r.status} ${await r.text()}`);
  const { data } = await r.json();
  console.log(`Schema extended: +${added} fields, new revision=${data.newRevision}, affectedRows=${data.affectedRows}`);
} else {
  console.log('Schema already up to date.');
}

// ── 2. Populate pry's rich data ─────────────────────────────────────

const pryFields = {
  headline: 'Built with Perry. Compiled to native.',
  badge: 'Available',
  ctaPrimary: 'View on GitHub',
  ctaPrimaryUrl: 'https://github.com/perryts/pry',
  ctaSecondary: 'Read the blog post',
  ctaSecondaryUrl: '/blog/building-pry',
  features: [
    { title: 'Tree View',          description: 'Collapsible, navigable tree rendering for deeply nested JSON structures.' },
    { title: 'Search',             description: 'Full-text search across keys and values with instant highlighting.' },
    { title: 'Keyboard Shortcuts', description: 'Navigate, expand, collapse, and copy with keyboard-only workflow.' },
    { title: 'Clipboard Support',  description: 'Copy any node or subtree to clipboard as formatted JSON.' },
    { title: 'Status Bar',         description: 'Shows node count, current depth, file size, and parse time.' },
    { title: 'Syntax Coloring',    description: 'Color-coded values by type — strings, numbers, booleans, null.' },
  ],
  howItsBuilt: [
    { title: 'TypeScript Source', description: "Standard TypeScript with Perry's native UI API." },
    { title: 'Perry Compile',     description: 'SWC parse → type resolution → LLVM codegen.' },
    { title: 'Native Binary',     description: 'Standalone executable with zero runtime dependencies.' },
  ],
  platformDetails: [
    { name: 'macOS',   framework: 'AppKit', status: 'Available' },
    { name: 'iOS',     framework: 'UIKit',  status: 'Available' },
    { name: 'Android', framework: 'Views',  status: 'Available' },
  ],
  gallery: [],
  galleryNote: 'Screenshots will be added as Pry development continues. Check the GitHub repo for the latest.',
};

const pryRow = await (await fetch(`${CMS}/api/v1/content/by-slug/showcase/pry?locale=en`)).json();
if (!pryRow.data) throw new Error('pry showcase row not found');
const row = pryRow.data;
const mergedFields = { ...row.fields, ...pryFields, hasFeaturePage: true };

const upd = await fetch(`${CMS}/api/v1/content/${row.id}`, {
  method: 'PATCH', headers: authHeaders,
  body: JSON.stringify({ fields: mergedFields }),
});
if (!upd.ok) throw new Error(`PATCH pry row: ${upd.status} ${await upd.text()}`);
console.log(`pry row updated: +${Object.keys(pryFields).length} structured fields.`);

console.log('\nDone.');
