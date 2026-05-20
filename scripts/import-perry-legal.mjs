// Migrate perry.land's Impressum + Datenschutzerklärung pages into Skelpo
// CMS as `page` content rows with TipTap-style richtext bodies. Both
// pages are stored in German (legal requirement under German law for
// Skelpo GmbH). The same content shows on every locale.
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

// ── TipTap-doc helpers ──────────────────────────────────────────────

const t = (text) => ({ type: 'text', text });
const link = (text, href) => ({
  type: 'text', text,
  marks: [{ type: 'link', attrs: { href, target: href.startsWith('mailto:') ? null : '_blank', rel: 'noopener noreferrer' } }],
});
const bold = (text) => ({ type: 'text', text, marks: [{ type: 'bold' }] });
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const p = (...nodes) => ({ type: 'paragraph', content: nodes });
const br = { type: 'hardBreak' };
const ul = (...itemContents) => ({
  type: 'bulletList',
  content: itemContents.map((c) => ({
    type: 'listItem',
    content: [Array.isArray(c) ? p(...c) : p(t(c))],
  })),
});

// ── Impressum body ──────────────────────────────────────────────────

const imprintDoc = {
  type: 'doc',
  content: [
    p(t('Rechtliche Informationen')),

    h(2, 'Angaben gemäß § 5 TMG'),
    p(
      bold('Skelpo GmbH'), br,
      t('Köttingstraße 41'), br,
      t('58339 Breckerfeld'), br,
      t('Deutschland'), br,
      t('Telefon +49 (0) 2338 8733446'), br,
      t('E-Mail: '), link('info@skelpo.com', 'mailto:info@skelpo.com'), br,
      t('Handelsregister: Amtsgericht Hagen HRB 8266'),
    ),

    h(2, 'Kontaktinformationen'),
    p(
      t('E-Mail: '), link('info@skelpo.com', 'mailto:info@skelpo.com'), br,
      t('Website: www.skelpo.com'),
    ),

    h(2, 'Vertreter'),
    p(t('Vertretungsberechtigter Geschäftsführer: Ralph Küpper')),

    h(2, 'Umsatzsteuer-Identifikationsnummer'),
    p(t('Umsatzsteuer-Identifikationsnummer DE266573808')),

    h(2, 'Haftungsausschluss (Disclaimer)'),

    h(3, 'Haftung für Inhalte'),
    p(t('Die Inhalte dieser Website werden mit größter Sorgfalt erstellt. Wir übernehmen jedoch keine Gewähr für die Richtigkeit, Vollständigkeit und Aktualität der bereitgestellten Inhalte. Als Diensteanbieter sind wir gemäß § 7 Abs. 1 TMG für eigene Inhalte auf diesen Seiten nach den allgemeinen Gesetzen verantwortlich. Nach §§ 8 bis 10 TMG sind Diensteanbieter jedoch nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu überwachen oder nach Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen.')),

    h(3, 'Haftung für Links'),
    p(t('Unsere Website enthält Links zu externen Websites. Für deren Inhalte tragen wir keine Haftung, da diese außerhalb unseres Einflussbereiches liegen. Der Anbieter der Website, auf die verlinkt wird, ist allein verantwortlich für seinen Inhalt.')),

    h(3, 'Urheberrecht'),
    p(t('Die auf diesen Seiten veröffentlichten Inhalte und Werke unterliegen dem deutschen Urheberrecht. Vervielfältigungen, Bearbeitungen, Verbreitungen und jede Art der Verwertung außerhalb der Grenzen des Urheberrechtes bedürfen der schriftlichen Zustimmung des Autors oder Erstellers.')),
  ],
};

// ── Datenschutz body ────────────────────────────────────────────────

