# Skelpo CMS — REST API Specification v1

**Status:** Draft v0.1 — design contract before implementation.
**Date:** 2026-05-19

This document is the contract between `skelpo-cms` (backend), `@skelpo/cms-client` (SDK), `@skelpo/site-kit` (helpers), the HTMX admin UI, and any customer/mobile client. Lock changes here before touching code.

---

## Conventions

- **Base URL:** `https://cms.example.com/api/v1`
- **Format:** JSON request + response. `Content-Type: application/json`. File uploads use `multipart/form-data`.
- **Versioning:** URL-path versioned (`/api/v1`). Breaking changes bump to `/api/v2`.
- **Auth:** Session cookie (`skelpoSession`, HttpOnly, Secure, SameSite=Lax) **OR** `Authorization: Bearer <token>`. Same endpoints accept either.
- **IDs:** Resource IDs are `bigint` serialized as JSON numbers. (Stay <2^53 for safety.)
- **Locales:** BCP-47 short codes: `en`, `de`, `de-CH`, etc.
- **Timestamps:** ISO 8601 UTC: `2026-05-19T15:30:00Z`.
- **CORS:** Configurable allowed origins; admin UI does not need CORS (same-origin).

### Response shapes

Single resource:
```json
{ "data": { ... } }
```

Collection (cursor-paginated):
```json
{
  "data": [ ... ],
  "pagination": {
    "nextCursor": "eyJpZCI6MTIzfQ==",
    "hasMore": true,
    "total": 1543
  }
}
```

Collection (offset-paginated — admin only):
```json
{
  "data": [ ... ],
  "pagination": { "page": 2, "perPage": 25, "totalPages": 62, "total": 1543 }
}
```

### Error shape

```json
{
  "error": {
    "code": "validationError",
    "message": "Field 'metaDescription' is required to publish.",
    "details": {
      "field": "metaDescription",
      "constraint": "requiredOnPublish"
    },
    "requestId": "req_01HXY..."
  }
}
```

**Error codes** (top-level `code`):
- `unauthorized` (401) — no/invalid session/token
- `forbidden` (403) — auth ok but capability missing
- `notFound` (404)
- `validationError` (422) — request shape valid, semantic violation
- `badRequest` (400) — malformed
- `conflict` (409) — slug collision, version conflict
- `rateLimited` (429)
- `internalError` (500)
- `unavailable` (503)

### Caching headers (read endpoints only)

Every cacheable GET returns:
```
Cache-Control: private, max-age=0, must-revalidate
ETag: "<hash>"
Last-Modified: <date>
Surrogate-Key: content-42 type-list:post:en menu:main
```

Clients send `If-None-Match: "<hash>"` for 304s. SDK uses this for its in-memory cache.

### Standard headers on every response

```
X-Request-Id: req_01HXY...
X-Skelpo-Version: 1.0.0
X-Skelpo-Schema-Revision: 12
```

---

## 1. Authentication

### POST `/auth/login`

**Auth:** none. **Rate-limited** by IP and email (5/min).

Request:
```json
{
  "email": "admin@example.com",
  "password": "...",
  "totpCode": "123456"  // optional, required if user has TOTP enabled
}
```

Response 200:
```json
{
  "data": {
    "user": { /* User */ },
    "token": "skp_v1_...",   // bearer token (also for mobile/SDK)
    "expiresAt": "2026-06-19T15:30:00Z"
  }
}
```

Sets `skelpoSession` cookie. Returns `token` in body for SDK/mobile.

**Errors:** `unauthorized` (bad credentials), `validationError` (TOTP required/incorrect), `rateLimited`.

### POST `/auth/logout`

**Auth:** required. Invalidates session/token. Returns 204.

### GET `/auth/me`

**Auth:** required. Returns current user + role + capabilities.
```json
{ "data": { "user": {...}, "role": {...}, "capabilities": {...} } }
```

### POST `/auth/refresh`

**Auth:** required (existing token). Issues a new token, invalidates the old after a grace window. Returns same shape as `/auth/login`.

### POST `/auth/password-reset/request`

