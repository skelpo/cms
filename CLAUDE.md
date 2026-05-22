# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo. Keep it
concise — it's loaded into context on every session. Detail belongs in
`docs/` or the relevant source file, not here.

## Project Overview

Skelpo CMS — an opinionated, headless CMS written in TypeScript. MIT,
`github.com/skelpo/cms`. Runs on **Node**, **Bun**, or **Perry** (the
native-TypeScript AOT compiler) from the same source. Hono + JSX + HTMX
admin, MySQL via `@perryts/mysql`, in-process cache with a dependency
graph (no Redis for single-tenant).

Its first real customer site is **perry.land** (the Perry marketing
site), served by a separate repo — see "Customer site" below.

## Build / Run / Test

```bash
npm ci --include-workspace-root --workspaces   # install (see CI pitfall below)
npm run dev            # tsx watch src/server.ts
npm run start          # node dist/server.js (after `npm run build`)
npm run build          # tsc -p tsconfig.json
npm run typecheck      # tsc --noEmit
npm run migrate        # tsx src/cli/main.ts migrate
npm run test           # unit + integration
npm run test:unit      # node --test tests/unit/*.test.ts (no DB)
npm run test:integration   # node --test tests/integration/*.test.ts (needs MySQL)
```

Default port 3000 (`PORT`/`HOST` env; local dev/bench often uses 3137).
DB + secrets via `.env`
(`.env.example` lists every key). Integration tests need a MySQL at
`DB_*`; CI spins up `mysql:8.4` as a service container.

The CLI ships as the `skelpo-cms` bin (`dist/cli/main.js`). It mirrors
the HTTP API — **everything manageable via API must also be manageable
via CLI** (`src/cli/`, `src/routes/api/`). Keep them in lockstep.

## Architecture

```
HTTP → Hono (src/app.ts) → routes → cache (dep-graph) → DB (@perryts/mysql)
                              ↑ admin UI (HTMX+JSX) and /api/v1 share the same writers
```

| Path | Purpose |
|------|---------|
| `src/server.ts` | Boot: migrate-check, build app, bind listener |
| `src/app.ts` | Hono app assembly + middleware order |
| `src/routes/api/` | `/api/v1` REST surface (content, settings, menus, media, forms, users, roles, redirects, webhooks, jobs, auth, types) |
| `src/admin/` | Server-rendered admin (layout/screens/routes/contentEditor). HTMX, no SPA |
| `src/content/` | Content read/write, content-type defs, schema evolution (lazy migration) |
| `src/cache/` | LRU + dependency-graph invalidation + ETag + respond helpers |
| `src/auth/` | Sessions (DB-backed), password (bcryptjs), TOTP tokens, rate-limit, users |
| `src/permissions/check.ts` | Capability checks (see Permissions below) |
| `src/media/` | Storage-agnostic uploads: `storage.ts` (interface) + `local.ts` + `s3.ts`; `imgproxy.ts` for transforms |
| `src/menus/`, `src/settings/` | Admin-editable site chrome + flat key-value settings |
| `src/jobs/` | DB-backed background queue (sendEmail, preRender, webhookDispatch, regenSitemap…) |
| `src/db/` | `client.ts` (pool), `migrate.ts`, `seed.ts`, `datetime.ts` |
| `src/cli/` | CLI commands + HTTP-API client (`api.ts`) |
| `migrations/` | Numbered SQL (`0001_initial.sql` …) |
| `packages/cms-client`, `packages/site-kit` | Published npm packages (see below) |

Full SQL schema: `docs/schema.md`. API surface: `docs/api-spec.md`.

## Published packages + release flow

Two npm packages live in `packages/` (npm **workspaces**):

- **`@skelpo/cms-client`** — typed HTTP client (fetch content/settings/
  menus, submit forms, verify webhooks). Currently `0.1.3`.
- **`@skelpo/site-kit`** — SEO/sitemap/RSS/llms.txt + `renderMarkdown`/
  `renderTipTap`. Currently `0.1.2`.

Both are MIT, ESM-only (`"type": "module"`), and publish via **npm
Trusted Publisher (OIDC)** through a tag-triggered GitHub Actions
workflow with `--provenance`. Tag policies: `cms-client@v*`,
`site-kit@v*`. The workflow uses **Node 24** (npm 11.x — npm 10 lacks
OIDC) and must NOT set `setup-node`'s `registry-url` (it writes a
token-based `.npmrc` that contradicts OIDC). There's a `skelpo-release`
Claude Code skill that automates a version bump + tag + release.

## Hard-won pitfalls (read before touching CI or deps)

### npm workspaces install — never run nested `npm ci`
CI install MUST be a single `npm ci --include-workspace-root --workspaces`.
Running `npm ci` at root **then** `(cd packages/X && npm ci)` makes npm
**prune the root `node_modules` down to that workspace's deps** — hono,
fastify, bcryptjs, `@perryts/mysql` all vanish, and the next `tsc`
fails with `Cannot find module 'hono'` across every JSX file. This kept
`main` red for days; fixed in `.github/workflows/test.yml`.

