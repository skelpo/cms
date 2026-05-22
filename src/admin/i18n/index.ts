// UI-string translator for the admin. Messages are bundled per-locale TS
// modules (see ./messages). t() drills a dot-path through the active
// locale's bag and falls back to English for any missing key, so a
// partially-translated locale never shows a blank — worst case it shows
// English. Synchronous: bags are static imports, no DB round-trip (keeps
// the Perry-native AOT path and the login page fast).

import type { Context } from 'hono';
import { type AdminLocale, defaultAdminLocale } from './locales.js';
import { bags } from './messages/index.js';

/** A plural message carries a singular + general form, chosen by count. */
export interface PluralValue {
  one: string;
  other: string;
}

export type MessageNode = string | PluralValue | MessageBag;
export interface MessageBag {
  [key: string]: MessageNode;
}

export type Vars = Record<string, string | number>;

export interface Translator {
  /** Translate a dot-path key, interpolating `{name}` placeholders. */
  (key: string, vars?: Vars): string;
  /** Translate a plural key (expects `{ one, other }`); `{n}` is injected. */
  plural: (key: string, count: number, vars?: Vars) => string;
  /** The active locale this translator is bound to. */
  locale: AdminLocale;
}

function isPlural(v: MessageNode): v is PluralValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as PluralValue).one === 'string' &&
    typeof (v as PluralValue).other === 'string'
  );
}

/** Walk a dot-path through a bag, returning the node at the path or null. */
function drill(bag: MessageBag, key: string): MessageNode | null {
  const parts = key.split('.');
  let cur: MessageNode = bag;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && !isPlural(cur) && p in cur) {
      cur = (cur as MessageBag)[p]!;
    } else {
      return null;
    }
  }
  return cur ?? null;
}

function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  );
}

/** Build a translator bound to a locale, with English as the fallback. */
export function makeT(locale: AdminLocale): Translator {
  const local = bags[locale] ?? bags[defaultAdminLocale];
  const fallback = bags[defaultAdminLocale];

  const resolve = (key: string): MessageNode | null =>
    drill(local, key) ?? drill(fallback, key);

  const t = ((key: string, vars?: Vars): string => {
    const v = resolve(key);
    if (typeof v === 'string') return interpolate(v, vars);
    // A plural node used without count: prefer `other`. Anything else
    // (object/null) means a missing key — surface the key itself.
    if (v && isPlural(v)) return interpolate(v.other, vars);
    return key;
  }) as Translator;

  t.plural = (key: string, count: number, vars?: Vars): string => {
    const v = resolve(key);
    const merged: Vars = { n: count, ...vars };
    if (v && isPlural(v)) {
      // English-style selection (n === 1 → singular). Good enough for the
      // 13 admin locales; languages without a plural set both forms equal.
      return interpolate(count === 1 ? v.one : v.other, merged);
    }
    if (typeof v === 'string') return interpolate(v, merged);
    return key;
  };

  t.locale = locale;
  return t;
}

/** Get the request's translator (set by attachAdminI18n), or an English
 *  fallback for contexts where the middleware didn't run. */
export function getT(c: Context): Translator {
  return c.get('t') ?? makeT(defaultAdminLocale);
}
