// CMS client. Thin wrapper around fetch with optional in-memory cache.
//
// Usage:
//   const cms = createClient({ url: process.env.CMS_URL!, cache: 'auto' });
//   const home = await cms.content.bySlug('page', 'home', { locale: 'en' });

import { SdkCache } from './cache.js';
import {
  CmsClientError,
  type ApiError,
  type ContentPublic,
  type MenuTree,
  type Pagination,
} from './types.js';

export interface ClientOptions {
  /** Base URL of the CMS, e.g. https://cms.perry.land. No trailing /api/v1. */
  url: string;
  /** Optional bearer token for authenticated reads. */
  token?: string;
  /** 'auto' enables in-memory caching keyed on URL + locale. */
  cache?: 'auto' | 'off';
  /** Max cached entries (auto only). Default 2000. */
  cacheSize?: number;
  /** HMAC secret for verifying webhook deliveries. */
  webhookSecret?: string;
  /** Fetch implementation override (testing). */
  fetch?: typeof fetch;
}

export interface ListOptions {
  locale?: string;
  limit?: number;
  cursor?: string;
  sort?: string;
  include?: Array<'relations' | 'media' | 'author'>;
}

export interface ContentClientByPathResult {
  type: string | null;
  content: ContentPublic | null;
  redirect: { to: string; status: number } | null;
}

interface SdkResponse<T> {
  data: T;
  pagination?: Pagination;
}