**Auth:** none. Rate-limited.
```json
{ "email": "user@example.com" }
```
Always returns 204 (no enumeration). Sends email if account exists.

### POST `/auth/password-reset/confirm`

**Auth:** none. Verifies token from email.
```json
{ "token": "...", "newPassword": "..." }
```

### POST `/auth/totp/setup`

**Auth:** required. Returns provisioning URI + QR data:
```json
{ "data": { "secret": "...", "otpauthUri": "otpauth://...", "qrSvg": "<svg.../>" } }
```

### POST `/auth/totp/verify`

**Auth:** required. Activates TOTP.
```json
{ "code": "123456" }
```

### DELETE `/auth/totp`

**Auth:** required (with current TOTP code). Disables TOTP.

### POST `/auth/tokens` *(API tokens)*

**Auth:** required. Creates a programmatic token (long-lived).
```json
{ "name": "perry.land site", "scopes": ["read:content", "submit:forms"] }
```
Response:
```json
{ "data": { "id": 12, "name": "...", "token": "skp_tok_...", "scopes": [...] } }
```
**Token shown once.**

### GET `/auth/tokens`, DELETE `/auth/tokens/:id`

List + revoke.

---

## 2. Content

The core endpoint surface. All `published` reads can use cache; reads of drafts require auth + capability.

### GET `/content`

**Auth:** optional (drafts require auth).

Query params:
- `type` (string, required) — content type slug, e.g. `post`
- `locale` (string, default: site default)
- `status` (string, default: `published`) — comma-separated: `draft,review,published,archived`
- `authorId` (number)
- `slug` (string, exact match)
- `q` (string) — title search
- `tag`, `category`, `<any-field>` (string) — custom field filters via JSON path
- `publishedBefore`, `publishedAfter` (ISO date)
- `sort` (string, default: `-publishedAt`) — prefix `-` for descending. Allowed: `publishedAt`, `createdAt`, `title`, `updatedAt`
- `limit` (number, default: 20, max: 100)
- `cursor` (string) — opaque pagination cursor
- `include` (string) — comma-separated relations: `author,relations,media`
- `fields` (string) — comma-separated fields to return (sparse fieldset for perf)

Response: cursor-paginated `Content[]`.

**Surrogate-Key emitted:** `type-list:<type>:<locale>` + one `content:<id>` per result.

### GET `/content/by-id/:id`

**Auth:** required for drafts.
Query: `include`, `fields`, `locale` (returns the version in that locale via translationGroupId).

### GET `/content/by-slug/:type/:slug`

**Auth:** optional. Returns published content unless `?status=draft` and authed.
Query: `locale`, `include`, `fields`.

### GET `/content/by-path/:path*`

The route resolver — used by customer's catchall route handler.
**Auth:** optional.
- `path` = full URL path without leading `/`, e.g. `blog/hello-world`
- Resolves against `contentTypes.urlPattern`
- Returns content + matched type + matched route segments + redirect chain if applicable

Response:
```json
{
  "data": {
    "type": "post",
    "content": { /* Content */ },
    "redirect": null  // or { "to": "/new-url", "status": 301 }
  }
}
```

### POST `/content`

**Auth:** required. Capability: `<type>.create`.
```json
{
  "type": "post",
  "slug": "hello-world",
  "locale": "en",
  "title": "Hello World",
  "fields": { "body": {...tiptap...}, "heroImage": 42 },
  "seo": { "metaDescription": "...", "metaTitle": "..." },
  "ai": { "summary": "..." },
  "status": "draft",
  "translationOf": null  // or contentId to link as translation
}
```

Response 201: full `Content`.

### PATCH `/content/:id`

**Auth:** required. Capability: `<type>.update` or `.updateOwn` (with author check).
Partial update — only included keys are changed. Creates a new revision row.

Request body: same shape as POST but all fields optional.

Optional header `If-Match: "<etag>"` for optimistic concurrency. Returns `409 conflict` if mismatched.

### DELETE `/content/:id`

