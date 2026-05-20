// Minimal HTTP client for the CLI. Talks to the CMS via its public API
// (so anything the API supports, the CLI does too — kept in sync by
// construction). Auth from the loaded session: cookie (session login)
// or Bearer (API token).

import { loadSession } from './session.js';

export interface ApiOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;             // JSON-encoded automatically
  formBody?: FormData;        // multipart upload (skips JSON header)
  query?: Record<string, string | number | undefined | null>;
  raw?: boolean;              // return Response unparsed (for /raw, etc.)
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, msg: string) {
    super(msg);
  }
}

export async function api(path: string, opts: ApiOpts = {}): Promise<unknown> {
  const s = await loadSession();
  if (!s) throw new Error('Not logged in. Run: skelpo-cms login');
  const url = new URL(path.startsWith('/') ? path : `/${path}`, s.server);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {};
  if (s.kind === 'session')  headers.Cookie = `skelpoSession=${s.token}`;
  if (s.kind === 'apiToken') headers.Authorization = `Bearer ${s.token}`;
  let body: BodyInit | undefined;
  if (opts.formBody) {
    body = opts.formBody;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const r = await fetch(url, { method: opts.method ?? 'GET', headers, body });
  if (opts.raw) return r;
  const text = await r.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!r.ok) {
    const msg = (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'object'
      ? ((parsed as { error: { message?: string } }).error.message ?? `HTTP ${r.status}`)
      : `HTTP ${r.status}`);
    throw new ApiError(r.status, parsed, msg);
  }
  return parsed;
}

/** Probe the server's auth state. Useful for `whoami`. */
export async function whoami(): Promise<{ id: number; email: string; displayName: string; role: string } | null> {
  try {
    const r = await api('/api/v1/auth/me') as { data: { user: { id: number; email: string; displayName: string }; role: { slug: string } } };
    return { id: r.data.user.id, email: r.data.user.email, displayName: r.data.user.displayName, role: r.data.role.slug };
  } catch { return null; }
}
