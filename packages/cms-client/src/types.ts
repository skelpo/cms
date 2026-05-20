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

// ── Content types registry ──────────────────────────────────────────

export type FieldType =
  | 'text' | 'textarea' | 'richtext' | 'number' | 'boolean' | 'date' | 'datetime'
  | 'url' | 'email' | 'color' | 'select' | 'multiselect'
  | 'image' | 'gallery' | 'file' | 'relation' | 'repeater' | 'json';

export interface FieldDef {
  name: string;
  type: FieldType;
  label?: string;
  required?: boolean;
  translatable?: boolean;
  validation?: { options?: string[]; min?: number; max?: number; maxLength?: number; pattern?: string };
  repeater?: { fields: FieldDef[]; min?: number; max?: number };
}

export interface ContentTypeRow {
  id: number;
  slug: string;
  labelSingular: string;
  labelPlural: string;
  isRoutable: boolean;
  urlPattern: string | null;
  icon: string | null;
  fieldsSchema: { version: number; fields: FieldDef[] };
  currentRevision: number;
  isBuiltin: boolean;
}

// ── Media ───────────────────────────────────────────────────────────

export interface MediaRow {
  id: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  altText: Record<string, string>;
  focalPoint: { x: number; y: number } | null;
  createdAt: string;
  urlRaw: string;
}

// ── Users / roles ───────────────────────────────────────────────────

export interface UserRow {
  id: number;
  email: string;
  displayName: string;
  status: 'active' | 'suspended';
  roleSlug: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface RoleRow {
  id: number;
  slug: string;
  label: string;
  capabilities: { global: string[]; perType?: Record<string, string[]> };
  isBuiltin: boolean;
}

// ── Redirects / webhooks ────────────────────────────────────────────

export interface RedirectRow {
  id: number;
  fromPath: string;
  toPath: string;
  statusCode: 301 | 302 | 307 | 308;
  createdAt: string;
}

export interface WebhookRow {
  id: number;
  url: string;
  events: string[];
  secret: string | null;
  active: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: number;
  webhookId: number;
  event: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  responseCode: number | null;
  lastError: string | null;
  createdAt: string;
}

// ── Forms ───────────────────────────────────────────────────────────

export interface FormSubmission {
  id: number;
  formSlug: string;
  fields: Record<string, unknown>;
  ip: string | null;
  status: 'new' | 'read' | 'spam';
  createdAt: string;
}

// ── Jobs ────────────────────────────────────────────────────────────

export interface JobRow {
  id: number;
  queue: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  runAt: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

// ── Auth ────────────────────────────────────────────────────────────

export interface ApiTokenRow {
  id: number;
  name: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}
export interface ApiTokenCreated extends ApiTokenRow {
  /** Plain token — shown only once on creation. */
  token: string;
}
