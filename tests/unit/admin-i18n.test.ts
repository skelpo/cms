import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeT } from '../../src/admin/i18n/index.js';
import {
  adminLocales,
  isAdminLocale,
  coerceLocale,
  negotiateLocale,
} from '../../src/admin/i18n/locales.js';
import { bags } from '../../src/admin/i18n/messages/index.js';

test('makeT resolves keys in the bound locale', () => {
  assert.equal(makeT('en')('nav.dashboard'), 'Dashboard');
  assert.equal(makeT('de')('nav.dashboard'), 'Dashboard'); // de happens to match
  assert.equal(makeT('de')('common.save'), 'Speichern');
});

test('makeT falls back to English for missing keys, then to the key', () => {
  const t = makeT('de');
  // Unknown key → returns the key itself (never blank).
  assert.equal(t('nope.not.here'), 'nope.not.here');
});

test('t() interpolates {placeholders}', () => {
  const t = makeT('en');
  assert.equal(t('dashboard.signedInAs', { name: 'Ada' }), 'Signed in as Ada');
});

test('t.plural selects singular vs plural by count and injects {n}', () => {
  const t = makeT('en');
  assert.equal(t.plural('common.rows', 1), '1 row');
  assert.equal(t.plural('common.rows', 5), '5 rows');
});

test('t() on a plural node without count returns the "other" form', () => {
  const t = makeT('en');
  assert.equal(t('common.rows', { n: 3 }), '3 rows');
});

test('every locale carries the same key structure as English', () => {
  const isPlural = (v: unknown): boolean =>
    !!v && typeof v === 'object' &&
    typeof (v as { one?: unknown }).one === 'string' &&
    typeof (v as { other?: unknown }).other === 'string';
  const leaves = (o: unknown, p = ''): string[] => {
    if (typeof o === 'string' || isPlural(o)) return [p];
    if (o && typeof o === 'object') {
      return Object.entries(o).flatMap(([k, v]) => leaves(v, p ? `${p}.${k}` : k));
    }
    return [p];
  };
  const enKeys = new Set(leaves(bags.en));
  for (const loc of adminLocales) {
    const k = new Set(leaves(bags[loc]));
    assert.deepEqual([...enKeys].filter((x) => !k.has(x)), [], `${loc} is missing keys`);
    assert.deepEqual([...k].filter((x) => !enKeys.has(x)), [], `${loc} has extra keys`);
  }
});

test('isAdminLocale recognises the supported set only', () => {
  assert.equal(isAdminLocale('en'), true);
  assert.equal(isAdminLocale('zh-Hans'), true);
  assert.equal(isAdminLocale('xx'), false);
  assert.equal(isAdminLocale(undefined), false);
});

test('coerceLocale handles exact, base-language and zh mappings', () => {
  assert.equal(coerceLocale('de'), 'de');
  assert.equal(coerceLocale('de-AT'), 'de');
  assert.equal(coerceLocale('zh'), 'zh-Hans');
  assert.equal(coerceLocale('zh-CN'), 'zh-Hans');
  assert.equal(coerceLocale('pt_BR'), 'pt');
  assert.equal(coerceLocale('xx'), null);
  assert.equal(coerceLocale(null), null);
});

test('negotiateLocale picks the best supported Accept-Language match', () => {
  assert.equal(negotiateLocale('de-DE,de;q=0.9,en;q=0.8'), 'de');
  assert.equal(negotiateLocale('fr-CA,fr;q=0.9'), 'fr');
  assert.equal(negotiateLocale('xx,en;q=0.5'), 'en');
  assert.equal(negotiateLocale(''), 'en');
  assert.equal(negotiateLocale(undefined), 'en');
});

test('there are exactly 13 admin locales', () => {
  assert.equal(adminLocales.length, 13);
  assert.equal(Object.keys(bags).length, 13);
});
