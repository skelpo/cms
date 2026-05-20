// Migrate perry.land's /pricing into Skelpo CMS as a structured `pricing`
// content type (single row, with tiers/compareRows/faqs repeaters).
//
// UI chrome ("Compare plans", "Questions", "Or self-host everything", …)
// stays in the i18n bundle; this script only stores the editorial
// structured data so a non-technical user can edit tier features, FAQ
// items, or comparison rows from the admin UI without redeploys.
//
// Idempotent.

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

// ── 1. Resolve helper: pluck a string from the en i18n bundle ────────

const enBundle = (await (await fetch(`${CMS}/api/v1/settings/i18n.en`)).json()).data['i18n.en'];
function en(path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), enBundle) ?? '';
}

// ── 2. Schema ────────────────────────────────────────────────────────

const fieldsSchema = {
  version: 1,
  fields: [
    { name: 'subtitle',              type: 'textarea', label: 'Page subtitle',          translatable: true },
    { name: 'enterpriseBannerText',  type: 'text',     label: 'Enterprise banner text', translatable: true },
    { name: 'enterpriseBannerLink',  type: 'text',     label: 'Enterprise banner link', translatable: true },
    { name: 'enterpriseBannerUrl',   type: 'url',      label: 'Enterprise banner URL' },
    { name: 'footnote',              type: 'textarea', label: 'Footnote under table',   translatable: true },
    { name: 'tiers',                 type: 'repeater', label: 'Pricing tiers',
      repeater: { fields: [
        { name: 'name',       type: 'text',     translatable: true, required: true,  label: 'Name' },
        { name: 'tagline',    type: 'text',     translatable: true,                  label: 'Tagline' },
        { name: 'priceLabel', type: 'text',                                          label: 'Price label (e.g. "$0", "$19", "Custom")' },
        { name: 'period',     type: 'text',     translatable: true,                  label: 'Period (e.g. "/month")' },
        { name: 'popular',    type: 'boolean',                                       label: 'Highlight as most popular' },
        { name: 'features',   type: 'textarea', translatable: true,                  label: 'Features (one per line)' },
        { name: 'ctaLabel',   type: 'text',     translatable: true,                  label: 'CTA button label' },
        { name: 'ctaUrl',     type: 'url',                                           label: 'CTA URL' },
        { name: 'sortOrder',  type: 'number',                                        label: 'Sort order' },
      ] },
    },
    { name: 'compareRows',           type: 'repeater', label: 'Comparison table rows',
      repeater: { fields: [
        { name: 'label',     type: 'text', translatable: true, required: true, label: 'Row label' },
        { name: 'free',      type: 'text', translatable: true, required: true, label: 'Free value' },
        { name: 'pro',       type: 'text', translatable: true, required: true, label: 'Pro value' },
        { name: 'sortOrder', type: 'number',                                   label: 'Sort order' },
      ] },
    },
    { name: 'selfHostTitle',    type: 'text',     translatable: true, label: 'Self-host: title' },
    { name: 'selfHostDesc',     type: 'textarea', translatable: true, label: 'Self-host: description' },
    { name: 'selfHostLinkLabel',type: 'text',     translatable: true, label: 'Self-host: link label' },
    { name: 'selfHostLinkUrl',  type: 'url',                          label: 'Self-host: link URL' },
    { name: 'faqs',             type: 'repeater', label: 'FAQs',
      repeater: { fields: [
        { name: 'question',  type: 'text',     translatable: true, required: true, label: 'Question' },
        { name: 'answer',    type: 'textarea', translatable: true, required: true, label: 'Answer' },
        { name: 'sortOrder', type: 'number',                                       label: 'Sort order' },
      ] },
    },
  ],
};

// ── 3. Create or evolve the `pricing` content type ───────────────────

const types = await (await fetch(`${CMS}/api/v1/types`)).json();
const hasPricing = (types.data ?? []).some((t) => t.slug === 'pricing');
if (!hasPricing) {
  const r = await fetch(`${CMS}/api/v1/types`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      slug: 'pricing', labelSingular: 'Pricing', labelPlural: 'Pricing pages',
      isRoutable: true, urlPattern: '/pricing', icon: 'tag',
      fieldsSchema,
    }),
  });
  if (!r.ok) throw new Error(`create type: ${r.status} ${await r.text()}`);
  console.log('Created content type: pricing');
} else {
  const r = await fetch(`${CMS}/api/v1/types/pricing`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ fieldsSchema }),
  });
  if (r.ok) {
    const { data } = await r.json();
    if (data?.newRevision) console.log(`pricing type evolved to revision ${data.newRevision}`);
  }
}

// ── 4. Build the row body from original hardcoded structure + i18n ──

const subtitle = en('pricing.subtitle');
const footnote = en('pricing.failedBuildsNote');

