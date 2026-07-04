// URL sanitization for rendered content. Content bodies are authored by CMS
// users who are not necessarily fully trusted (editors/authors/contributors),
// so any href/src that reaches the public HTML must be scheme-checked to
// prevent `javascript:` / `data:` / `vbscript:` XSS.
//
// Whitespace and control characters are stripped first because browsers ignore
// them while parsing a URL scheme (e.g. `java\tscript:` executes as
// `javascript:`), so they must not be allowed to defeat the scheme allowlist.

const CONTROL = /[\s\p{Cc}]+/gu; // all whitespace + control chars (U+0000–U+001F, U+007F–U+009F)
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.\-]*:/i;

/**
 * Sanitize an anchor href. Allows http(s), mailto, tel, and schemeless URLs
 * (relative / root-relative / protocol-relative / fragment / query). Every
 * other explicit scheme (javascript:, data:, vbscript:, file:, …) collapses
 * to `#`.
 */
export function safeHref(raw: string): string {
  const s = String(raw).replace(CONTROL, '');
  if (s === '') return '#';
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (EXPLICIT_SCHEME.test(s)) return '#'; // explicit, non-allowlisted scheme
  return s; // no scheme → relative, safe
}

/**
 * Sanitize an `<img>` src. Allows http(s), relative, and inert raster data:
 * images; blocks every other scheme — including `data:image/svg+xml`, which can
 * carry script when navigated to directly.
 */
export function safeSrc(raw: string): string {
  const s = String(raw).replace(CONTROL, '');
  if (/^data:image\/(png|jpe?g|gif|webp|avif);/i.test(s)) return s;
  if (/^https?:/i.test(s)) return s;
  if (EXPLICIT_SCHEME.test(s)) return ''; // explicit, non-allowlisted scheme
  return s; // no scheme → relative, safe
}
