// Per-request locale resolution for the admin. Runs after attachAuthContext
// (so auth.user.locale is available) and before the admin route handlers.
//
// Resolution order:
//   1. The signed-in user's saved locale (users.locale) — the per-user
//      setting the profile page writes.
//   2. The `skelpoAdminLang` cookie — lets the login page (no user yet) and
//      the quick switcher pick a language.
//   3. Accept-Language negotiation against the supported set.
//   4. English.

import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { coerceLocale, negotiateLocale, type AdminLocale } from './locales.js';
import { makeT, type Translator } from './index.js';

export const ADMIN_LANG_COOKIE = 'skelpoAdminLang';

declare module 'hono' {
  interface ContextVariableMap {
    t?: Translator;
    adminLocale?: AdminLocale;
  }
}

export async function attachAdminI18n(c: Context, next: Next): Promise<void | Response> {
  const auth = c.get('auth');
  const fromUser = auth ? coerceLocale(auth.user.locale) : null;
  const fromCookie = coerceLocale(getCookie(c, ADMIN_LANG_COOKIE));
  // Deployment-wide default (e.g. ADMIN_DEFAULT_LOCALE=de): beats browser
  // negotiation, loses to an explicit per-user choice or cookie.
  const fromEnv = coerceLocale(process.env.ADMIN_DEFAULT_LOCALE);
  const locale: AdminLocale =
    fromUser ?? fromCookie ?? fromEnv ?? negotiateLocale(c.req.header('accept-language'));

  c.set('adminLocale', locale);
  c.set('t', makeT(locale));
  return next();
}