**Auth:** required. Capability: `<type>.delete` or `.deleteOwn`.
Soft-deletes (sets status to `archived`). Hard-delete via `?hard=true` requires `<type>.delete` capability + admin role.

### POST `/content/:id/publish`

**Auth:** required. Capability: `<type>.publish`.
Validates required fields (meta description, alt text on images, etc.). Returns `validationError` with all failing fields on a single response.

Response:
```json
{ "data": { /* Content */ }, "warnings": [...] }
```

**Side effects:** invalidates `content:<id>`, `type-list:<type>:<locale>`, fires `content.published` webhook, queues pre-render jobs.

### POST `/content/:id/unpublish`

**Auth:** required. Capability: `<type>.publish`. Sets status to `draft`.

### POST `/content/:id/schedule`

**Auth:** required. Capability: `<type>.publish`.
```json
{ "at": "2026-06-01T09:00:00Z" }
```
Job worker publishes at scheduled time.

### POST `/content/:id/duplicate`

**Auth:** required. Creates a copy as draft.
```json
{ "locale": "de", "slug": "kopie-von-x" }  // optional
```

### GET `/content/:id/revisions`

**Auth:** required. Capability: `<type>.readDrafts`.
Returns list of revisions with author + timestamp + reason. Pagination: offset.

### GET `/content/:id/revisions/:revision`

Returns the full snapshot of a specific revision.

### POST `/content/:id/revert/:revision`

**Auth:** required. Capability: `<type>.update`. Creates a new revision matching the target's snapshot.

### POST `/content/:id/preview-token`

**Auth:** required. Returns a short-lived token for previewing a draft on the public site.
```json
{ "data": { "token": "...", "expiresAt": "...", "url": "https://site.com/blog/hello?_preview=..." } }
```

### GET `/content/preview`

**Auth:** none (token-based). Query: `token=<previewToken>`.
Returns the draft content as if it were published. Used by customer's frontend when `?_preview=` query param is present.

### POST `/content/:id/translate`

**Auth:** required. Convenience endpoint: creates a translated draft sibling.
```json
{ "locale": "de", "copyFields": true }
```

---

## 3. Content Types (the ACF-style schemas)

### GET `/types`

**Auth:** required (read-only ok with `manageTypes` or just session).
```json
{ "data": [ { "slug": "post", "labelSingular": "Post", ... } ] }
```

### GET `/types/:slug`

Returns full type definition including current `fieldsSchema`.

### POST `/types`

**Auth:** required. Capability: `manageTypes`.
```json
{
  "slug": "service",
  "labelSingular": "Service",
  "labelPlural": "Services",
  "isRoutable": true,
  "urlPattern": "/services/:slug",
  "fieldsSchema": { "version": 1, "fields": [...] },
  "icon": "wrench"
}
```

Built-in types cannot be created/deleted; only their `fieldsSchema` may be edited.

### PATCH `/types/:slug`

**Auth:** required. Capability: `manageTypes`.
Updating `fieldsSchema` creates a new revision in `contentTypeRevisions`. Pass migration details:
```json
{
  "fieldsSchema": {...},
  "changes": {
    "added": [ {"name": "ctaText", "default": "Learn more"} ],
    "removed": [],
    "renamed": [],
    "retyped": []
  },
  "dryRun": false
}
```

If `dryRun=true`, returns affected row count + validation warnings without writing.

### DELETE `/types/:slug`

**Auth:** required. Capability: `manageTypes`. Forbidden for built-ins. Returns `409` if any content exists; requires `?force=true&archiveContent=true`.

### GET `/types/:slug/revisions`

List schema revisions for audit + rollback.

### POST `/types/:slug/revert/:revision`

