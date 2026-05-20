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
  type ContentStatus,
  type MenuTree,
  type MenuItemTree,
  type Pagination,
  type ContentTypeRow,
  type FieldDef,
  type MediaRow,
  type UserRow,
  type RoleRow,
  type RedirectRow,
  type WebhookRow,
  type WebhookDelivery,
  type FormSubmission,
  type JobRow,
  type ApiTokenRow,
  type ApiTokenCreated,
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
    if (init.body instanceof FormData) { delete headers['Content-Type']; fetchInit.body = init.body; }
    if (init.signal) fetchInit.signal = init.signal;
    const resp = await this.fetcher(url, fetchInit);
    if (!resp.ok && resp.status !== 304) throw await this.errorFromResponse(resp);

    // Write ops invalidate cached reads opportunistically.
    if (method !== 'GET' && this.cache) {
      // Bare path-prefix invalidation. Webhook-driven dep-key invalidation
      // is preferred but this guards same-process round trips.
      const resource = path.replace(/^\/+/, '').split(/[/?]/)[0]!;
      this.cache.invalidate([`GET:/${resource}`]);
    }

    const text = await resp.text();
    const json = (text ? JSON.parse(text) : null) as T;
    if (method === 'GET' && this.cache && init.cacheKey && resp.ok) {
      const etag = resp.headers.get('etag') ?? undefined;
      const deps = this.parseDeps(resp);
      this.cache.set(init.cacheKey, json, deps, etag);
    }
    return json;
  }

  /** Multipart variant for media uploads. */
  private async requestMultipart<T>(path: string, form: FormData): Promise<T> {
    const url = this.base + path;
    const headers: Record<string, string> = {};
    if (this.opts.token) headers['Authorization'] = `Bearer ${this.opts.token}`;
    const resp = await this.fetcher(url, { method: 'POST', headers, body: form });
    if (!resp.ok) throw await this.errorFromResponse(resp);
    const text = await resp.text();
    return (text ? JSON.parse(text) : null) as T;
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

    // ── Write ops (require token w/ create/update/delete/publish caps) ──

    create: async <F extends Record<string, unknown> = Record<string, unknown>>(input: {
      type: string; slug: string; locale: string; title: string;
      fields?: F; seo?: Record<string, unknown>; ai?: Record<string, unknown>;
      status?: ContentStatus; translationOf?: number;
    }): Promise<{ data: ContentPublic<F> }> =>
      this.request('POST', '/content', { body: input }),

    update: async <F extends Record<string, unknown> = Record<string, unknown>>(
      id: number,
      patch: { title?: string; slug?: string; fields?: Partial<F>; seo?: Record<string, unknown>; ai?: Record<string, unknown> },
    ): Promise<{ data: ContentPublic<F> }> =>
      this.request('PATCH', `/content/${id}`, { body: patch }),

    publish:   async (id: number): Promise<{ data: { id: number; publishedAt: string } }> =>
      this.request('POST', `/content/${id}/publish`),
    unpublish: async (id: number): Promise<{ data: { id: number } }> =>
      this.request('POST', `/content/${id}/unpublish`),
    delete:    async (id: number): Promise<void> => {
      await this.request('DELETE', `/content/${id}`);
    },
  };

  // ────────── Types (content type registry) ──────────

  readonly types = {
    list:   async (): Promise<{ data: ContentTypeRow[] }> =>
      this.request('GET', '/types', { cacheKey: 'GET:/types' }),
    get:    async (slug: string): Promise<{ data: ContentTypeRow }> =>
      this.request('GET', `/types/${slug}`, { cacheKey: `GET:/types/${slug}` }),
    revisions: async (slug: string): Promise<{ data: { revision: number; changes: unknown; note: string | null; createdAt: string }[] }> =>
      this.request('GET', `/types/${slug}/revisions`),
    create: async (input: { slug: string; labelSingular: string; labelPlural: string; isRoutable?: boolean; urlPattern?: string; icon?: string; fieldsSchema: { version: number; fields: FieldDef[] } }): Promise<{ data: ContentTypeRow }> =>
      this.request('POST', '/types', { body: input }),
    evolve: async (slug: string, patch: { labelSingular?: string; labelPlural?: string; isRoutable?: boolean; urlPattern?: string; icon?: string; fieldsSchema?: { version: number; fields: FieldDef[] } }, opts: { dryRun?: boolean } = {}): Promise<{ data: { dryRun: boolean; newRevision?: number; affectedRows?: number } }> =>
      this.request('PATCH', `/types/${slug}${opts.dryRun ? '?dryRun=true' : ''}`, { body: patch }),
    delete: async (slug: string, opts: { force?: boolean } = {}): Promise<void> => {
      await this.request('DELETE', `/types/${slug}${opts.force ? '?force=true' : ''}`);
    },
  };

  // ────────── Menus ──────────

  readonly menus = {
    list: async (): Promise<{ data: { slug: string; label: string; isBuiltin: boolean }[] }> =>
      this.request('GET', '/menus', { cacheKey: 'GET:/menus' }),
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
    create: async (input: { slug: string; label: string }): Promise<{ data: { slug: string; label: string } }> =>
      this.request('POST', '/menus', { body: input }),
    update: async (slug: string, patch: { label?: string }): Promise<{ data: { slug: string; label: string } }> =>
      this.request('PATCH', `/menus/${slug}`, { body: patch }),
    delete: async (slug: string): Promise<void> => {
      await this.request('DELETE', `/menus/${slug}`);
    },
    addItem: async (slug: string, input: { label: Record<string, string>; url?: string | null; contentId?: number | null; target?: '_self' | '_blank'; sortOrder?: number; parentId?: number | null }): Promise<{ data: { id: number } }> =>
      this.request('POST', `/menus/${slug}/items`, { body: input }),
    updateItem: async (slug: string, id: number, patch: { label?: Record<string, string>; url?: string | null; target?: '_self' | '_blank'; sortOrder?: number; parentId?: number | null }): Promise<{ data: { id: number } }> =>
      this.request('PATCH', `/menus/${slug}/items/${id}`, { body: patch }),
    removeItem: async (slug: string, id: number): Promise<void> => {
      await this.request('DELETE', `/menus/${slug}/items/${id}`);
    },
    reorderItems: async (slug: string, items: { id: number; parentId: number | null; sortOrder: number }[]): Promise<void> => {
      await this.request('POST', `/menus/${slug}/items/reorder`, { body: { items } });
    },
  };

  // ────────── Settings ──────────

  readonly settings = {
    all: async (): Promise<{ data: Record<string, unknown> }> =>
      this.request('GET', '/settings', { cacheKey: 'GET:/settings' }),
    get: async <T = unknown>(key: string): Promise<T> => {
      const resp = await this.request<{ data: Record<string, T> }>(
        'GET',
        `/settings/${key}`,
        { cacheKey: `GET:/settings/${key}` },
      );
      return resp.data[key] as T;
    },
    set: async <T = unknown>(key: string, value: T): Promise<void> => {
      await this.request('PUT', `/settings/${encodeURIComponent(key)}`, { body: { value } });
    },
    setMany: async (kv: Record<string, unknown>): Promise<void> => {
      await this.request('PUT', '/settings', { body: kv });
    },
  };

  // ────────── Media ──────────

  readonly media = {
    list: async (opts: { mimeType?: string; limit?: number } = {}): Promise<{ data: MediaRow[] }> => {
      const params = new URLSearchParams();
      if (opts.mimeType) params.set('mimeType', opts.mimeType);
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      const q = params.toString();
      return this.request('GET', `/media${q ? '?' + q : ''}`, { cacheKey: `GET:/media?${q}` });
    },
    get: async (id: number): Promise<{ data: MediaRow }> =>
      this.request('GET', `/media/${id}`, { cacheKey: `GET:/media/${id}` }),
    /** Returns the public URL for raw bytes (may redirect to a CDN/S3 if configured). */
    rawUrl: (id: number): string => `${this.base}/media/${id}/raw`,
    /** Get a signed transform URL via the CMS's configured imgproxy. */
    signedUrl: async (id: number, opts: { w?: number; h?: number; format?: 'jpg' | 'png' | 'webp' | 'avif'; quality?: number; fit?: 'contain' | 'cover'; gravity?: 'focal' } = {}): Promise<{ data: { url: string } }> => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(opts)) if (v !== undefined) p.set(k, String(v));
      const q = p.toString();
      return this.request('GET', `/media/${id}/url${q ? '?' + q : ''}`);
    },
    upload: async (input: { file: Blob; filename: string; mimeType?: string; altText?: Record<string, string>; focalPoint?: { x: number; y: number } }): Promise<{ data: MediaRow }> => {
      const form = new FormData();
      form.append('file', input.file, input.filename);
      if (input.altText)    form.append('altText',    JSON.stringify(input.altText));
      if (input.focalPoint) form.append('focalPoint', JSON.stringify(input.focalPoint));
      return this.requestMultipart('/media', form);
    },
    update: async (id: number, patch: { altText?: Record<string, string>; focalPoint?: { x: number; y: number }; filename?: string }): Promise<{ data: MediaRow }> =>
      this.request('PATCH', `/media/${id}`, { body: patch }),
    delete: async (id: number): Promise<void> => { await this.request('DELETE', `/media/${id}`); },
  };

  // ────────── Users + roles ──────────

  readonly users = {
    list:      async (): Promise<{ data: UserRow[] }> => this.request('GET', '/users'),
    create:    async (input: { email: string; displayName: string; password: string; roleSlug: string }): Promise<{ data: UserRow }> =>
      this.request('POST', '/users', { body: input }),
    update:    async (id: number, patch: { displayName?: string; roleSlug?: string; password?: string }): Promise<{ data: UserRow }> =>
      this.request('PATCH', `/users/${id}`, { body: patch }),
    suspend:   async (id: number): Promise<void> => { await this.request('POST', `/users/${id}/suspend`); },
    unsuspend: async (id: number): Promise<void> => { await this.request('POST', `/users/${id}/unsuspend`); },
  };

  readonly roles = {
    list:   async (): Promise<{ data: RoleRow[] }> => this.request('GET', '/roles'),
    create: async (input: { slug: string; label: string; capabilities: { global: string[]; perType?: Record<string, string[]> } }): Promise<{ data: RoleRow }> =>
      this.request('POST', '/roles', { body: input }),
    update: async (slug: string, patch: { label?: string; capabilities?: { global?: string[]; perType?: Record<string, string[]> } }): Promise<{ data: RoleRow }> =>
      this.request('PATCH', `/roles/${slug}`, { body: patch }),
    delete: async (slug: string): Promise<void> => { await this.request('DELETE', `/roles/${slug}`); },
  };

  // ────────── Redirects ──────────

  readonly redirects = {
    list:    async (): Promise<{ data: RedirectRow[] }> => this.request('GET', '/redirects'),
    create:  async (input: { fromPath: string; toPath: string; statusCode?: 301 | 302 | 307 | 308 }): Promise<{ data: RedirectRow }> =>
      this.request('POST', '/redirects', { body: input }),
    update:  async (id: number, patch: Partial<{ fromPath: string; toPath: string; statusCode: 301 | 302 | 307 | 308 }>): Promise<{ data: RedirectRow }> =>
      this.request('PATCH', `/redirects/${id}`, { body: patch }),
    delete:  async (id: number): Promise<void> => { await this.request('DELETE', `/redirects/${id}`); },
    resolve: async (path: string): Promise<{ data: { match: RedirectRow | null } }> =>
      this.request('GET', `/redirects/resolve?path=${encodeURIComponent(path)}`),
  };

  // ────────── Webhooks ──────────

  readonly webhooks = {
    list:       async (): Promise<{ data: WebhookRow[] }> => this.request('GET', '/webhooks'),
    create:     async (input: { url: string; events: string[]; secret?: string; active?: boolean }): Promise<{ data: WebhookRow }> =>
      this.request('POST', '/webhooks', { body: input }),
    update:     async (id: number, patch: Partial<{ url: string; events: string[]; secret: string; active: boolean }>): Promise<{ data: WebhookRow }> =>
      this.request('PATCH', `/webhooks/${id}`, { body: patch }),
    delete:     async (id: number): Promise<void> => { await this.request('DELETE', `/webhooks/${id}`); },
    deliveries: async (id: number): Promise<{ data: WebhookDelivery[] }> =>
      this.request('GET', `/webhooks/${id}/deliveries`),
  };

  // ────────── Jobs ──────────

  readonly jobs = {
    stats: async (): Promise<{ data: Record<string, number> }> => this.request('GET', '/jobs/stats'),
    list:  async (opts: { status?: string; limit?: number } = {}): Promise<{ data: JobRow[] }> => {
      const p = new URLSearchParams();
      if (opts.status) p.set('status', opts.status);
      if (opts.limit !== undefined) p.set('limit', String(opts.limit));
      const q = p.toString();
      return this.request('GET', `/jobs${q ? '?' + q : ''}`);
    },
    get:   async (id: number): Promise<{ data: JobRow & { payload: unknown } }> => this.request('GET', `/jobs/${id}`),
    retry: async (id: number): Promise<{ data: { id: number; requeued: boolean } }> => this.request('POST', `/jobs/${id}/retry`),
  };

  // ────────── Forms (public submit + admin reads) ──────────

  readonly forms = {
    submit: async (slug: string, data: Record<string, unknown>): Promise<{ data: { id: number; message: string } }> =>
      this.request('POST', `/forms/${slug}/submit`, { body: data }),
    submissions:      async (slug: string, opts: { limit?: number } = {}): Promise<{ data: FormSubmission[] }> => {
      const q = opts.limit !== undefined ? `?limit=${opts.limit}` : '';
      return this.request('GET', `/forms/${slug}/submissions${q}`);
    },
    deleteSubmission: async (id: number): Promise<void> => { await this.request('DELETE', `/forms/submissions/${id}`); },
    markSpam:         async (id: number): Promise<void> => { await this.request('POST', `/forms/submissions/${id}/mark-spam`); },
  };

  // ────────── Auth ──────────

  readonly auth = {
    login: async (email: string, password: string, totpCode?: string): Promise<{ data: { user: unknown; token: string; expiresAt: string } }> => {
      const body: Record<string, unknown> = { email, password };
      if (totpCode) body.totpCode = totpCode;
      return this.request('POST', '/auth/login', { body });
    },
    logout:  async (): Promise<void> => { await this.request('POST', '/auth/logout'); },
    me:      async (): Promise<{ data: { user: { id: number; email: string; displayName: string }; role: RoleRow; capabilities: { global: string[]; perType?: Record<string, string[]> } } }> =>
      this.request('GET', '/auth/me'),
    refresh: async (): Promise<{ data: { token: string; expiresAt: string } }> =>
      this.request('POST', '/auth/refresh'),
    tokens: {
      list:   async (): Promise<{ data: ApiTokenRow[] }> => this.request('GET', '/auth/tokens'),
      create: async (input: { name: string; scopes?: string[]; ttlDays?: number }): Promise<{ data: ApiTokenCreated }> =>
        this.request('POST', '/auth/tokens', { body: input }),
      revoke: async (id: number): Promise<void> => { await this.request('DELETE', `/auth/tokens/${id}`); },
    },
  };
}

export function createClient(opts: ClientOptions): CmsClient {
  return new CmsClient(opts);
}
