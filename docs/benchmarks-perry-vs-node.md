# Node vs Perry — direct head-to-head

The CMS bench in `benchmarks.md` measured the deployed beta — Node + tsx
in both cases. This file pins down the **runtime-vs-runtime** number:
identical source, same machine, same harness, two execution modes.

- **Node**: `npx tsx src/server.ts` (Node 25.8, tsx 4.21)
- **Perry**: `perry compile src/server.ts -o dist/bench-twin`,
  then `./dist/bench-twin` (Perry 0.5.1019)

Source: [scripts/bench-twin/src/server.ts](../scripts/bench-twin/src/server.ts).
A minimal Fastify app with five endpoints chosen to isolate different
runtime hotspots:

| Endpoint   | Exercises                                               |
|------------|---------------------------------------------------------|
| `/healthz` | Tiny JSON response — routing + serialization floor      |
| `/json`    | ~1 KB nested object — JSON.stringify of richer shapes   |
| `/loop`    | `sum(i*i)` for `i ∈ [0, 10000)` — integer arithmetic    |
| `/text`    | 14 KB text payload — buffer/string throughput           |
| `/headers` | Read header, set 2 headers, 204 — header path           |

Harness: `autocannon`, 20 s measured + 3 s warm-up. Reproduce with
`scripts/bench-twin/bench.sh` (uses 50 conns by default for the numbers
below; pass `CONNS=10 ./bench.sh` for the low-concurrency table).

## TL;DR

| Axis | Node + tsx | Perry native | Winner |
|---|---:|---:|---|
| **Cold start** (launch → /healthz 200) | **730 ms** (617–933) | **44 ms** (43–46) | Perry **≈17×** |
| **RPS** (50 conns, avg of 5 endpoints) | 54,770 | 65,476 | Perry **+20%** |
| **Best-case RPS** (/loop, CPU bound) | 49,947 | 67,197 | Perry **+35%** |
| **RSS, idle** | ≈ 86 MB | ≈ 11 MB | Perry **≈8×** |
| **RSS, after 100 s bench** | 70 MB | 78 MB | tie |
| **Distribution size** | 79 MB (Node) + 26 MB (node_modules) ≈ **105 MB** | **3.5 MB** single binary | Perry **≈30×** |

## 50 conns, 20 s, 3 s warm-up

| Endpoint | Node RPS | Perry RPS | Δ | Node avg | Perry avg | Node p99 | Perry p99 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `/healthz` | 58,522 | **65,723** | +12% | 0.17 ms | 0.15 ms | 1 ms | 1 ms |
| `/json`    | 53,498 | **65,766** | +23% | 0.21 ms | 0.16 ms | 1 ms | 1 ms |
| `/loop`    | 49,947 | **67,197** | +35% | 0.28 ms | 0.13 ms | 2 ms | 1 ms |
| `/text`    | 50,304 | **58,574** | +16% | 0.29 ms | 0.17 ms | 2 ms | 1 ms |
| `/headers` | 61,579 | **70,119** | +14% | 0.14 ms | 0.16 ms | 1 ms | 1 ms |

Perry is faster across every endpoint. Latency gap is biggest on `/loop`
(CPU-bound) where Perry's AOT codegen beats V8's JIT at small problem
sizes — `i*i` integer arithmetic in a tight loop is exactly the shape
Perry's LLVM pipeline shines on.

## 10 conns, 15 s, 3 s warm-up

(Lower concurrency, latency-sensitive view.)

| Endpoint | Node RPS | Perry RPS | Δ |
|---|---:|---:|---:|
| `/healthz` | 51,980 | **58,986** | +13% |
| `/json`    | 50,009 | **54,879** | +10% |
| `/loop`    | 47,766 | **61,339** | +28% |
| `/text`    | 46,132 | **54,239** | +18% |
| `/headers` | 59,105 | **62,759** | +6%  |

## Cold start