export class CmsClient {
  readonly opts: ClientOptions;
  private readonly base: string;
  private readonly cache: SdkCache | null;
  private readonly fetcher: typeof fetch;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.base = opts.url.replace(/\/+$/, '') + '/api/v1';
    this.cache = (opts.cache ?? 'off') === 'auto' ? new SdkCache(opts.cacheSize ?? 2_000) : null;
    this.fetcher = opts.fetch ?? fetch;
  }

  // ────────── Generic HTTP ──────────

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    init: { body?: unknown; cacheKey?: string; deps?: string[]; signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = this.base + path;
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.opts.token) headers['Authorization'] = `Bearer ${this.opts.token}`;

    // Try cache for GETs. With auto-cache + webhook invalidation, a hit
    // is authoritative — no revalidation round-trip per request.
    if (method === 'GET' && this.cache && init.cacheKey) {
      const hit = this.cache.get<T>(init.cacheKey);
      if (hit) return hit.value;
    }

    const fetchInit: RequestInit = { method, headers };
    if (init.body !== undefined) fetchInit.body = JSON.stringify(init.body);
    if (init.signal) fetchInit.signal = init.signal;
    const resp = await this.fetcher(url, fetchInit);
    if (!resp.ok && resp.status !== 304) throw await this.errorFromResponse(resp);

    const text = await resp.text();
    const json = (text ? JSON.parse(text) : null) as T;
    if (method === 'GET' && this.cache && init.cacheKey && resp.ok) {
      const etag = resp.headers.get('etag') ?? undefined;
      const deps = this.parseDeps(resp);
      this.cache.set(init.cacheKey, json, deps, etag);
    }
    return json;
  }

  private parseDeps(resp: Response): string[] {
    const surrogate = resp.headers.get('surrogate-key');
    if (!surrogate) return [];
    return surrogate.split(/\s+/).filter(Boolean);
  }

  private async errorFromResponse(resp: Response): Promise<CmsClientError> {
    let payload: { error?: ApiError } | null = null;
    try { payload = await resp.json() as { error?: ApiError }; } catch { /* not JSON */ }
    const err = payload?.error;
    return new CmsClientError(
      err?.code ?? 'http_error',
      err?.message ?? resp.statusText,
      resp.status,
      err?.details,
    );
  }

  // ────────── Cache control ──────────

  /** Invalidate dep-keys received via webhook. */
  invalidate(depKeys: string[]): number {
    return this.cache?.invalidate(depKeys) ?? 0;
  }

  cacheStats(): { entries: number; depKeys: number } | null {
    return this.cache?.size() ?? null;
  }

  flushCache(): void {
    this.cache?.clear();
  }

  // ────────── Content ──────────

  readonly content = {
    list: async <F extends Record<string, unknown> = Record<string, unknown>>(
      type: string,
      opts: ListOptions = {},
    ): Promise<SdkResponse<ContentPublic<F>[]>> => {
      const params = new URLSearchParams({ type });
      if (opts.locale) params.set('locale', opts.locale);
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts.cursor) params.set('cursor', opts.cursor);
      if (opts.sort) params.set('sort', opts.sort);
      if (opts.include?.length) params.set('include', opts.include.join(','));
      return this.request<SdkResponse<ContentPublic<F>[]>>(
        'GET',
        `/content?${params.toString()}`,
        { cacheKey: `GET:/content?${params.toString()}` },
      );
    },

    byId: async <F extends Record<string, unknown> = Record<string, unknown>>(
      id: number,
      opts: { include?: ListOptions['include'] } = {},
    ): Promise<{ data: ContentPublic<F> }> => {
      const params = new URLSearchParams();
      if (opts.include?.length) params.set('include', opts.include.join(','));
      const q = params.toString();
      return this.request<{ data: ContentPublic<F> }>(
        'GET',
        `/content/by-id/${id}${q ? '?' + q : ''}`,
        { cacheKey: `GET:/content/by-id/${id}:${opts.include?.join(',') ?? ''}` },
      );
    },

    bySlug: async <F extends Record<string, unknown> = Record<string, unknown>>(
      type: string,
      slug: string,
      opts: { locale?: string; include?: ListOptions['include'] } = {},
    ): Promise<{ data: ContentPublic<F> }> => {
      const params = new URLSearchParams();
      if (opts.locale) params.set('locale', opts.locale);
      if (opts.include?.length) params.set('include', opts.include.join(','));
      const q = params.toString();
      return this.request<{ data: ContentPublic<F> }>(
        'GET',
        `/content/by-slug/${type}/${slug}${q ? '?' + q : ''}`,
        { cacheKey: `GET:/content/by-slug/${type}/${slug}:${opts.locale ?? ''}:${opts.include?.join(',') ?? ''}` },
      );
    },

    byPath: async <F extends Record<string, unknown> = Record<string, unknown>>(
      path: string,
    ): Promise<{ data: ContentClientByPathResult & { content: ContentPublic<F> | null } }> => {
      const p = path.startsWith('/') ? path.slice(1) : path;
      return this.request<{ data: ContentClientByPathResult & { content: ContentPublic<F> | null } }>(
        'GET',
        `/content/by-path/${p}`,
        { cacheKey: `GET:/content/by-path/${p}` },
      );
    },
  };

  // ────────── Menus ──────────

  readonly menus = {
    bySlug: async (slug: string, opts: { locale?: string } = {}): Promise<{ data: MenuTree }> => {
      const params = new URLSearchParams();
      if (opts.locale) params.set('locale', opts.locale);
      const q = params.toString();
      return this.request<{ data: MenuTree }>(
        'GET',
        `/menus/${slug}${q ? '?' + q : ''}`,
        { cacheKey: `GET:/menus/${slug}:${opts.locale ?? ''}` },
      );
    },
  };

  // ────────── Settings ──────────

  readonly settings = {
    all: async (): Promise<{ data: Record<string, unknown> }> => {
      return this.request<{ data: Record<string, unknown> }>(
        'GET',
        '/settings',
        { cacheKey: 'GET:/settings' },
      );
    },
    get: async <T = unknown>(key: string): Promise<T> => {
      const resp = await this.request<{ data: Record<string, T> }>(
        'GET',
        `/settings/${key}`,
        { cacheKey: `GET:/settings/${key}` },
      );
      return resp.data[key] as T;
    },
  };

  // ────────── Forms (public submit) ──────────

  readonly forms = {
    submit: async (slug: string, data: Record<string, unknown>): Promise<{ data: { id: number; message: string } }> => {
      return this.request<{ data: { id: number; message: string } }>(
        'POST',
        `/forms/${slug}/submit`,
        { body: data },
      );
    },
  };

  // ────────── Auth (admin/SDK helpers) ──────────

  readonly auth = {
    login: async (email: string, password: string, totpCode?: string): Promise<{ data: { user: unknown; token: string; expiresAt: string } }> => {
      const body: Record<string, unknown> = { email, password };
      if (totpCode) body.totpCode = totpCode;
      return this.request<{ data: { user: unknown; token: string; expiresAt: string } }>(
        'POST',
        '/auth/login',
        { body },
      );
    },
    me: async (): Promise<{ data: { user: unknown; role: unknown; capabilities: unknown } }> => {
      return this.request('GET', '/auth/me');
    },
  };
}

export function createClient(opts: ClientOptions): CmsClient {
  return new CmsClient(opts);
}
