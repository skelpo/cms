// Migrate perry.land's src/messages/<locale>.json into Skelpo CMS as
// per-locale UI-string blobs in `settings`. Key: `i18n.<locale>`.
// Idempotent — overwrites the same key on re-run.
//
//   node scripts/import-perry-messages.mjs --cms http://127.0.0.1:3137 \
//     --landing ~/projects/perry/landing

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

async function login() {
  const r = await fetch(`${CMS}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  const { data } = await r.json();
  return data.token;
}

async function putSetting(token, key, value) {
  const r = await fetch(`${CMS}/api/v1/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `skelpoSession=${token}` },
    body: JSON.stringify({ value }),
  });
  if (!r.ok) throw new Error(`PUT ${key}: ${r.status} ${await r.text()}`);
}

const token = await login();
console.log('Authenticated.');

const dir = join(LANDING, 'src/messages');
const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
const locales = [];
for (const f of files) {
  const locale = f.replace(/\.json$/, '');
  const value = JSON.parse(await readFile(join(dir, f), 'utf8'));
  await putSetting(token, `i18n.${locale}`, value);
  locales.push(locale);
  console.log(`  + i18n.${locale}  (${Object.keys(value).length} groups)`);
}

// Track the configured locale set in site.locales too.
await putSetting(token, 'site.locales', locales);
console.log(`\nDone. ${locales.length} locales imported: ${locales.join(', ')}`);
