# Skelpo CMS

> A blazingly fast, opinionated, native TypeScript CMS for agencies and small businesses.
> Designed for [Perry](https://github.com/PerryTS/perry) AOT compilation. Runs on Node and Bun too.

**Status:** v0.1 feature-complete (2026-05-19). Backend + HTMX admin + `@skelpo/cms-client` + `@skelpo/site-kit` + CLI all implemented and end-to-end verified; perry.land is the proven first sample case (see `docs/perry-landing-integration.md`). Not yet committed — pending owner review.
**Owner:** Skelpo. Private until v1.0.

---

## Table of contents

- [What is Skelpo CMS](#what-is-skelpo-cms)
- [Philosophy](#philosophy)
- [Architecture](#architecture)
- [Performance budget](#performance-budget)
- [Data model](#data-model)
- [Permissions](#permissions)
- [Schema evolution](#schema-evolution)
- [Cache & invalidation](#cache--invalidation)
- [SEO & agent optimization](#seo--agent-optimization)
- [Customer frontend (the public site)](#customer-frontend-the-public-site)
- [Upgradability](#upgradability)
- [Multi-runtime support](#multi-runtime-support)
- [Feature scope](#feature-scope)
- [v0.1 deliverables](#v01-deliverables)
- [Repository layout](#repository-layout)
- [References](#references)

---

## What is Skelpo CMS

Skelpo CMS is a content management system for the kind of websites most of the web actually consists of: agency homepages, small business sites, marketing sites, documentation portals, blogs. **Not** a platform, not a SaaS, not e-commerce, not a forum — those have their own better-suited tools (e.g. [Medusa](https://medusajs.com) for commerce).

It is:

- **Headless** — backend API + admin UI only; the public website is a separate codebase owned by the customer.
- **API-first** — every admin action goes through the same REST API a mobile app or external integration would use.
- **Opinionated** — one rich-text editor, one set of field types, one set of email backends. We make the choices so the user doesn't have to.
- **Blazingly fast** — designed for Perry AOT compilation. Sub-2ms cached responses. 100K+ RPS on commodity hardware. <50ms cold start.
- **Multi-runtime** — runs on Perry (recommended), Node, or Bun. Same code, three artifacts.
- **MySQL-backed** — one database, no choice paralysis.
- **Single-tenant** — one deploy per site. No shared-state surprises. Multi-tenancy is out of scope.
- **Upgrade-safe** — the CMS binary and the customer's frontend binary upgrade independently. No file migrations. No theme merges. No `wp-content/` dance.

It is **not**:

- A page builder with drag-drop block editing (TipTap rich text is the editor)
- A theme marketplace (no themes — the customer's frontend is the theme)
- A plugin platform with arbitrary code execution (custom content types + webhooks are the extension surface)
- An e-commerce platform (use Medusa)
- A membership/subscription system
- A multi-tenant SaaS

---

## Philosophy

The opinionated stances, stated plainly. These are non-negotiable in v1; they're load-bearing for the design.

1. **MySQL only.** No "supports MySQL/Postgres/SQLite." MySQL via [`@perryts/mysql`](https://www.npmjs.com/package/@perryts/mysql) — a pure-TypeScript wire-protocol driver, zero native deps. Runs on Perry, Node, and Bun. AOT-compiles cleanly.
2. **No themes inside the CMS.** The customer's frontend is the theme. The CMS doesn't render public pages.
3. **No plugins.** Custom content types + webhooks are the only extension surface. Arbitrary code execution is a security and upgrade nightmare we explicitly avoid.
4. **TipTap rich text.** No Gutenberg blocks. No alternate editors. No raw HTML pasting (TipTap JSON only — keeps cache + render invariants safe).
5. **Meta description and image alt text are required.** Publish is blocked without them. SEO + accessibility + LLM-friendliness aren't optional.
6. **Forms have a fixed set of 11 field types.** That's all. Don't ask.
7. **Email sending is always async.** No synchronous send. Failures retry. Submissions always persist regardless of mail success.
8. **One email backend at a time.** Configure SMTP *or* Resend *or* Postmark *or* SES. No "fallback chains."
9. **Server-side analytics, no client JS.** GDPR-compliant by default (anonymized IP hashes, no cookies, no PII).
10. **Single-tenant, single-binary CMS.** One deploy per site. No multi-tenant mode.
11. **Performance is a CI gate.** The perf budget below is enforced. PRs that break it fail.
12. **The CMS admin is uniform.** Customers don't theme it. Editors get a consistent experience across all Skelpo sites.
13. **Editors never rebuild.** Content, menus, settings, forms, redirects — all changes go live via webhook+cache, no recompilation.
14. **Developers always control structure.** HTML, CSS, JS — fully owned by the customer's frontend codebase. Recompile + deploy on design changes.
15. **Native deps in core: zero.** No Sharp, no native argon2, no tree-sitter, no `node-gyp`. Image processing via imgproxy sidecar.

If you disagree with any of these, Skelpo CMS is probably not your tool. That's fine — pick one of the many other excellent CMSes.

---

## Architecture

Skelpo CMS is a **two-binary system**: a backend and a frontend. They communicate over HTTP.

```
┌──────────────────────────────────────┐    ┌──────────────────────────────────┐
│ skelpo-cms (backend)                  │    │ skelpo-site-<customer> (frontend)│
│                                       │    │                                   │
│  - REST API (/api/v1/*)               │    │ - Customer-owned codebase        │
│  - Admin UI (HTMX, /admin/*)          │◄───┤ - Full HTML/CSS/JS control       │
│  - Auth (sessions + bearer tokens)    │    │ - Their own JSX templates        │
│  - Media uploads + imgproxy signing   │    │ - Their own design system        │
│  - Forms + email + jobs               │    │ - Perry-compiled (or Node/Bun)   │
│  - Webhooks (outbound)                │───►│ - Receives webhooks for live     │
│  - Single Perry binary, ~15 MB        │    │   cache invalidation             │
└──────────────────────────────────────┘    └──────────────────────────────────┘
                  │                                          │
              MySQL                              uses @skelpo/cms-client
              media (S3/local + imgproxy)              and @skelpo/site-kit
```

### What the CMS binary does

- Serves the REST API on `/api/v1/*` — content, types, media, users, menus, forms, settings, webhooks, search, analytics
- Serves the HTMX admin UI on `/admin/*` — uniform across all Skelpo sites
- Handles authentication (sessions for browser, bearer tokens for SDK/mobile)
- Runs background jobs (publish scheduled content, send emails, fire webhooks, regen sitemaps)
- Validates all writes; enforces required SEO/accessibility fields at publish time
- Never renders public-facing HTML

### What the customer's frontend does

- Renders **every public page** with full HTML/CSS/JS control
- Calls the CMS API via `@skelpo/cms-client` to fetch content, menus, settings
- Handles its own caching (the SDK provides this)
- Receives webhook notifications from the CMS on content changes → invalidates cache → next visitor sees fresh data
- Implements public routes (catchall pattern resolves any content URL → API → template)
- Owned and deployed by the customer; recompiled when design changes

### Three published artifacts per release

| Artifact | Format | Target use |
|---|---|---|
| **Perry binary** | Single executable (~15 MB) | Recommended production |
| **Docker image** | `skelpo/cms:1.x.y` | Container deploys |
| **npm package** | `@skelpo/cms` (CJS+ESM) | Users on Node/Bun who want their existing runtime |

Same source code produces all three.

---

## Performance budget

These are CI-gated. PRs that break them fail. Numbers are on Perry; Node/Bun are slower but still beat WordPress and Strapi.

| Metric | Target (Perry) | Target (Bun) | Target (Node) |
|---|---|---|---|
| Binary / package size | <20 MB | <50 MB | <100 MB |
| Cold start | <50 ms | <200 ms | <800 ms |
| Cached page TTFB (p99 local) | <2 ms | <5 ms | <10 ms |
| Uncached page TTFB (p99 local) | <10 ms | <30 ms | <60 ms |
| Memory idle RSS | <50 MB | <100 MB | <200 MB |
| Cached RPS (single instance) | 100K+ | 30-50K | 10-20K |
| DB queries per cached request | **0** | 0 | 0 |
| DB queries per uncached page | ≤3 | ≤3 | ≤3 |
| Cache hit ratio (public traffic) | >95% | >95% | >95% |

### How we hit these numbers

- **Render at write, not at read.** Published content is rendered into a compressed HTML buffer on publish; cached buffer is what's served on read.
- **Compiled JSX templates.** No template engine, no AST walking per request. (Customer's site benefits the same way via Perry compilation.)
- **Brotli pre-compressed cache.** Cached buffer is already wire bytes; `write(2)` directly to socket.
- **Zero allocations on cache hit.** Return a pointer to the cached buffer.
- **Native syscalls.** `sendfile(2)` for static assets and cached HTML; `splice`-style zero-copy where possible (on Perry).
- **In-process cache with surgical dependency graph.** No Redis required for single-tenant deploys.
- **Single-binary horizontal scaling.** <50ms cold start means autoscale-from-zero is real.
- **One indexed query per content fetch.** Custom fields in a JSON column; relations fetched in one second query if `?include=` is used.

### Comparison vs. existing CMSes (target)

| | WordPress | Strapi 5 | Directus | Payload v3 | **Skelpo (Perry)** |
|---|---|---|---|---|---|
| Cold start | ~500 ms | ~2000 ms | ~3000 ms | ~3000 ms | **<50 ms** |
| RPS (cached) | ~500 | ~5K | ~5K | ~5K | **>100K** |
| RPS (uncached) | ~50 | ~1K | ~1K | ~1K | **>10K** |
| Memory idle | 100MB×N workers | ~300 MB | ~400 MB | ~500 MB | **<50 MB** |
| Native deps | PHP + ext | Node + 1000 npm | Node + 800 npm + Sharp | Node + Next + 1500 npm | **just imgproxy** |
| Static export built-in | No | No | No | No | **Yes** |

---

## Data model

The full SQL schema lives at [`docs/schema.md`](docs/schema.md) (next deliverable). High-level overview:

### Core tables

- **`contentTypes`** — type definitions including the JSON `fieldsSchema`
- **`contentTypeRevisions`** — schema history, enables lazy migration
- **`content`** — every piece of content (built-in types + custom), with JSON `fields`, `seo`, `ai` columns
- **`contentRelations`** — many-to-many relation links
- **`contentRevisions`** — content edit history per row

### Auth & permissions

- **`users`** — with bcryptjs password hashes + optional TOTP
- **`roles`** — capability bundles (JSON)
- **`sessions`** — DB-backed sessions for admin browser

### Operations

- **`media`** — uploaded files (alt text per locale, focal points)
- **`menus`** + **`menuItems`** — drag-drop-buildable in admin
- **`settings`** — flat key-value store (`site.name`, `seo.organizationSchema`, etc.)
- **`redirects`** — 301/302 management (critical for SEO when URLs change)
- **`emailTemplates`** — editable templates with variable interpolation
- **`formSubmissions`** — every form submission persists, regardless of email success
- **`jobs`** — DB-backed background queue (sendEmail, preRender, webhookDispatch, regenSitemap, etc.)
- **`webhooks`** + **`webhookDeliveries`** — outbound webhook config + audit log
- **`analyticsEvents`** — server-side pageviews, partitioned monthly, GDPR-safe (no PII)
- **`auditLog`** — who did what when

### Field types in the ACF-style schema

Stored in `contentTypes.fieldsSchema` as JSON. Field types in v1:

`text, textarea, richtext, number, boolean, date, datetime, email, url, color, select, multiselect, image, gallery, file, relation, repeater, json`

Each field declares `name`, `type`, `label`, `translatable`, `required`, `validation`, and an optional `admin` block for editor hints.

---

## Permissions

Role-based with per-content-type granularity. A user has one role; a role has a JSON capability bundle:

```json
{
  "global": ["manageUsers", "manageRoles", "viewAnalytics"],
  "types": {
    "page":    ["read", "create", "update", "delete", "publish", "readDrafts"],
    "post":    ["read", "create", "update", "delete", "publish", "readDrafts"],
    "service": ["read", "create", "updateOwn", "deleteOwn"],
    "*":       ["read"]
  }
}
```

**Per-type capabilities:** `read, create, update, updateOwn, delete, deleteOwn, publish, readDrafts, readOthersDrafts`.

**Global capabilities:** `manageUsers, manageRoles, manageTypes, manageSettings, manageMenus, manageRedirects, manageMedia, manageForms, viewAnalytics, viewAuditLog, exportData, manageJobs`.

**Built-in roles seeded at install:**

- `admin` — everything
- `editor` — full content CRUD + publish on all types; no user/role/settings management
- `author` — CRU + publish on own posts; read on pages
- `contributor` — CRU + `updateOwn` on assigned types; no publish (sends to review)
- `viewer` — read-only admin

The single `can(user, action, type?, ownerId?)` function gates every admin/API action. Per-request memoized.

---

## Schema evolution

Adding fields to a content type without downtime, without batch-updating all existing rows. The mechanism: **versioned schemas + lazy migration on read**.

- Each content type has a `currentRevision` integer
- Every schema change creates a row in `contentTypeRevisions` with the new `fieldsSchema` and a `changes` JSON describing the diff (`added`, `removed`, `renamed`, `retyped`)
- Every `content` row stores the `schemaRevision` it was saved against
- On read, if `content.schemaRevision < type.currentRevision`, walk revisions forward and apply changes to the `fields` JSON in memory
- On next save, the migrated state is persisted; `schemaRevision` is bumped

**Operation safety:**

- Add optional field → silent; existing rows get default on read
- Add required field → modal asks for default value OR "mark existing as needs-review (block re-publish)" OR cancel
- Remove field → data preserved in `_legacy` namespace; 30-day grace before hard purge
- Rename field → silent if same type; auto-copy
- Change type → explicit transform required; rows that fail conversion flagged

**Cache invalidation:** schema-revision bump invalidates `type-list:<slug>:*` and all `content:*` of that type; admin can dry-run to see affected rows first.

---

## Cache & invalidation

The core perf strategy. The cache is not a plugin — it's the primary code path.

### Two in-memory structures

```
cache:  Map<cacheKey, CacheEntry>          // LRU-bounded
deps:   Map<depKey, Set<cacheKey>>          // reverse index for invalidation
```

`cacheKey` = canonical request signature, e.g. `GET:/en/about:guest`.
`depKey` examples: `content:42`, `type-list:post:en`, `setting:site.name`, `menu:main`.

### Render path

1. Request → compute cache key → cache hit? Yes: return cached buffer.
2. Miss → resolve route → fetch content + relations (≤3 queries) → render JSX → record dep-keys → compress (brotli) → store → return.
3. Subsequent identical requests hit cache (target <2ms TTFB).

### Invalidation

On content publish/update/delete, on menu change, on setting change, on schema change:

1. Compute affected `depKey`s
2. Look up reverse-deps → set of `cacheKey`s
3. Delete those cache entries + their reverse-index entries
4. (Optional) Pre-render hot pages on background thread
5. Fire webhook with same `depKeys` so customer's frontend invalidates *its* cache the same way

### CDN integration

Surrogate-Key headers carry the same `depKeys` so Fastly/Cloudflare can do surgical purges with the same vocabulary. No invalidation drift between layers.

---

## SEO & agent optimization

We enforce SEO data quality at the API layer and provide ready-made markup helpers in `@skelpo/site-kit`. The split:

### Enforced in `skelpo-cms` (data quality)

Required to publish — the publish endpoint returns `validationError` listing all failures on one response:

1. `seo.metaDescription` present, 70-160 chars
2. `title` ≤ 60 chars (warn 60-70, block at 70+)
3. Every image in rich text content has `altText` set for the published locale
4. Hero/OG image is present (auto-uses first content image as fallback)
5. Slug is URL-safe + ≤ 75 chars
6. Canonical URL points to self unless explicitly overridden
7. No two published rows share `(type, slug, locale)`

### Provided in `@skelpo/site-kit` (markup helpers, opt-in)

Components the customer's frontend can drop in to get the SEO contract:

- `<Head content={x} site={settings} locale={l} />` — emits title, meta description, canonical, hreflang alternates, OG, Twitter Card
- `<JsonLd type="Article" content={x} />` — emits schema.org JSON-LD per content type
- `<Image src={mediaId} alt={...} sizes={...} priority />` — emits `<picture>` with srcset, AVIF/WebP/JPEG sources, correct width/height/loading/fetchpriority
- `<Form name="contact" />` — renders form from CMS definition; POSTs to `/api/v1/forms/contact/submit`
- `Sitemap.respond({ cms })` — generates `sitemap.xml` route handler
- `Robots.respond({ settings })` — generates `robots.txt`
- `Llms.respond({ cms })` — generates `llms.txt` from per-content `ai.summary` fields
- `Feed.respond({ cms, type: 'post' })` — generates RSS/Atom

If the customer uses these defaults, they get the same SEO output the original "one binary" design would have produced. They can replace any of them without losing the data-layer guarantees.

### Schema.org types per content type

| Content type | Default schema.org type |
|---|---|
| Page | `WebPage` |
| Post | `Article` / `BlogPosting` |
| Doc | `TechArticle` |
| Service (custom) | `Service` |
| Person (custom) | `Person` |
| Event (custom) | `Event` |
| Product (custom) | `Product` |
| Home page | `WebSite` + `Organization` always present |

Overridable per content row via `seo.schemaType`.

---

## Customer frontend (the public site)

The customer's site is a **separate Perry codebase** (or Node/Bun) that:

- Has its own git repo (`skelpo-site-<customer>`)
- Owns all HTML, CSS, JS, layout, design
- Uses `@skelpo/cms-client` to call the CMS API
- Uses `@skelpo/site-kit` (optional) for SEO helpers
- Receives webhooks from the CMS on content changes
- Is recompiled and redeployed by developers when templates change
- Is **not** rebuilt when editors change content/menus/settings — those update live

### Catchall routing pattern

The customer's frontend has one catchall route:

```tsx
// src/routes/[...path].tsx
import { cms } from './lib/cms'
import { PageTemplate, PostTemplate, DocTemplate, DefaultTemplate } from './templates'

export default async function CatchallRoute({ path, locale }) {
  const resolved = await cms.content.byPath(path.join('/'), { locale })
  if (resolved.redirect) return Response.redirect(resolved.redirect.to, resolved.redirect.status)
  if (!resolved.content) return notFound()

  switch (resolved.content.type) {
    case 'page':    return <PageTemplate    content={resolved.content} />
    case 'post':    return <PostTemplate    content={resolved.content} />
    case 'doc':     return <DocTemplate     content={resolved.content} />
    default:        return <DefaultTemplate content={resolved.content} />
  }
}
```

Adding a page in admin = new content row → catchall resolves → template renders → live. No rebuild.

### Webhook handler (one line of wiring)

```ts
import { createClient, webhookHandler } from '@skelpo/cms-client'

const cms = createClient({
  url: process.env.CMS_URL,
  token: process.env.CMS_TOKEN,
  cache: 'auto',
  webhookSecret: process.env.WEBHOOK_SECRET
})

app.post('/webhook/cms', webhookHandler(cms))
```

That's it. Cache invalidation is wired up; content changes propagate in ~100-500ms.

### Live vs. rebuild — the divide

| Change | Live (no rebuild) | Requires rebuild |
|---|---|---|
| Page text, title, body | ✅ | |
| Menu items, order, nesting | ✅ | |
| New pages, new posts | ✅ | |
| Redirects | ✅ | |
| Settings (site name, social, contact) | ✅ | |
| Forms (fields, success message) | ✅ | |
| Media uploads, logo change | ✅ | |
| New custom content type fields | ✅ (visible in admin instantly; on site if template references) | |
| HTML structure / layout | | ✅ |
| CSS / colors / fonts | | ✅ |
| New page templates / routes | | ✅ |
| Brand-new content type with dedicated rendering | (admin: live) | (frontend: yes, add case branch) |

---

## Upgradability

Two release cycles, fully decoupled.

### Upgrading the CMS

```bash
# Docker
docker pull skelpo/cms:1.2.3 && docker compose up -d

# Bare binary
curl -L https://releases.skelpo.com/cms/1.2.3/skelpo-cms-linux-x64 -o skelpo-cms.new
mv skelpo-cms.new skelpo-cms && systemctl restart skelpo-cms
```

On first boot of new version:

1. Run pending migrations from `migrations/*.sql` (tracked in `migrations` table; idempotent)
2. Reconcile built-in content types (schema evolution applied via revision system)
3. Reconcile built-in roles + capabilities (new caps added, never overwrites custom)
4. Reconcile built-in email templates (only seeds missing ones — user edits preserved)
5. Reconcile default settings (only seeds missing keys)
6. Bump static asset version stamp
7. Boot HTTP server

Whole sequence is <500ms on warm DB. Behind a load balancer with two instances: zero downtime.

### Upgrading the customer's frontend

```bash
# In the customer's site repo
git pull && npm ci && perry build && deploy
```

This is the customer's release cycle, on the customer's schedule. The CMS doesn't care.

### Semver contract

- **Patch (1.2.x):** bug + perf + security. Always safe.
- **Minor (1.x.0):** new features, additive only at the DB/API level. Schema evolution keeps old content readable. Always backwards-compatible.
- **Major (x.0.0):** may change `@skelpo/cms-client` or `@skelpo/site-kit` API. Migration guide published. Shipped ~yearly.

The CMS REST API has its own version path (`/api/v1`); breaking API changes bump to `/api/v2` with the old version supported alongside for a deprecation window.

### No files to manage

The deployment is:

```
/srv/skelpo/
├── skelpo-cms        ← the binary (upgrade target)
├── .env              ← config (rarely changed)
└── uploads/          ← media (if local storage; alternatively S3)
```

- **DB stays put** during upgrades — never touched
- **Media stays put** — never touched
- **No `wp-content/` to merge**
- **No theme files to back up**
- **No plugins to update**

Backup: `skelpo-cms backup > site.skelpo-backup` produces a single file (DB dump + media tarball). Restore: `skelpo-cms restore site.skelpo-backup`. Done.

---

## Multi-runtime support

Designed for Perry. Supported on Node 22+ and Bun 1.2+ — same source code, three artifacts.

### What works the same on all three

- Hono HTTP framework
- `@perryts/mysql` (pure-TS wire-protocol driver, zero native deps; runs on Perry/Node/Bun)
- `node:fs/promises`, `node:zlib` (brotli/gzip)
- Web APIs: `fetch`, `Request`, `Response`, `URL`, `Headers`, `crypto.subtle`, `crypto.getRandomValues`, `TextEncoder`, `TextDecoder`, `ReadableStream`
- bcryptjs (pure JS) for password hashing
- Shiki (pure JS) for syntax highlighting
- TipTap JSON → HTML renderer (pure TS)
- Pure-TS SMTP client; HTTP-based clients for Resend/Postmark/SES

### What needs runtime detection (the small platform layer)

- **HTTP server boot** — entry point detects Perry/Bun/Node and uses the appropriate Hono adapter
- **Static asset embedding** — Perry can embed via compile-time include; Node/Bun load from `dist/static/` at boot
- **Background workers (future)** — `perry/thread` on Perry, `node:worker_threads` on Node/Bun. V1 uses in-process polling on all three.

The platform-specific surface is ~5 small files. Everywhere else is standard TypeScript.

### What we explicitly avoid

- ❌ `sharp` (native C++) — use imgproxy sidecar
- ❌ Native bindings (`@node-rs/*`, `node-gyp`-required packages)
- ❌ `node:child_process` — use HTTP services
- ❌ `node:cluster` — use external process manager
- ❌ `require()` (ESM only)
- ❌ `__dirname`, `__filename` (use `import.meta.url`)
- ❌ Tree-sitter native bindings (use Shiki)
- ❌ Native `argon2` (use bcryptjs)

### CI matrix

```yaml
strategy:
  matrix:
    runtime: [perry, bun-1.2, node-22, node-24]
```

Same test suite runs against all four. PRs need green on all to merge.

---

## Feature scope

### Tier 1 — ships in v0.1 (the curated set)

**Content & publishing**

- Built-in types: `Page`, `Post`, `Media`, `User`, `Role`, `Menu`, `Setting`, `Form`, `FormSubmission`, `EmailTemplate`, `Redirect`
- Custom content types (ACF-style field schema)
- Drafts + scheduled publish
- Preview URLs (signed-token)
- Revision history with one-click rollback
- Bulk actions (status change, delete)
- TipTap rich text (no raw HTML pasting)

**Forms & email**

- Built-in forms pre-seeded: Contact, Newsletter signup, Quote request
- 11 fixed field types: `text, email, phone, textarea, checkbox, radio, select, multiselect, file, hidden, consent`
- Submissions persist regardless of email success
- Spam protection: honeypot + timing check + per-IP rate limit
- Async email via SMTP / Resend / Postmark / SES
- Editable email templates with variable interpolation + i18n

**SEO & agent**

- Mandatory `metaDescription` and image `altText` at publish
- Auto sitemap, robots, llms.txt, RSS/Atom (via site-kit helpers)
- Auto schema.org JSON-LD per content type (via site-kit)
- OpenGraph + Twitter Card meta
- 301/302 redirect management
- Canonical + hreflang for i18n

**Admin**

- HTMX-based admin UI (server-rendered, no SPA build)
- First-run wizard (admin user, site name, locale, branding)
- 2FA (TOTP)
- Brute-force protection / rate limiting
- Password reset via email
- Activity log / audit trail
- Maintenance mode toggle

**Media**

- Upload + organize (alt text required, focal point)
- imgproxy-backed transforms with signed URLs
- oEmbed for YouTube/Vimeo/Twitter (cached at publish)

**Operations**

- CLI (`skelpo-cms user create`, `export`, `import`, `migrate`, `backup`, `restore`)
- `/healthz`, `/readyz`, `/metrics` (Prometheus)
- Structured JSON logs
- Single-file backup + restore
- Custom 404/500 pages (content type)

**Performance & cache**

- In-memory cache with dependency graph
- Brotli pre-compression
- Surrogate-Key headers for CDN integration
- Static export mode (`skelpo-cms export --out dist/`)

**i18n**

- Row-per-locale model with `translationGroupId`
- Per-locale slugs (`/de/ueber-uns`, `/en/about-us`)
- Default-locale fallback
- Admin UI translated via Crowdin

**Search**

- Site-wide MySQL FTS indexed at publish

**Analytics**

- Server-side pageview tracking, no client JS
- Admin dashboard: top pages, referrers, timeseries
- GDPR-safe by design

**Webhooks**

- Outbound webhooks with HMAC signing
- Configurable events: `content.published`, `content.updated`, `menu.updated`, `setting.changed`, `form.submitted`, etc.
- Delivery audit log with retry

**SDK**

- `@skelpo/cms-client` — typed REST client with auto-cache + webhook handler
- `@skelpo/site-kit` — opt-in SEO helpers (Head, JsonLd, Image, Form, Sitemap, Robots, Llms, Feed)
- `skelpo-cms types-codegen` — emits typed bindings from current schema

### Tier 2 — v0.2+

- Newsletter campaigns (compose + send to list)
- Per-post comments (opt-in per content type)
- Auto OG image generation (server-side composition)
- Search backend swap (Meilisearch / Tantivy)
- Multi-step forms
- Per-content access control (member-only pages)
- IndieAuth / WebMentions
- Calendar/events as first-class type
- Block-based page builder

### Tier 3 — hard no, out of scope

- E-commerce (use Medusa)
- Memberships / paid subscriptions
- Forums, LMS, wiki, CRM
- Plugins with arbitrary code execution (use webhooks)
- Custom themes (frontend is the theme)
- Headless-only mode (it already is headless)
- Multi-tenant SaaS mode

---

## v0.1 deliverables

Concrete list, in build order:

1. **Scaffold** the `skelpo/cms` repo: `package.json`, `tsconfig.json`, `perry.config.json`, `.gitignore`, CI workflow.
2. **Schema migration runner** + first migration (the full schema from `docs/schema.md`).
3. **Boot loop**: Hono app, MySQL pool, `/healthz`, `/readyz`, structured logs.
4. **Auth**: sessions + tokens, bcryptjs password hashing, login/logout/me, brute-force rate limit.
5. **Content read API**: `GET /content`, `by-id`, `by-slug`, `by-path` with `include` expansion.
6. **Content write API**: POST/PATCH/DELETE/publish/schedule/revert.
7. **Content types API**: CRUD + schema revisions + lazy migration.
8. **Cache layer**: in-memory LRU + dep graph + ETag + Surrogate-Key emission.
9. **Media**: upload, imgproxy URL signing, alt text enforcement.
10. **Menus, Settings, Redirects, Roles, Users**.
11. **Forms** + form submissions + email backends (start with Resend).
12. **Jobs queue** (DB-backed polling worker).
13. **Webhooks** outbound + HMAC signing + delivery log.
14. **Admin UI** (HTMX) for: login, dashboard, content list/edit, types, menus, settings, users, forms, media, redirects, jobs, audit.
15. **First-run wizard**.
16. **`@skelpo/cms-client`** SDK + auto-cache + webhook handler + types-codegen.
17. **`@skelpo/site-kit`** Head, JsonLd, Image, Form, Sitemap, Robots, Llms, Feed.
18. **`skelpo-cms init`** CLI → generates starter site repo.
19. **Static export mode** (`skelpo-cms export`).
20. **Analytics ingest + dashboard**.
21. **CLI**: backup, restore, user-create, migrate, export, import.
22. **CI matrix**: Perry + Node + Bun.
23. **Three distribution artifacts**: Perry binary, Docker image, npm package.
24. **perry.land** built on Skelpo CMS as proof-of-concept.

---

## Repository layout

The planned source tree (subject to refinement as code lands):

```
skelpo-cms/
├── README.md                  ← this file
├── docs/
│   ├── api-spec.md            ← REST API contract (v1)
│   ├── schema.md              ← full SQL schema
│   ├── architecture.md        ← deeper architecture notes
│   └── ops.md                 ← deployment / backup / restore
├── migrations/                ← *.sql files, applied in order
├── src/
│   ├── server.ts              ← entry, runtime detection
│   ├── config.ts              ← env → typed config
│   ├── app.ts                 ← Hono root app
│   ├── routes/
│   │   ├── api/
│   │   │   ├── content.ts | types.ts | media.ts | users.ts | roles.ts
│   │   │   ├── menus.ts | settings.ts | forms.ts | redirects.ts
│   │   │   ├── webhooks.ts | search.ts | analytics.ts | auth.ts
│   │   │   ├── jobs.ts | audit.ts | schema.ts
│   │   ├── admin/
│   │   │   ├── routes.ts
│   │   │   └── views/         ← JSX server-rendered fragments
│   │   ├── healthz.ts | metrics.ts | preview.ts
│   ├── db/
│   │   ├── client.ts          ← @perryts/mysql pool
│   │   ├── content.ts | users.ts | roles.ts | media.ts | jobs.ts | …
│   │   └── migrate.ts
│   ├── cache/
│   │   ├── lru.ts | deps.ts | invalidate.ts | persist.ts
│   ├── render/
│   │   ├── richtext.tsx       ← TipTap JSON → HTML
│   │   ├── highlight.ts       ← Shiki at publish time
│   ├── auth/
│   │   ├── session.ts | totp.ts | password.ts | ratelimit.ts | tokens.ts
│   ├── permissions/check.ts
│   ├── forms/
│   ├── email/
│   │   ├── adapter.ts | smtp.ts | resend.ts | postmark.ts | ses.ts
│   ├── jobs/
│   │   ├── queue.ts | worker.ts | kinds/
│   ├── media/
│   │   ├── upload.ts | imgproxy.ts | storage/local.ts | storage/s3.ts
│   ├── search/
│   ├── analytics/
│   ├── webhooks/
│   ├── cli/
│   │   └── main.ts            ← `skelpo-cms <subcommand>`
│   └── platform/              ← runtime-specific shims
│       ├── serve.ts | assets.ts | worker.ts
├── packages/
│   ├── cms-client/            ← @skelpo/cms-client (SDK)
│   └── site-kit/              ← @skelpo/site-kit (helpers)
├── starter/                   ← `skelpo-cms init` copies this
├── tests/
├── docker/
│   └── Dockerfile
├── .github/workflows/
├── package.json
├── tsconfig.json
└── perry.config.json
```

---

## Testing

`node:test` via `tsx` — zero extra test deps, runs on Node/Bun/Perry.

```bash
npm run test:unit          # pure logic, no DB — runs anywhere (47 tests)
npm run test:integration   # full API + admin UI vs a MySQL test DB (34 tests)
npm test                   # both — 81 total
```

- **Unit** (`tests/unit/`): permissions, cache (LRU + dep-graph + ETag),
  datetime normalization, password hashing, content-writer validation,
  all of `@skelpo/site-kit`, and the `@skelpo/cms-client` cache/client.
- **Integration** (`tests/integration/`): `api.test.ts` — auth/ratelimit,
  content CRUD + publish + SEO-gate + cache + 304, schema evolution,
  menus/settings/redirects, users/roles, form spam, media
  alt-enforcement, webhook dispatch, full backup→wipe→restore
  FK-integrity round-trip. `admin.test.ts` — the HTMX admin: auth gate,
  login/logout, dashboard, content editor (create/publish/SEO-gate/
  delete), and every secondary screen incl. their form posts. Each file
  resets the DB + boots a server; run serially. Auto-skips when no MySQL.
  (The perry-landing scripts are thin glue over the SDK + site-kit, both
  exhaustively covered by the suites above.)
- CI: `.github/workflows/test.yml` — Node 22 & 24, MySQL 8 service,
  typecheck (all 3 packages) + unit + integration.

The suite has already caught and fixed three real bugs: an `updateOwn`
authorization bypass, a `TRUNCATE`-on-FK-referenced-table restore failure,
and an empty-JSON-string restore crash.

---

## References

- **`docs/api-spec.md`** — REST API specification (v1)
- **`docs/schema.md`** — full SQL schema (to be written next)
- [Perry](https://github.com/PerryTS/perry) — the native TypeScript compiler this is designed for
- [Hono](https://hono.dev) — the HTTP framework
- [@perryts/mysql](https://www.npmjs.com/package/@perryts/mysql) — the MySQL driver (pure-TS wire protocol)
- [TipTap](https://tiptap.dev) — the rich text editor
- [HTMX](https://htmx.org) — the admin UI mechanism
- [imgproxy](https://imgproxy.net) — image transforms sidecar
- [Shiki](https://shiki.style) — syntax highlighting

---

**Next step:** approve this plan, then start scaffolding the `skelpo-cms` package + first migration.
