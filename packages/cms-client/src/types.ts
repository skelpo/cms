// Public API types. Mirror the resource shapes from the CMS api-spec.
// A `types-codegen` CLI will eventually emit type-narrowed `fields`
// per-content-type, but the base shape lives here.

export type ContentStatus = 'draft' | 'review' | 'published' | 'archived';

export interface ContentPublic<F extends Record<string, unknown> = Record<string, unknown>> {
  id: number;
  type: string;
  slug: string;
  locale: string;
  translationGroupId: number;
  status: ContentStatus;
  title: string;
  fields: F;
  seo: SeoFields;
  ai: AiFields;
  authorId: number | null;
  publishedAt: string | null;
  scheduledAt: string | null;
  revision: number;
  schemaRevision: number;
  createdAt: string;
  updatedAt: string;
  url: string | null;
  relations?: Record<string, ContentPublic[]>;
}

export interface SeoFields {
  metaTitle?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  ogImage?: number;
  ogTitle?: string;
  ogDescription?: string;
  schemaType?: string;
  noindex?: boolean;
  [k: string]: unknown;
}

export interface AiFields {
  summary?: string;
  agentContext?: string;
  [k: string]: unknown;
}

export interface MenuItemTree {
  id: number;
  label: string;
  url: string | null;
  contentId: number | null;
  target: '_self' | '_blank';
  sortOrder: number;
  children: MenuItemTree[];
}

export interface MenuTree {
  slug: string;
  label: string;
  items: MenuItemTree[];
}

export interface Pagination {
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export class CmsClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(`[${status}] ${code}: ${message}`);
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}
