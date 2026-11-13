// Small helpers shared by every admin screen module: the auth gate, flash
// messages, date rendering and a couple of formatting utilities.

import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import type { AuthContext } from '../auth/middleware.js';
import { can, type Action } from '../permissions/check.js';
import { dateToIso } from '../db/datetime.js';
import { config } from '../config.js';

export function gate(c: Context): AuthContext | Response {
  const auth = c.get('auth');
  if (!auth) return c.redirect('/admin/login', 302);
  return auth;
}

// Perry workaround: `instanceof Response` is always false for native fetch
// handles, so discriminate gate()'s union by a field only AuthContext carries.
export function notAuth(x: AuthContext | Response): x is Response {
  return (x as AuthContext).user === undefined;
}

export function allowed(auth: AuthContext, action: Action, typeSlug?: string, ownerId?: number | null): boolean {
  return can({ userId: auth.user.id, caps: auth.role.capabilities }, action, typeSlug, ownerId ?? undefined);
}

/** Props every authed <AdminPage> needs. */
export function pageUser(auth: AuthContext): {
  user: { displayName: string; roleSlug?: string };
  caps: AuthContext['role']['capabilities'];
} {
  return { user: { ...auth.user, roleSlug: auth.role.slug }, caps: auth.role.capabilities };
}

/** `?ok=` / `?err=` flash read from the query string. */
export function readFlash(c: Context): { ok?: string; err?: string } {
  const ok = c.req.query('ok');
  const err = c.req.query('err');
  return { ...(ok ? { ok } : {}), ...(err ? { err } : {}) };
}

export const Flash: FC<{ flash?: { ok?: string; err?: string } }> = ({ flash }) => (
  <>
    {flash?.ok ? <div class="ok" role="status">{flash.ok}</div> : null}
    {flash?.err ? <div class="err" role="alert">{flash.err}</div> : null}
  </>
);

export function withFlash(path: string, kind: 'ok' | 'err', message: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(message)}`;
}

/** A timestamp rendered in UTC and re-written to the viewer's local time by
 *  the layout script (`time[data-dt]`). `dateOnly` drops the clock. */
export const DateTime: FC<{ value: unknown; dateOnly?: boolean }> = ({ value, dateOnly }) => {
  const iso = dateToIso(value);
  if (!iso) return <span class="muted">—</span>;
  const text = dateOnly ? iso.slice(0, 10) : `${iso.slice(0, 16).replace('T', ' ')} UTC`;
  return <time datetime={iso} data-dt={dateOnly ? 'date' : 'datetime'}>{text}</time>;
};

/** Absolute base URL of the admin (no trailing slash), for links in emails. */
export function adminBaseUrl(c: Context): string {
  const configured = config.siteUrl.replace(/\/+$/, '');
  if (configured && !/localhost:3000$/.test(configured)) return configured;
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() ?? new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
  return `${proto}://${host}`;
}

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** ISO / datetime-local string → MySQL `YYYY-MM-DD HH:MM:SS` (UTC), or null. */
export function toDbDatetime(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Turn any text into a URL-safe slug (same rules the writer validates). */
export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 75)
    .replace(/-+$/g, '');
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Page links for an offset-paginated list. Keeps the other query params. */
export const Pager: FC<{ page: number; pages: number; href: (page: number) => string; label: string }> = ({ page, pages, href, label }) => {
  if (pages <= 1) return null;
  return (
    <div class="pager">
      {page > 1 ? <a class="btn sm sec" href={href(page - 1)}>‹</a> : <span class="btn sm sec dis">‹</span>}
      <span class="muted">{label}</span>
      {page < pages ? <a class="btn sm sec" href={href(page + 1)}>›</a> : <span class="btn sm sec dis">›</span>}
    </div>
  );
};
