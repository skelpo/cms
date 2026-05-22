// Admin UI locales. Mirrors the 13 languages shipped by the perry/landing
// marketing site (src/i18n/routing.ts there) so the CMS admin and the
// customer site speak the same set. This is product chrome, not customer
// content — the list is fixed and bundled into the binary.

export const adminLocales = [
  'en',
  'de',
  'es',
  'fr',
  'it',
  'ja',
  'ko',
  'pt',
  'th',
  'tr',
  'vi',
  'id',
  'zh-Hans',
] as const;

export type AdminLocale = (typeof adminLocales)[number];

export const defaultAdminLocale: AdminLocale = 'en';

// Endonyms (each language's name in its own script) — what we show in the
// language picker, matching perry/landing's localeNames.
export const adminLocaleNames: Record<AdminLocale, string> = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  pt: 'Português',
  th: 'ไทย',
  tr: 'Türkçe',
  vi: 'Tiếng Việt',
  id: 'Indonesia',
  'zh-Hans': '中文',
};

const localeSet = new Set<string>(adminLocales);

export function isAdminLocale(v: unknown): v is AdminLocale {
  return typeof v === 'string' && localeSet.has(v);
}

/** Coerce an arbitrary locale-ish string to a supported locale or null.
 *  Handles exact matches, base-language matches (`de-AT` → `de`) and the
 *  Chinese script tag (`zh`, `zh-CN` → `zh-Hans`). */
export function coerceLocale(v: string | null | undefined): AdminLocale | null {
  if (!v) return null;
  const raw = v.trim();
  if (isAdminLocale(raw)) return raw;
  const lower = raw.toLowerCase();
  if (lower === 'zh' || lower.startsWith('zh-') || lower.startsWith('zh_')) {
    return 'zh-Hans';
  }
  const base = lower.split(/[-_]/)[0]!;
  if (isAdminLocale(base)) return base;
  return null;
}

/** Pick the best supported locale from an Accept-Language header. Falls
 *  back to the default when nothing matches. */
export function negotiateLocale(acceptLanguage: string | null | undefined): AdminLocale {
  if (!acceptLanguage) return defaultAdminLocale;
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: (tag ?? '').trim(), weight: Number.isFinite(weight) ? weight : 1 };
    })
    .filter((r) => r.tag.length > 0)
    .sort((a, b) => b.weight - a.weight);
  for (const { tag } of ranked) {
    const hit = coerceLocale(tag);
    if (hit) return hit;
  }
  return defaultAdminLocale;
}
