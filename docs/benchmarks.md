# Skelpo CMS — Benchmarks

> **Looking for the direct Node vs Perry comparison?** See
> [benchmarks-perry-vs-node.md](./benchmarks-perry-vs-node.md) — identical
> source, two runtimes, same machine, same harness. The numbers in *this*
> file are the deployed CMS itself (Node + tsx) and are an end-to-end
> view including DB, fetch composition, and the customer site stack.

Two environments measured: local Mac (dev) + the live `beta.perryts.com`
(VPS). Both runs use **Node + tsx** (the Node-fallback path) since the
Perry-compiled native binary blocker isn't fixed yet — these are the
*lower bound* of what the CMS can do.

Tool: [autocannon](https://github.com/mcollina/autocannon) v8, 15 s per
run, 10 concurrent connections, 3 s warm-up.

Reproduce: `./scripts/bench.sh local|remote|both`.

## TL;DR

| | RPS | avg latency | p99 |
|---|---:|---:|---:|
| `/healthz` (local) | **24,428** | <1 ms | <1 ms |
| Cached API read (e.g. `/api/v1/types`) | **12,793** | <1 ms | <1 ms |
| Content list (20 rows, JSON) | **5,665** | 1.3 ms | 5 ms |
| Big content row (full markdown body) | **5,573** | 1.4 ms | 7 ms |
| Full settings dump (≈1.4 MB i18n) | 766 | 12.6 ms | 25 ms |
| Customer site home (13 sections, multi-fetch) | **1,077** | 8.8 ms | 21 ms |
| Customer site blog post (markdown render) | 1,302 | 7.2 ms | 15 ms |
| Customer site showcase/pry (rich repeater) | **3,850** | 2.1 ms | 5 ms |
| Sitemap (XML) | 17,106 | <1 ms | 1 ms |

Memory: CMS RSS ≈ **412 MB**, customer site RSS ≈ **316 MB** (both Node +
tsx; native-binary path will land both well under 50 MB).

Caveats:
- `<1ms` shows where autocannon's per-percentile histogram has 1 ms
  resolution; the `avg latency` column (with decimals) is the truthful
  number for sub-millisecond endpoints.
- Both targets serve via tsx — no minification, no native binary yet.
- The customer site does multiple CMS reads per page (header menu,
  footer menu, locale bundle, content row, settings) — the home-page
  number is the worst case for "real" pages.
- Beta server is single ~2 vCPU VPS, ~30 ms RTT from the Mac running
  the bench.

## Local — Mac (Node 25 + tsx, M-series)

### CMS API (`http://127.0.0.1:3137`)

| Endpoint | RPS | avg | p50 | p99 | max | bytes/s |
|---|---:|---:|---:|---:|---:|---:|
| `GET /healthz` | 24,428 | 0.01 ms | <1 ms | <1 ms | 37 ms | 4.6 MB/s |
| `GET /api/v1/types` | 12,793 | 0.04 ms | <1 ms | <1 ms | 17 ms | 138 MB/s |
| `GET /api/v1/menus/main?locale=en` | 22,418 | 0.02 ms | <1 ms | <1 ms | 21 ms | 27 MB/s |
| `GET /api/v1/settings/site.locales` | 22,261 | 0.02 ms | <1 ms | <1 ms | 10 ms | 9 MB/s |
| `GET /api/v1/content?type=post&locale=en&limit=20` | 5,665 | 1.30 ms | 1 ms | 5 ms | 21 ms | **1,128 MB/s** |
| `GET /api/v1/content/by-slug/post/closing-the-gc-gap` | 5,573 | 1.39 ms | 1 ms | 7 ms | 51 ms | 89 MB/s |
| `GET /api/v1/settings` (full dump, ≈1.4 MB JSON) | 766 | 12.64 ms | 11 ms | 25 ms | 67 ms | 686 MB/s |

### Customer site (`http://127.0.0.1:4200`)

| Endpoint | RPS | avg | p50 | p99 | max | bytes/s |
|---|---:|---:|---:|---:|---:|---:|
| `GET /` (13 sections, 5 CMS reads per render) | 1,077 | 8.78 ms | 8 ms | 21 ms | 72 ms | 68 MB/s |
| `GET /blog` (index, 17 posts listed) | 3,792 | 2.32 ms | 2 ms | 5 ms | 24 ms | 77 MB/s |
| `GET /blog/closing-the-gc-gap` (markdown render) | 1,302 | 7.18 ms | 6 ms | 15 ms | 42 ms | 37 MB/s |
| `GET /showcase/pry` (rich repeater render) | 3,850 | 2.12 ms | 2 ms | 5 ms | 16 ms | 62 MB/s |
| `GET /compare/bun` (compare-table render) | 3,094 | 2.73 ms | 2 ms | 8 ms | 57 ms | 57 MB/s |
| `GET /pricing` (CMS-driven tiers + 4 FAQs) | 3,352 | 2.45 ms | 2 ms | 6 ms | 16 ms | 71 MB/s |
| `GET /sitemap.xml` | 17,106 | 0.06 ms | <1 ms | 1 ms | 15 ms | 58 MB/s |

### Memory (RSS after the full run)

| Process | RSS |
|---|---:|
| `beta-cms` (Hono + tsx) | 412 MB |
| `beta-perryts` (Hono + tsx) | 316 MB |

## Remote — `https://beta.perryts.com` (Node 22 + tsx on Linux VPS)

Includes transatlantic network (~30 ms RTT), TLS handshake amortized
across keep-alive, nginx in front. Numbers are end-to-end including
those layers.

| Endpoint | RPS | avg | p50 | p99 | max |
|---|---:|---:|---:|---:|---:|
| `GET /healthz` | 284 | 35 ms | 33 ms | 59 ms | 127 ms |
| `GET /` (home) | 43 | 229 ms | 221 ms | 382 ms | 427 ms |
| `GET /blog` | 129 | 77 ms | 73 ms | 149 ms | 197 ms |
| `GET /blog/closing-the-gc-gap` | 92 | 108 ms | 103 ms | 192 ms | 825 ms |
| `GET /showcase/pry` | 150 | 66 ms | 63 ms | 123 ms | 199 ms |
| `GET /pricing` | 123 | 81 ms | 77 ms | 153 ms | 560 ms |
| `GET /sitemap.xml` | 244 | 40 ms | 39 ms | 65 ms | 142 ms |

Note: home is the worst case because the layout fetches both menus +
the locale bundle in parallel before the render starts; smaller pages
like `/showcase/pry` only need one content row + cached chrome.

## What pops out

- **Cached API reads sit at ~22 k RPS sub-millisecond** on the dev box.
  The in-memory SDK cache + dep-graph invalidation means most reads on
  steady-state hit the cache directly.
- **The full-settings dump is the obvious bottleneck** at 766 RPS — it
  serializes the entire i18n × 13 locales bundle on every call (≈1.4 MB).
  Realistic apps don't fetch all settings on every request; they pull
  the keys they need.
- **Customer-site home at 1 k RPS / 8.8 ms** is the worst-case "user
  visits the site" path: layout fetches both menus + locale bundle in
  parallel, home renders 13 sections, each section pulls its t() calls.
  Single-page render around 1 ms.
- **Customer-site rich pages** (`/showcase/pry` with 12 repeater cards
  + `/compare/bun` with a 10-row table) sit at ~3–4 k RPS / 2 ms,
  comfortably under a high-traffic blog's read pressure.
- **No errors** under any of the runs. Tail (`max`) is occasional GC
  pauses up to ~70 ms; p99 ≤ 25 ms throughout.

## Headroom remaining

These numbers are with:
1. The Node-fallback path — Perry-compiled native binary should land
   2–4× higher RPS + ~50 MB RSS (gscmaster's similar shape benchmarks
   in that range).
2. Single process (no cluster/pm2 fork mode).
3. tsx transpiling TypeScript on import — built JS would shave a bit.

So the headline numbers are conservative.

## Methodology + caveats

- `./scripts/bench.sh local|remote|both` reproduces this run.
- `DURATION=15 CONNS=10 WARMUP=3` was used here. Increasing `CONNS`
  past 10 pegs the dev-box CPU and the tail latency stops being
  meaningful for a localhost run.
- The site fetches from CMS over localhost — there's no inter-host
  network hop on the local run.
- `<1ms` indicates autocannon's integer-ms percentile bucket; the
  `avg` column has the actual sub-millisecond mean.
- This is read-throughput only. Write benchmarks (publish, content
  create) are a follow-up — different shape, different limits (MySQL
  insert + cache invalidation + webhook dispatch).