Roll back the schema (creates a new revision that's the inverse).

---

## 4. Media

### GET `/media`

**Auth:** required.
Query: `mimeType`, `q` (filename search), `uploadedBy`, `limit`, `cursor`.

### GET `/media/:id`

Returns metadata only.

### POST `/media`

**Auth:** required. Capability: `manageMedia` or `<type>.create` (when uploading inline during content edit).
**Content-Type:** `multipart/form-data`
Fields: `file` (binary), `altText` (JSON string, per-locale), `focalPoint` (JSON `{x,y}`).

Response 201:
```json
{
  "data": {
    "id": 42,
    "filename": "hero.jpg",
    "mimeType": "image/jpeg",
    "sizeBytes": 234567,
    "width": 1920,
    "height": 1080,
    "altText": { "en": "..." },
    "focalPoint": { "x": 0.5, "y": 0.4 },
    "urlOriginal": "https://cms.example.com/api/v1/media/42/raw",
    "uploadedAt": "..."
  }
}
```

### PATCH `/media/:id`

Update `altText`, `focalPoint`, `filename` (display only).

### DELETE `/media/:id`

Returns `409` if media is referenced by any content unless `?force=true`.

### GET `/media/:id/raw`

Streams the original file. `Cache-Control: public, max-age=31536000, immutable`.

### GET `/media/:id/url`

Returns a **signed imgproxy URL** with the requested transforms.
Query: `w`, `h`, `format` (auto|webp|avif|jpeg|png), `quality`, `fit` (cover|contain), `gravity` (focal|center).

Response:
```json
{ "data": { "url": "https://img.example.com/sig/.../w:800/...", "expiresAt": null } }
```

Signed URLs may be permanent (no expiry) since imgproxy validates the HMAC.

### GET `/media/:id/usage`

Returns content IDs referencing this media. Used by admin before delete.

---

## 5. Users + Roles

### GET `/users`

**Auth:** required. Capability: `manageUsers`.
Query: `q`, `role`, `status`, `limit`, `cursor`.

### GET `/users/:id`

**Auth:** required. Capability: `manageUsers` or self.

### POST `/users`

**Auth:** required. Capability: `manageUsers`.
```json
{
  "email": "...",
  "displayName": "...",
  "roleId": 3,
  "locale": "en",
  "sendInvite": true
}
```
Creates user with `status: invited`, generates invite token, sends invite email.

### PATCH `/users/:id`

Update fields. Setting `password` requires current password (or `manageUsers`).

### DELETE `/users/:id`

Soft-delete (sets `status: suspended`). Content authored by user is preserved; `authorId` remains intact.

### POST `/users/:id/resend-invite`

Re-sends invite email with fresh token.

### POST `/users/:id/suspend`, POST `/users/:id/unsuspend`

Toggle status.

### GET `/roles`

**Auth:** required.

### POST `/roles`, PATCH `/roles/:slug`, DELETE `/roles/:slug`

**Auth:** required. Capability: `manageRoles`. Built-in roles can have capabilities edited but not deleted.

### GET `/roles/:slug/users`

List users with this role. Offset paginated.

---

## 6. Menus

### GET `/menus`

**Auth:** none. Returns list of menu slugs + labels (lightweight).

### GET `/menus/:slug`

**Auth:** none.
Query: `locale` (required for translated labels).
Returns full nested tree:
```json
{
  "data": {
    "slug": "main",
    "label": "Main Menu",
    "items": [
      {
        "id": 1,
        "label": "About",
        "url": "/about",
        "contentId": 7,
        "target": "_self",
        "children": []
      },
      {
        "id": 2,
        "label": "Services",
        "url": null,
        "contentId": null,
        "target": "_self",
        "children": [
          { "id": 5, "label": "Web Design", "url": "/services/web-design", ... }
        ]
      }
    ]
  }
}
```

**Surrogate-Key:** `menu:<slug>:<locale>`.

### POST `/menus`

**Auth:** required. Capability: `manageMenus`.
```json
{ "slug": "footer", "label": "Footer" }
```

### PATCH `/menus/:slug`, DELETE `/menus/:slug`

Update label, delete (forbidden for built-in `main`/`footer`).

### POST `/menus/:slug/items`

```json
{
  "parentId": null,
  "label": { "en": "About", "de": "Über uns" },
  "url": "/about",            // OR
  "contentId": 7,            // (mutually exclusive — contentId derives url)
  "target": "_self",
  "sortOrder": 0
}
```

### PATCH `/menus/:slug/items/:id`

Update an item (including parentId for nesting, sortOrder for reorder).

### POST `/menus/:slug/items/reorder`

Bulk reorder — efficient drag-drop save.
```json
{ "items": [ { "id": 1, "parentId": null, "sortOrder": 0 }, ... ] }
```

### DELETE `/menus/:slug/items/:id`

Cascades children (admin warns first).

---

## 7. Settings

### GET `/settings`

Returns all settings as flat object.
```json
{ "data": {
  "site.name": "Perry",
  "site.tagline": "...",
  "site.defaultLocale": "en",
  "site.locales": ["en", "de"],
  "site.url": "https://perry.land",
  "site.logoMediaId": 12,
  "site.faviconMediaId": 13,
  "site.social.twitter": "@perry_ts",
  "site.social.github": "PerryTS",
  "site.contact.email": "hello@perry.land",
  "seo.defaultOgImageId": 14,
  "seo.robots": "index,follow",
  "seo.organizationSchema": { "@type": "Organization", ... },
  "ai.llmsTxtIntro": "...",
  "email.fromAddress": "hello@perry.land",
  "email.fromName": "Perry"
} }
```

### GET `/settings/:key`

Returns single value.

### PUT `/settings/:key`

**Auth:** required. Capability: `manageSettings`.
```json
{ "value": "..." }
```
Some keys (like `site.url`, `site.defaultLocale`) require additional confirmation.

### PUT `/settings`

Bulk update.
```json
{ "site.name": "...", "site.tagline": "..." }
```

**Surrogate-Key emitted:** `setting:<key>` per key changed.

---

## 8. Forms

### POST `/forms/:slug/submit`

**Auth:** none (public). **Rate-limited** by IP (5/min) and global (1000/min).
**Spam protection:** honeypot field `_hp` must be empty; `_ts` (timestamp) must show >2s elapsed since form render.

Request:
```json
{
  "name": "Jane",
  "email": "jane@example.com",
  "message": "Hello",
  "_hp": "",
  "_ts": 1700000000000
}
```

Response 200:
```json
{ "data": { "id": 12345, "message": "Thanks! We'll be in touch." } }
```

**Side effects:** stores submission, queues admin notification email, queues auto-responder email, fires `form.submitted` webhook.

### GET `/forms/:slug/submissions`

**Auth:** required. Capability: `manageForms` or `<form-content>.read`.
Query: `q`, `isSpam`, `limit`, `cursor`, `since`, `until`.

### GET `/forms/submissions/:id`

### DELETE `/forms/submissions/:id`

### POST `/forms/submissions/:id/mark-spam` / `mark-ham`

Trains the spam heuristics (future ML).

### GET `/forms/:slug/submissions.csv`

Streaming CSV export.

---

## 9. Email Templates

### GET `/email-templates`, GET `/email-templates/:slug`

### PATCH `/email-templates/:slug`

**Auth:** required. Capability: `manageSettings`.
```json
{ "subject": "...", "bodyHtml": "...", "bodyText": "...", "locale": "en" }
```
Built-in templates cannot be deleted; only edited.

### POST `/email-templates/:slug/send-test`

```json
{ "to": "me@example.com", "variables": { "userName": "..." } }
```

### GET `/email-templates/:slug/preview`

Returns rendered HTML for the template with sample variables.

---

## 10. Redirects

### GET `/redirects`

**Auth:** required.
Query: `q`, `limit`, `cursor`.

### POST `/redirects`

```json
{ "source": "/old-url", "destination": "/new-url", "statusCode": 301 }
```

### PATCH `/redirects/:id`, DELETE `/redirects/:id`

### POST `/redirects/import`

CSV upload (`source,destination,statusCode`).

### GET `/redirects.csv`

Export.

---

## 11. Webhooks

### GET `/webhooks`

**Auth:** required. Capability: `manageSettings`.

### POST `/webhooks`

```json
{
  "url": "https://perry.land/webhook/cms",
  "events": ["content.published", "content.updated", "menu.updated", "setting.changed"],
  "active": true
}
```
Response includes `secret` (HMAC signing key, shown once).

### PATCH `/webhooks/:id`, DELETE `/webhooks/:id`

### POST `/webhooks/:id/test`

Sends a sample payload to the URL. Returns the response status + body.

### GET `/webhooks/:id/deliveries`

Last 100 delivery attempts with status, latency, response body. For debugging.

### POST `/webhooks/:id/deliveries/:deliveryId/retry`

### Webhook payload shape (delivered to customer's endpoint)

```http
POST /webhook/cms HTTP/1.1
Content-Type: application/json
X-Skelpo-Event: content.published
X-Skelpo-Delivery: dlv_01HXY...
X-Skelpo-Signature: t=1700000000,v1=<hmac_sha256>
X-Skelpo-Schema-Revision: 12

{
  "event": "content.published",
  "deliveredAt": "2026-05-19T15:30:00Z",
  "data": {
    "content": { /* full Content */ }
  },
  "depKeys": ["content:42", "type-list:post:en"]
}
```

Customer's webhook handler verifies signature, invalidates `depKeys` in its cache.

### Event types

- `content.created`, `content.updated`, `content.published`, `content.unpublished`, `content.deleted`
- `media.uploaded`, `media.updated`, `media.deleted`
- `menu.updated`
- `setting.changed`
- `form.submitted`
- `redirect.updated`
- `type.schemaChanged`

---

## 12. Search

### GET `/search`

**Auth:** optional (filters by readable content).
Query: `q` (required), `type` (filter), `locale`, `limit`, `cursor`.

Response: `Content[]` with `score` and `excerpt` fields.

```json
{ "data": [ { "id": 42, "type": "post", "title": "...", "excerpt": "...<em>match</em>...", "score": 1.4, "url": "/blog/..." } ], "pagination": {...} }
```

Backed by MySQL FTS in v1. Swappable to Meilisearch/Tantivy in v2.

---

## 13. Analytics

### GET `/analytics/overview`

**Auth:** required. Capability: `viewAnalytics`.
Query: `since`, `until`, `granularity` (hour|day|week).
```json
{ "data": {
  "pageviewsTotal": 12345,
  "uniqueVisitorsTotal": 4567,
  "timeseries": [{ "ts": "...", "pageviews": ..., "uniques": ... }]
} }
```

### GET `/analytics/pages`

Top pages by views.

### GET `/analytics/referrers`

Top referrers.

### GET `/analytics/content/:id`

Per-content analytics (used in admin's content detail page).

### POST `/analytics/track` *(internal)*

Used by customer's site to record pageviews server-side. Public, HMAC-signed using the site's API token. Body:
```json
{ "path": "/blog/x", "locale": "en", "referrer": "...", "userAgent": "...", "ipHash": "..." }
```
(Customer's site computes ipHash; CMS never sees raw IPs.)

---

## 14. Schema export/codegen

### GET `/schema/export`

**Auth:** required. Capability: `manageTypes`.
Returns full content type definitions + role definitions + email template slugs as JSON. For git-tracking schemas.

### POST `/schema/import`

Apply a previously exported schema file (with diff preview + dry-run).

### GET `/schema/types-codegen.ts`

Returns a TypeScript file with typed interfaces for every content type, used by `@skelpo/cms-client`:
```ts
export interface Post {
  id: bigint
  slug: string
  title: string
  fields: {
    body: TipTapDocument
    heroImage: number
    relatedPosts: number[]
    /* ... */
  }
  seo: SeoFields
  // ...
}
```

Customer runs `skelpo-cms types-codegen` to regenerate this in their site repo after schema changes.

---

## 15. Jobs

### GET `/jobs`

**Auth:** required. Capability: `manageJobs`.
Query: `kind`, `status`, `limit`, `cursor`.

### GET `/jobs/:id`

Full job details including payload + error.

### POST `/jobs/:id/retry`

Reset status to `pending`, runAt to now.

### DELETE `/jobs/:id`

Cancels pending or dead jobs.

---

## 16. Audit log

### GET `/audit`

**Auth:** required. Capability: `viewAuditLog`.
Query: `userId`, `action`, `entityType`, `entityId`, `since`, `until`, `limit`, `cursor`.

---

## 17. Health + metrics

### GET `/healthz`

**Auth:** none.
Returns 200 with `{ status: "ok" }` if DB reachable, else 503.

### GET `/readyz`

**Auth:** none. Returns 200 once migrations complete and HTTP listener bound.

### GET `/metrics`

**Auth:** Bearer token (configurable, separate from user tokens). Prometheus text format.

Exposes:
- `skelpo_http_requests_total{method,path,status}`
- `skelpo_http_request_duration_seconds_bucket{...}` (histogram)
- `skelpo_cache_hits_total`, `skelpo_cache_misses_total`
- `skelpo_db_query_duration_seconds_bucket`
- `skelpo_jobs_pending`, `skelpo_jobs_failed_total{kind}`
- `skelpo_webhookDeliveries_total{status}`

---

## 18. Resource shapes (referenced above)

### Content

```ts
{
  id: number,
  type: string,                      // type slug
  slug: string,
  locale: string,
  translationGroupId: number,
  status: 'draft' | 'review' | 'published' | 'archived',
  title: string,
  fields: Record<string, unknown>,   // custom fields per type
  seo: {
    metaTitle?: string,
    metaDescription: string,        // required for publish
    canonicalUrl?: string,
    ogImage?: number,               // media id
    schemaType?: string,            // schema.org type override
    noindex: boolean
  },
  ai: {
    summary?: string,                // for llms.txt
    agentContext?: string
  },
  author: { id: number, displayName: string },
  url: string | null,                // computed from type.urlPattern + slug + locale
  publishedAt: string | null,
  scheduledAt: string | null,
  revision: number,
  schemaRevision: number,           // content type schema rev this row was saved against
  createdAt: string,
  updatedAt: string,
  // Only present when include=relations
  relations?: Record<string, Content[]>,
  // Only present when include=author
  authorFull?: User
}
```

### User

```ts
{
  id: number,
  email: string,           // hidden from non-managers in collection responses
  displayName: string,
  role: { id: number, slug: string, label: string },
  locale: string,
  totpEnabled: boolean,
  status: 'active' | 'suspended' | 'invited',
  lastLoginAt: string | null,
  createdAt: string
}
```

### Role

```ts
{
  id: number,
  slug: string,
  label: string,
  capabilities: {
    global: string[],
    types: Record<string, string[]>   // typeSlug → capability[]
  },
  isBuiltin: boolean,
  userCount: number
}
```

### Media

```ts
{
  id: number,
  filename: string,
  mimeType: string,
  sizeBytes: number,
  width?: number,
  height?: number,
  altText: Record<string, string>,    // per-locale
  focalPoint?: { x: number, y: number },
  uploadedBy: { id: number, displayName: string },
  urlRaw: string,
  createdAt: string
}
```

### MenuItem

```ts
{
  id: number,
  parentId: number | null,
  label: string,                       // resolved for requested locale
  labelAllLocales?: Record<string, string>,  // only in admin context
  url: string | null,
  contentId: number | null,
  target: '_self' | '_blank',
  sortOrder: number,
  children: MenuItem[]
}
```

### ContentType

```ts
{
  id: number,
  slug: string,
  labelSingular: string,
  labelPlural: string,
  isBuiltin: boolean,
  isRoutable: boolean,
  urlPattern: string | null,
  icon: string,
  fieldsSchema: {
    version: number,
    fields: FieldDef[]
  },
  currentRevision: number,
  contentCount: number,
  createdAt: string,
  updatedAt: string
}
```

### FieldDef

```ts
{
  name: string,
  type: 'text' | 'textarea' | 'richtext' | 'number' | 'boolean' | 'date'
      | 'datetime' | 'email' | 'url' | 'color' | 'select' | 'multiselect'
      | 'image' | 'gallery' | 'file' | 'relation' | 'repeater' | 'json',
  label: string,
  translatable: boolean,
  required: boolean,
  validation?: {
    minLength?: number,
    maxLength?: number,
    min?: number,
    max?: number,
    pattern?: string,
    options?: string[]
  },
  admin?: {
    help?: string,
    placeholder?: string,
    hidden?: boolean
  },
  // type-specific:
  relation?: { toType: string, many: boolean, max?: number },
  repeater?: { fields: FieldDef[], min?: number, max?: number },
  richtext?: { allowCodeBlocks: boolean, allowEmbeds: boolean, allowImages: boolean }
}
```

---

## 19. Cache + ETag protocol

All cacheable GET endpoints follow this pattern:

1. Server computes deterministic ETag from response body (SHA-256, 16 hex chars).
2. Client sends `If-None-Match: "<etag>"` on subsequent requests.
3. Server returns `304 Not Modified` (empty body) if match.
4. SDK's auto-cache populates from this; webhook invalidation bypasses ETag matching for affected keys.

Surrogate-Key header lists all dep-keys for a response. Webhooks include matching dep-keys so clients can invalidate atomically.

---

## 20. Rate limiting

Per-token (authenticated) and per-IP (anonymous):

| Bucket | Limit | Window |
|---|---|---|
| Anonymous (per IP) | 60 req | 1 min |
| Authenticated (per token) | 600 req | 1 min |
| `/auth/login` (per IP+email) | 5 | 1 min |
| `/forms/*/submit` (per IP) | 5 | 1 min |
| `/forms/*/submit` (global) | 1000 | 1 min |

429 response:
```json
{ "error": { "code": "rateLimited", "message": "...", "details": { "retryAfterS": 30 } } }
```
With `Retry-After: 30` header.

---

## 21. CORS

Configurable allowed origins per environment via `CORS_ORIGINS` env var (comma-separated). Wildcard `*` only allowed for `/api/v1/content/*` GET endpoints when site is fully public. Credentials never sent cross-origin (sessions are same-origin only).

Preflight `OPTIONS` returned for all `/api/v1/*` endpoints.

---

## 22. SDK convenience layer mapping

The `@skelpo/cms-client` SDK methods map to endpoints as follows:

| SDK call | Endpoint |
|---|---|
| `cms.content.<type>.bySlug(slug, opts)` | `GET /content/by-slug/:type/:slug` |
| `cms.content.<type>.list(opts)` | `GET /content?type=<type>&...` |
| `cms.content.byPath(path, opts)` | `GET /content/by-path/:path*` |
| `cms.menus.bySlug(slug, opts)` | `GET /menus/:slug` |
| `cms.settings.all()` | `GET /settings` |
| `cms.settings.get(key)` | `GET /settings/:key` |
| `cms.media.url(id, opts)` | `GET /media/:id/url` (or computed client-side from a public key) |
| `cms.forms.submit(slug, data)` | `POST /forms/:slug/submit` |
| `cms.search(q, opts)` | `GET /search?q=...` |
| `cms.preview(token)` | `GET /content/preview?token=...` |

SDK auto-caches all `GET` calls with ETag matching + webhook-driven invalidation when `cache: 'auto'` is configured.

---

## 23. Open questions for v1 (defer to implementation, not spec)

- **GraphQL endpoint?** — Defer. REST + SDK covers the use cases.
- **Bulk endpoints** (e.g., `POST /content/bulk-publish`) — Defer; admin can iterate.
- **WebSocket / SSE live updates** — Defer; webhooks suffice.
- **OpenAPI/Swagger generation** — Generate from this spec post-v1.
- **Multi-tenant routing** — Out of scope for v1 single-tenant binary.
- **Custom HTTP method-override on forms** — POST only.

---

**End of v1 spec.** Once we approve this, the next steps are:
1. `package.json` + `tsconfig.json` + `perry.config.json` scaffold
2. First migration (the schema in `docs/schema.md` — written next)
3. Hono app with `/healthz` and `/auth/me` (the smallest end-to-end loop)
4. Wire `@perryts/mysql`, write the migration runner, scaffold `db/content.ts`
5. Build out endpoints in spec order
