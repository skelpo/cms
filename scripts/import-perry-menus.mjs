// Populate the two built-in menus (`main` for the header, `footer` for
// the footer) with the items perry-landing-skelpo currently hardcodes in
// its layout. After this lands the customer site reads them via
// cms.menus.get(slug) and any edit in /admin/menus reflects live.
//
// Footer is rendered as 3 columns (Resources, Community, Enterprise),
// modelled here as 3 top-level items each with children. Section parents
// use url=null so the renderer knows to render them as headings.
//
// Idempotent: deletes existing items in each menu before adding fresh.

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
const auth = { 'Content-Type': 'application/json', Cookie: `skelpoSession=${token}` };
console.log('Authenticated.');

async function flatItems(slug) {
  const r = await fetch(`${CMS}/api/v1/menus/${slug}`);
  if (!r.ok) return [];
  const tree = (await r.json()).data?.items ?? [];
  const out = [];
  function walk(items) {
    for (const it of items) {
      out.push(it);
      if (it.children?.length) walk(it.children);
    }
  }
  walk(tree);
  return out;
}

async function wipeMenu(slug) {
  // Delete leaves first; parents last. Re-fetch each time because the
  // tree changes.
  while (true) {
    const items = await flatItems(slug);
    if (items.length === 0) break;
    // Find leaves (no children)
    const leaves = items.filter((i) => !i.children?.length);
    if (leaves.length === 0) {
      // All remaining are interior (orphaned). Delete in reverse.
      for (const it of items.reverse()) {
        await fetch(`${CMS}/api/v1/menus/${slug}/items/${it.id}`, {
          method: 'DELETE', headers: { Cookie: `skelpoSession=${token}` },
        });
      }
      break;
    }
    for (const it of leaves) {
      await fetch(`${CMS}/api/v1/menus/${slug}/items/${it.id}`, {
        method: 'DELETE', headers: { Cookie: `skelpoSession=${token}` },
      });
    }
  }
  console.log(`Wiped "${slug}"`);
}

async function addItem(menuSlug, body) {
  const r = await fetch(`${CMS}/api/v1/menus/${menuSlug}/items`, {
    method: 'POST', headers: auth, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`addItem(${menuSlug}, ${JSON.stringify(body)}): ${r.status} ${await r.text()}`);
  return (await r.json()).data.id;
}

// ── 1. `main` menu (header nav) ──────────────────────────────────────

await wipeMenu('main');
const mainItems = [
  ['Showcase',  '/showcase',                            '_self'],
  ['Blog',      '/blog',                                '_self'],
  ['Compare',   '/compare',                             '_self'],
  ['Roadmap',   '/roadmap',                             '_self'],
  ['Publish',   '/publish',                             '_self'],
  ['Pricing',   '/pricing',                             '_self'],
  ['Docs',      'https://docs.perryts.com',             '_blank'],
  ['GitHub',    'https://github.com/PerryTS/perry',     '_blank'],
];
for (let i = 0; i < mainItems.length; i++) {
  const [label, url, target] = mainItems[i];
  await addItem('main', { label: { en: label }, url, target, sortOrder: i + 1 });
}
console.log(`main: added ${mainItems.length} items`);

// ── 2. `footer` menu (3 sections × N links) ──────────────────────────

await wipeMenu('footer');
const footer = [
  {
    label: 'Resources',
    children: [
      ['Blog',          '/blog',                                  '_self'],
      ['Showcase',      '/showcase',                              '_self'],
      ['Compare',       '/compare',                               '_self'],
      ['Documentation', 'https://docs.perryts.com',               '_blank'],
      ['Internals',     '/internals',                             '_self'],
      ['geisterhand.io','https://geisterhand.io',                 '_blank'],
    ],
  },
  {
    label: 'Community',
    children: [
      ['GitHub',       'https://github.com/PerryTS/perry',                            '_blank'],
      ['Issues',       'https://github.com/PerryTS/perry/issues',                     '_blank'],
      ['Discussions',  'https://github.com/PerryTS/perry/discussions',                '_blank'],
      ['Contributing', 'https://github.com/PerryTS/perry/blob/main/CONTRIBUTING.md',  '_blank'],
      ['Newsletter',   '/newsletter',                                                 '_self'],
    ],
  },
  {
    label: 'Enterprise',
    children: [
      ['Pricing',    '/pricing',    '_self'],
      ['Enterprise', '/enterprise', '_self'],
      ['Privacy',    '/privacy',    '_self'],
      ['Imprint',    '/imprint',    '_self'],
    ],
  },
];
for (let i = 0; i < footer.length; i++) {
  const section = footer[i];
  // Section parent: url is null so the renderer treats it as a heading.
  const parentId = await addItem('footer', {
    label: { en: section.label }, url: null, target: '_self', sortOrder: i + 1,
  });
  for (let j = 0; j < section.children.length; j++) {
    const [label, url, target] = section.children[j];
    await addItem('footer', {
      label: { en: label }, url, target, parentId, sortOrder: j + 1,
    });
  }
  console.log(`  footer/${section.label}: ${section.children.length} children`);
}
console.log(`footer: ${footer.length} sections, ${footer.reduce((n,s)=>n+s.children.length,0)} leaf items`);

console.log('\nDone.');
