// Locale → message-bag registry. Static imports so the bags are bundled
// into the binary (works on Node, Bun and Perry-native with no JSON-import
// attribute pitfalls). en is the fallback; see ../index.ts.

import type { MessageBag } from '../index.js';
import type { AdminLocale } from '../locales.js';

import en from './en.js';
import de from './de.js';
import es from './es.js';
import fr from './fr.js';
import it from './it.js';
import ja from './ja.js';
import ko from './ko.js';
import pt from './pt.js';
import th from './th.js';
import tr from './tr.js';
import vi from './vi.js';
import id from './id.js';
import zhHans from './zh-Hans.js';

export const bags: Record<AdminLocale, MessageBag> = {
  en,
  de,
  es,
  fr,
  it,
  ja,
  ko,
  pt,
  th,
  tr,
  vi,
  id,
  'zh-Hans': zhHans,
};