Per-trial wall-clock from process spawn until `/healthz` returns 200.
The Node number includes V8 boot + tsx transpiling `server.ts` on import.
The Perry number is the AOT binary booting and binding the socket.

| Trial | Node + tsx | Perry native |
|---:|---:|---:|
| 1 | 933 ms | 44 ms |
| 2 | 641 ms | 43 ms |
| 3 | 617 ms | 46 ms |
| **avg** | **730 ms** | **44 ms** |

This is the most asymmetric axis. In serverless / FaaS / CLI shapes
where each invocation pays the start cost, **Perry's 44 ms cold start
swallows the entire P99 budget Node typically eats up on its own boot**.

## Memory

| Metric | Node + tsx | Perry native |
|---|---:|---:|
| RSS, idle (post-boot) | 86 MB | **11 MB** |
| RSS, peak during bench | 86 MB | 78 MB |
| RSS, after bench (idle) | 70 MB | 78 MB |

Perry's idle footprint is **~8× lower**. Under load both runtimes climb
to similar steady-state RSS — for Node, that's V8 heap + Node core
already amortized; for Perry, the GC's tenured generation warms up as
the request stream produces allocations.

## Distribution size

| | Bytes |
|---|---:|
| `node` (CLI shim) | 68 KB |
| `libnode.141.dylib` (V8 + Node core) | 63 MB |
| Full Node install (`/opt/homebrew/Cellar/node/25.8.0`) | 79 MB |
| `node_modules` (fastify + transitive deps) | 26 MB |
| **Node total** | **~105 MB** |
| **Perry binary** (statically linked, includes fastify) | **3.5 MB** |

Perry's 3.5 MB binary ships everything: runtime, GC, Fastify, the
fixture data, and the application code, statically linked. No
`node_modules`, no dynamic library lookup, no per-invocation tsx
transpile. **Container image size, S3 bundle size for Lambda, copy-to-
host deploy time — all 30× smaller.**

## What this measures (and what it doesn't)

What this is:
- A pure runtime-vs-runtime comparison on Fastify (which Perry has a
  native Rust impl for in `perry-stdlib`).
- Identical source compiled both ways, identical workload, identical
  harness.
- A meaningful proxy for "what's the cost / benefit of switching".

What this isn't:
- A measure of the full CMS or customer site (those are in
  `benchmarks.md`). The CMS benchmark hits a DB, the customer site
  fetches and composes — those layers dominate the numbers there.
- A V8-fast-path workload. V8 JITs hot code; if the bench loop were
  ten million iterations Perry's lead would narrow because V8 catches
  up after warmup. Perry wins ahead because its baseline is already
  AOT'd — there's no warm-up to wait for.
- A complete picture for cold-path JSON: `/json` is a fixed payload
  cached in module scope. Allocating new objects per request (the
  real CMS shape) is GC-pressure-bound; that's a separate bench.

## Methodology

- Hardware: M-series Mac, Darwin 25.4.0 arm64
- Node: v25.8.0; tsx 4.21
- Perry: 0.5.1019
- Fastify: 5.7
- autocannon: v8, default keep-alive
- Per-endpoint: 3 s warm-up (silent) → 20 s measured at 50 conns
- Cold start: process spawn → first 200 from `/healthz` (poll every 10 ms)
- All on localhost — no real network in the path

Reproduce: `cd scripts/bench-twin && npm install && ./bench.sh`

## Takeaway

The CMS itself is the same code in both modes. **Switching the
customer site from Node + tsx to a Perry-native binary buys, in steady
state:**

1. **~20% more RPS** per CPU
2. **~17× faster cold starts** (44 ms vs 730 ms)
3. **~8× smaller idle memory** (11 MB vs 86 MB)
4. **~30× smaller deployable** (3.5 MB vs 105 MB)

The throughput edge is real but modest at this concurrency. The
**cold-start, memory, and deployable-size axes are the lopsided wins**
— exactly the axes that matter most for serverless/edge/CLI shapes
and for spinning up many small services on a small VM.