const tiers = [
  {
    name: en('pricing.free'),
    tagline: en('pricing.noAccountRequired'),
    priceLabel: '$0',
    period: en('pricing.perMonth'),
    popular: false,
    features: [
      'pricing.feature_publishes15',
      'pricing.feature_deepVerify2',
      'pricing.feature_lightVerify',
      'pricing.feature_allPlatforms',
      'pricing.feature_codeSigning',
      'pricing.feature_storeSubmission',
      'pricing.feature_unlimitedProjects',
    ].map(en).join('\n'),
    ctaLabel: en('common.getStarted') || 'Get started',
    ctaUrl: 'https://docs.perryts.com/getting-started',
    sortOrder: 1,
  },
  {
    name: en('pricing.pro'),
    tagline: en('pricing.forDevs'),
    priceLabel: '$19',
    period: en('pricing.perMonth'),
    popular: true,
    features: [
      'pricing.feature_publishes50',
      'pricing.feature_deepVerify20',
      'pricing.feature_lightVerify',
      'pricing.feature_allPlatforms',
      'pricing.feature_codeSigning',
      'pricing.feature_storeSubmission',
      'pricing.feature_unlimitedProjectsPro',
      'pricing.feature_priorityQueue',
      'pricing.feature_overage',
    ].map(en).join('\n'),
    ctaLabel: en('pricing.subscribeToPro'),
    ctaUrl: 'https://app.perryts.com/dashboard/billing?plan=pro',
    sortOrder: 2,
  },
];

const compareRows = [
  { label: en('pricing.row_monthlyPublishes'),  free: '15',                          pro: '50',                                sortOrder: 1 },
  { label: en('pricing.row_deepVerifyRuns'),    free: '2',                           pro: '20',                                sortOrder: 2 },
  { label: en('pricing.row_lightVerify'),       free: en('pricing.row_everyPublish'),pro: en('pricing.row_everyPublish'),      sortOrder: 3 },
  { label: en('pricing.row_overagePublish'),    free: '$0.99',                       pro: '$0.49',                             sortOrder: 4 },
  { label: en('pricing.row_overageVerify'),     free: '$2.99',                       pro: '$1.49',                             sortOrder: 5 },
  { label: en('pricing.row_buildQueue'),        free: en('pricing.row_standard'),    pro: en('pricing.row_priority'),          sortOrder: 6 },
  { label: en('pricing.row_projects'),          free: en('pricing.row_unlimitedStar'),pro: en('pricing.row_unlimited'),        sortOrder: 7 },
  { label: en('pricing.row_accountRequired'),   free: en('pricing.row_accountFreeDesc'), pro: en('pricing.row_accountProDesc'),sortOrder: 8 },
  { label: en('pricing.row_failedBuilds'),      free: en('pricing.row_noStar'),      pro: en('pricing.row_noStar'),            sortOrder: 9 },
];

const faqs = [
  { question: en('pricing.faq.q1'), answer: en('pricing.faq.a1'), sortOrder: 1 },
  { question: en('pricing.faq.q2'), answer: en('pricing.faq.a2'), sortOrder: 2 },
  { question: en('pricing.faq.q3'), answer: en('pricing.faq.a3'), sortOrder: 3 },
  { question: en('pricing.faq.q4'), answer: en('pricing.faq.a4'), sortOrder: 4 },
];

const fields = {
  subtitle,
  enterpriseBannerText: en('pricing.enterpriseBanner.text'),
  enterpriseBannerLink: en('pricing.enterpriseBanner.link'),
  enterpriseBannerUrl:  '/enterprise',
  footnote,
  tiers,
  compareRows,
  selfHostTitle:     en('pricing.selfHost.title'),
  selfHostDesc:      en('pricing.selfHost.description'),
  selfHostLinkLabel: en('pricing.selfHost.selfHostingGuide') || 'Self-hosting guide',
  selfHostLinkUrl:   'https://docs.perryts.com/self-hosting',
  faqs,
};

// ── 5. Upsert the singleton `pricing/pricing` row ────────────────────

const existing = await fetch(`${CMS}/api/v1/content/by-slug/pricing/pricing?locale=en`);
if (existing.ok) {
  const row = (await existing.json()).data;
  const upd = await fetch(`${CMS}/api/v1/content/${row.id}`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ fields }),
  });
  if (!upd.ok) throw new Error(`PATCH row: ${upd.status} ${await upd.text()}`);
  console.log(`Updated pricing row #${row.id}: ${tiers.length} tiers, ${compareRows.length} compare rows, ${faqs.length} FAQs.`);
} else {
  const cr = await fetch(`${CMS}/api/v1/content`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      type: 'pricing', slug: 'pricing', locale: 'en', title: 'Pricing',
      status: 'draft', fields,
      seo: { metaDescription: subtitle.slice(0, 160) },
    }),
  });
  if (!cr.ok) throw new Error(`POST row: ${cr.status} ${await cr.text()}`);
  const { data } = await cr.json();
  await fetch(`${CMS}/api/v1/content/${data.id}/publish`, { method: 'POST', headers: auth });
  console.log(`Created + published pricing row #${data.id}: ${tiers.length} tiers, ${compareRows.length} compare rows, ${faqs.length} FAQs.`);
}

console.log('\nDone.');