const privacyDoc = {
  type: 'doc',
  content: [
    p(t('Letzte Aktualisierung: November 2025')),

    h(2, '1. Einleitung'),
    p(t('Skelpo GmbH ("wir", "uns" oder "unser") respektiert deine Privatsphäre und verpflichtet sich, deine personenbezogenen Daten zu schützen. Diese Datenschutzerklärung erklärt, wie wir deine Daten sammeln, verwenden und schützen.')),

    h(2, '2. Daten, die wir sammeln'),
    p(t('Wir können folgende Arten von personenbezogenen Daten sammeln:')),
    ul(
      'Kontaktinformationen (Name, E-Mail-Adresse, Telefonnummer)',
      'Projektinformationen, die du uns zur Verfügung stellst',
      'Technische Daten (IP-Adresse, Browser-Typ, Geräteinformationen)',
      'Nutzungsdaten (wie du unsere Website verwendest)',
    ),

    h(2, '3. Wie wir deine Daten verwenden'),
    p(t('Wir verwenden deine Daten für folgende Zwecke:')),
    ul(
      'Bereitstellung unserer Dienstleistungen',
      'Kommunikation mit dir über Projekte und Anfragen',
      'Verbesserung unserer Website und Dienstleistungen',
      'Einhaltung rechtlicher Verpflichtungen',
    ),

    h(2, '4. Cookies'),
    p(t('Unsere Website verwendet Cookies, um die Benutzererfahrung zu verbessern. Du kannst Cookies in deinen Browsereinstellungen deaktivieren, dies kann jedoch die Funktionalität der Website beeinträchtigen.')),

    h(2, '5. Deine Rechte'),
    p(t('Unter der DSGVO hast du folgende Rechte:')),
    ul(
      'Recht auf Auskunft über deine gespeicherten Daten',
      'Recht auf Berichtigung unrichtiger Daten',
      'Recht auf Löschung Ihrer Daten',
      'Recht auf Einschränkung der Verarbeitung',
      'Recht auf Datenübertragbarkeit',
      'Widerspruchsrecht gegen die Verarbeitung',
    ),

    h(2, '6. Datensicherheit'),
    p(t('Wir setzen angemessene technische und organisatorische Maßnahmen ein, um deine personenbezogenen Daten vor unbefugtem Zugriff, Verlust oder Zerstörung zu schützen.')),

    h(2, '7. Kontakt'),
    p(
      t('Wenn du Fragen zu dieser Datenschutzerklärung hast oder deine Rechte ausüben möchtest, kontaktiere uns bitte unter:'), br,
      t('Email: '), link('info@skelpo.com', 'mailto:info@skelpo.com'),
    ),
  ],
};

// ── Upsert helper ───────────────────────────────────────────────────

async function upsertPage(slug, title, doc, metaDescription) {
  // /api/v1/content/by-slug returns 401 for unpublished rows when unauth;
  // use authed list with status=draft,published to find any matching row.
  const list = await (await fetch(
    `${CMS}/api/v1/content?type=page&limit=100&locale=en&status=draft,published`,
    { headers: auth },
  )).json();
  const row = (list.data ?? []).find((r) => r.slug === slug);
  const body = {
    title,
    fields: { body: doc },
    seo: { metaDescription },
  };

  if (row) {
    const r = await fetch(`${CMS}/api/v1/content/${row.id}`, {
      method: 'PATCH', headers: auth, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`PATCH ${slug}: ${r.status} ${await r.text()}`);
    var id = row.id;
    console.log(`Updated page/${slug} (#${id})`);
  } else {
    const r = await fetch(`${CMS}/api/v1/content`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ type: 'page', slug, locale: 'en', status: 'draft', ...body }),
    });
    if (!r.ok) throw new Error(`POST ${slug}: ${r.status} ${await r.text()}`);
    var id = (await r.json()).data.id;
    console.log(`Created page/${slug} (#${id})`);
  }

  // Publish (idempotent: publishing an already-published row is fine).
  const pub = await fetch(`${CMS}/api/v1/content/${id}/publish`, { method: 'POST', headers: auth });
  if (!pub.ok) {
    const txt = await pub.text();
    if (!txt.includes('already')) throw new Error(`publish ${slug}: ${pub.status} ${txt}`);
  }
  console.log(`  → published page/${slug}`);
}

await upsertPage(
  'imprint',
  'Impressum',
  imprintDoc,
  'Rechtliche Informationen — Skelpo GmbH, Köttingstraße 41, 58339 Breckerfeld, HRB Hagen 8266.',
);
await upsertPage(
  'privacy',
  'Datenschutzerklärung',
  privacyDoc,
  'Datenschutzerklärung von Skelpo GmbH — welche personenbezogenen Daten wir verarbeiten und welche Rechte dir nach der DSGVO zustehen.',
);

console.log('\nDone.');
