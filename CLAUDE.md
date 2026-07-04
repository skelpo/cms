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
- **Admin is multilingual** (13 locales, mirrors perry/landing). UI strings
  live in bundled per-locale TS bags under `src/admin/i18n/messages/`
  (`en.ts` is source of truth, en is the runtime fallback); never hardcode
  user-facing chrome — use `t('key')`/`t.plural(...)` from `getT(c)`.
  Per-request locale = `users.locale` → `skelpoAdminLang` cookie →
  Accept-Language (`src/admin/i18n/middleware.ts`, mounted on `adminRoutes`).
  Users set their own language at `/admin/profile` + the sidebar switcher.
  Adding a locale = extend `i18n/locales.ts` + add a `messages/<loc>.ts`.

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

Status on **Perry 0.5.1039**: the CMS **compiles to a native binary and
boots** — migrate, seed, job worker, MySQL, and the HTTP listener bind are
all native and verified. **HTTP request handling does NOT yet work**: every
request throws `Symbol()` inside `app.fetch` and returns 500 (see the open
runtime bugs below). So "compiles + boots + listens" ✅, "serves real
responses" ❌ — not production-usable on Perry yet.

Build it with **`npm run build:perry`** (do not call `perry` directly — see
the invocation pitfall below). The old CLI subcommand was `perry build`;
it's now **`perry compile`**.

- **JS-only deps must be AOT-compiled (V8 runtime was removed).** Perry
  can no longer evaluate JS at runtime, so any npm dep shipped as compiled
  JS must be listed in **`perry.compilePackages`** (and
  `perry.allow.compilePackages`) in `package.json`. We do this for
  `hono` and `bcryptjs`. Without it: "JavaScript runtime (V8) support has
  been removed."
- **Invoke perry from its REAL path, not the `~/.cargo/bin/perry`
  symlink.** The compiler finds its workspace (and the on-demand
  "auto-optimize" step that builds + links the per-feature ext libs,
  incl. the node:http server lib `libperry_ext_http.a`) by walking up
  from `current_exe()` for `crates/perry-runtime`. Through the symlink
  that resolves to `~/.cargo/bin` → workspace not found → only
  `libperry_runtime.a` + `libperry_stdlib.a` get linked → node:http
  server symbols are unresolved → the binary dies at the HTTP bind with
  `TypeError: value is not a function`. **`PERRY_RUNTIME_DIR` does NOT
  fix this.** `scripts/build-perry.sh` resolves the symlink for us.
- **node:http server partially works.** `createServer`/`server.listen`/
  `res.end`/`res.write` (sync + async) and the listener bind all work
  natively. `IncomingMessage`: `req.method`/`req.url` work, **`req.on('data')`/
  `req.on('end')` fire** (attach them **synchronously** in the createServer
  callback — Perry fires them eagerly, so a deferred/`await`-ed registration
  misses them and hangs). The old "body/headers don't propagate" note is
  obsolete for the basics.
- **OPEN Perry runtime bugs blocking serve** (file/track upstream; all
  reproduced on 0.5.1039 in an isolated worktree build):
  1. **`req.headers` is `undefined`** on `IncomingMessage`. Workaround:
     read **`req.rawHeaders`** (flat `[k,v,k,v,…]`, populated correctly)
     and rebuild a `Headers`. `rawHeaders` is portable to Node too.
  2. **request body chunks arrive as `string`, not `Buffer`** — so
     `Buffer.concat(chunks)` throws "list[0] … must be Buffer/Uint8Array".
     Coerce each chunk (`Buffer.from(chunk)`) before concat.
  3. **THE blocker: `app.fetch` throws a bare `Symbol()` on every request**
     (even header-less `GET /healthz`, a pure `c.json`), so all routes 500.
     A trivial 1-route Hono app served through the *same* inline adapter
     works (200), and `c.json`/`c.text`/`getCookie`/`c.req.header` all work
     in isolation — so the trigger is somewhere in the CMS's full
     middleware/route graph under compilation, not yet isolated. This is
     the thing to chase next.
- **Do NOT use `@hono/node-server`** under Perry. Its `serve()` now *binds*
  (Perry #2533 fixed), but its request path throws and then crashes inside
  its own catch handler (`e.name` on an undefined caught value). `server.ts`
  should serve via an inline `node:http` adapter bridging
  `(req,res)` ⇄ `app.fetch` instead — but note that adapter is **not yet
  working end-to-end** because of bug 3 above. `@hono/node-server` is no
  longer in `perry.compilePackages`.
- **No `foo!++`** — a non-null assertion on an update expression trips
  `U006` ("Update expression only supports identifiers and member
  expressions"). Drop the `!` (or use `+= 1`).
- **`Bun.serve` is still unimplemented** (a `Bun` sentinel exists, but
  `Bun.serve` is `undefined` and not on `globalThis`) — the intended
  Perry path is node:http, not Bun.
- `@skelpo/cms-client` / `@skelpo/site-kit` still **lack a `"perry"`
  exports entry** and don't ship `src/`. With `compilePackages` a
  consumer can now compile their published JS directly, so this is no
  longer a hard blocker — but cross-compiling the customer site against
  them this way is **unverified**. `@perryts/mysql` remains the
  reference shape (`perry` export + `src/` in `files`).

## Customer site (separate repo)

perry.land's Perry-native rewrite lives at `~/projects/perry-landing-skelpo`
→ pushed to `PerryTS/perryts.com` branch **`perry-native`**. Hono + JSX
+ Tailwind v4, depends on the two `@skelpo/*` packages from npm.
Deployed at **beta.perryts.com** via `deploy.sh`: cross-compile on a
Linux worker (`root@builder.perryts.com`, Perry 0.5.1018) → relay binary →
`root@webserver.skelpo.net` → pm2/nginx. Currently runs the
`--node-fallback` (tsx) path; a native Perry compile of the customer
site hasn't been re-attempted since the CMS-side findings above
(`compilePackages` + real-binary invocation + inline node:http adapter).

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