### Node 22 strict ESM
Node 22's ESM loader is stricter than 24/25. Any dependency we control
must ship `"type": "module"` **and** `.js` extensions on relative
imports in its compiled output, or `import { x } from 'pkg'` throws
`does not provide an export named 'x'`. This bit:
- `@skelpo/cms-client` / `@skelpo/site-kit` → fixed by adding `type:module`.
- `@perryts/mysql` → fixed in **0.1.4**: added `type:module` + a
  post-build pass (`scripts/fix-esm-imports.mjs` in the `PerryTS/mysql`
  repo) that rewrites `dist` imports to `./foo.js`. Pin `^0.1.4`+.

CI matrix is Node `['22','24']` — keep both green. Local Mac is Node 25
and is more lenient, so **a clean pass locally does not prove Node 22**.

## Admin UX rules

- **No JSON, ever, in the admin.** It's for non-technical editors.
  Settings/repeaters/trees get shape-detected field editors, never a
  raw JSON textarea. This is a durable product constraint.
- The admin look is **not themeable** by customers — one uniform UI.
  Light/dark toggle is the only user-facing chrome choice (persisted).
- Sidebar is capability-gated (EDITORIAL vs DEVELOPER groups). Content
  types appear directly in the sidebar (not behind a `/admin/types`
  page-not-found). Don't surface actions a role can't perform (e.g.
  editors can't *create* forms — those need template integration).
- Markdown is the body format: EasyMDE editor vendored in admin;
  bodies stored as markdown text, rendered via `renderMarkdown`.
- Maintenance/preview mode: admin toggle → frontend serves a branded
  "we'll be right back" 503; `?preview=<token>` cookie bypasses it.

## Permissions

`src/permissions/check.ts` + `src/db/seed.ts`. Per-type caps (`read`,
`create`, `update`, `delete`, `publish`, `readDrafts`, `readOthersDrafts`,
`updateOwn`, `deleteOwn`) + global caps (`manage*`, `view*`, `exportData`,
…). Five seeded roles: **admin** (`global: ['*']`), **editor** (gains
`viewSubmissions`; form type is read/update/publish only — no create/
delete), **author**, **contributor**, **viewer** (read-only).

## Media storage

Storage-agnostic from day one. `MediaStorage` interface in
`src/media/storage.ts`; `local.ts` (filesystem) and `s3.ts` (custom
SigV4, no AWS SDK) implement it. `mediaStorage()` picks the backend
from `MEDIA_BACKEND`. imgproxy handles transforms. Add a backend by
implementing the interface — every byte path already routes through it.

## Perry-native facts

- **`Bun.serve` is not implemented in Perry** as of Perry 0.5.1019. A
  `Bun` sentinel object exists but `Bun.serve` is `undefined`, and it's
  not on `globalThis`. The CMS server's Bun-detect fallback path
  therefore does NOT yet boot natively — verify before claiming it does.
- For a Perry-native HTTP server today, use **Fastify** (Perry has a
  native Rust impl in `perry-stdlib`) — it compiles and runs cleanly.
  `node:http.createServer` compiles but the response body/headers don't
  propagate (returns `content-length: 0`); don't rely on it.
- `@skelpo/cms-client` and `@skelpo/site-kit` **lack a `"perry":
  "./src/index.ts"` exports entry** (and don't ship `src/`), so the
  customer site can't cross-compile against them yet. `@perryts/mysql`
  is the reference for the right shape (`perry` export + `src/` in
  `files`). Adding this is the open blocker for compiling perry.land.

## Customer site (separate repo)

perry.land's Perry-native rewrite lives at `~/projects/perry-landing-skelpo`
→ pushed to `PerryTS/perryts.com` branch **`perry-native`**. Hono + JSX
+ Tailwind v4, depends on the two `@skelpo/*` packages from npm.
Deployed at **beta.perryts.com** via `deploy.sh`: cross-compile on a
Linux worker (`root@84.32.98.120`, Perry 0.5.1018) → relay binary →
`root@webserver.skelpo.net` → pm2/nginx. Currently runs the
`--node-fallback` (tsx) path because the Perry compile is blocked on
the missing `perry:` exports above.

## Benchmarks

- `scripts/bench.sh local|remote|both` — CMS + customer-site end-to-end
  (autocannon); writeup in `docs/benchmarks.md`.
- `scripts/bench-twin/` — direct **Node vs Perry** head-to-head:
  identical Fastify source, two runtimes, `./bench.sh`; writeup in
  `docs/benchmarks-perry-vs-node.md`. Headlines: Perry ≈17× faster cold
  start, +20% RPS, ≈8× lower idle RSS, ≈30× smaller deployable.

## Conventions

- **No per-commit version bump, no CHANGELOG** in this repo (unlike the
  perry compiler repo). The package `version` only moves on an actual
  npm release of the workspace packages.
- `main` is the working branch; CI (`test` workflow: typecheck → unit →
  integration on Node 22 + 24) must be green. The bench/docs commits
  are docs-only and don't touch the production tree.
- `.perry-cache/` and `__perry_js_bundle.js` are Perry build scratch —
  gitignored.
