#!/bin/bash
# Benchmark Skelpo CMS + the perry-landing customer site.
#
# Modes:
#   ./bench.sh local    — hit http://127.0.0.1:3137 (CMS) + 127.0.0.1:4200 (site)
#   ./bench.sh remote   — hit https://beta.perryts.com (site only; CMS is internal)
#   ./bench.sh both     — runs both
#
# Per-scenario: 5s warm-up + 30s measured run @ 10 concurrent connections.
# Reports req/sec, p50/p95/p99 latency, transfer rate.
#
# Adjust DURATION / CONNS at the top.

set -euo pipefail
MODE="${1:-local}"
DURATION="${DURATION:-30}"
CONNS="${CONNS:-10}"
WARMUP="${WARMUP:-5}"

LOCAL_CMS=http://127.0.0.1:3137
LOCAL_SITE=http://127.0.0.1:4200
REMOTE_SITE=https://beta.perryts.com

# pid for local CMS RSS sampling (optional)
LOCAL_CMS_PID=$(lsof -nP -iTCP:3137 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
LOCAL_SITE_PID=$(lsof -nP -iTCP:4200 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)

rss_kb() {
  local pid=$1
  [ -z "$pid" ] && { echo "—"; return; }
  ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || echo "—"
}

# Run one scenario with warm-up + measured run.
run() {
  local label="$1"
  local url="$2"
  local extra="${3:-}"
  printf "\n▸ %-46s  %s\n" "$label" "$url"
  # Warm-up (silent)
  autocannon -d "$WARMUP" -c "$CONNS" $extra "$url" >/dev/null 2>&1 || true
  # Measured
  autocannon -d "$DURATION" -c "$CONNS" --renderStatusCodes -j $extra "$url" 2>/dev/null \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
lat = d.get('latency', {})
rps = d.get('requests', {})
thr = d.get('throughput', {})
err = d.get('non2xx', 0) + d.get('errors', 0)
def lat_fmt(v):
    # autocannon percentile buckets are integer ms. sub-ms shows as 0;
    # surface that visually rather than hide it.
    return '<1ms' if v < 1 else f'{v:.0f}ms'
avg_ms = lat.get('average', 0)
print(f\"  RPS    avg={rps.get('average', 0):>7.0f}  stddev={rps.get('stddev', 0):>5.0f}\")
print(f\"  Lat    avg={avg_ms:>5.2f}ms  p50={lat_fmt(lat.get('p50',0)):>6}  p95={lat_fmt(lat.get('p95',0)):>6}  p99={lat_fmt(lat.get('p99',0)):>6}  max={int(lat.get('max',0)):>4}ms\")
print(f\"  Bytes  avg={thr.get('average', 0)/1024/1024:>6.2f} MB/s\")
print(f\"  Errors non-2xx + errors = {err}\")
"
}

echo "Skelpo CMS benchmark · ${DURATION}s @ ${CONNS} conns · $(date)"
echo "$(uname -srm)"

if [[ "$MODE" == "local" || "$MODE" == "both" ]]; then
  echo
  echo "════════════════════════════════════════════════════════════════"
  echo "LOCAL — Node $(node --version 2>/dev/null || echo '?') + tsx"
  echo "  CMS  pid=$LOCAL_CMS_PID   RSS=$(rss_kb "$LOCAL_CMS_PID") KB"
  echo "  site pid=$LOCAL_SITE_PID  RSS=$(rss_kb "$LOCAL_SITE_PID") KB"
  echo "════════════════════════════════════════════════════════════════"

  echo
  echo "── CMS API ──────────────────────────────────────────────────────"
  run "GET /healthz                  (no DB)"        "$LOCAL_CMS/healthz"
  run "GET /api/v1/types             (cached)"       "$LOCAL_CMS/api/v1/types"
  run "GET /api/v1/menus/main?locale=en"             "$LOCAL_CMS/api/v1/menus/main?locale=en"
  run "GET /api/v1/settings/site.locales"            "$LOCAL_CMS/api/v1/settings/site.locales"
  run "GET /api/v1/content list   (post,en,20)"      "$LOCAL_CMS/api/v1/content?type=post&locale=en&limit=20"
  run "GET /api/v1/content by-slug  (one big post)"  "$LOCAL_CMS/api/v1/content/by-slug/post/closing-the-gc-gap?locale=en"
  run "GET /api/v1/settings        (full dump)"      "$LOCAL_CMS/api/v1/settings"

  echo
  echo "── Customer site (perry-landing) ───────────────────────────────"
  run "GET / (home, 13 sections render)"             "$LOCAL_SITE/"
  run "GET /blog (index, 17 posts)"                  "$LOCAL_SITE/blog"
  run "GET /blog/closing-the-gc-gap (markdown body)" "$LOCAL_SITE/blog/closing-the-gc-gap"
  run "GET /showcase/pry (rich repeater render)"     "$LOCAL_SITE/showcase/pry"
  run "GET /compare/bun (compare table render)"      "$LOCAL_SITE/compare/bun"
  run "GET /pricing (CMS-driven tiers + faqs)"       "$LOCAL_SITE/pricing"
  run "GET /sitemap.xml"                             "$LOCAL_SITE/sitemap.xml"

  echo
  echo "── after-run RSS ────────────────────────────────────────────────"
  echo "  CMS  RSS=$(rss_kb "$LOCAL_CMS_PID") KB"
  echo "  site RSS=$(rss_kb "$LOCAL_SITE_PID") KB"
fi

if [[ "$MODE" == "remote" || "$MODE" == "both" ]]; then
  echo
  echo "════════════════════════════════════════════════════════════════"
  echo "REMOTE — beta.perryts.com (Node 22 + tsx on Linux VPS)"
  echo "════════════════════════════════════════════════════════════════"
  echo
  echo "── Customer site ────────────────────────────────────────────────"
  run "GET /healthz"                                  "$REMOTE_SITE/healthz"
  run "GET /"                                         "$REMOTE_SITE/"
  run "GET /blog"                                     "$REMOTE_SITE/blog"
  run "GET /blog/closing-the-gc-gap"                  "$REMOTE_SITE/blog/closing-the-gc-gap"
  run "GET /showcase/pry"                             "$REMOTE_SITE/showcase/pry"
  run "GET /pricing"                                  "$REMOTE_SITE/pricing"
  run "GET /sitemap.xml"                              "$REMOTE_SITE/sitemap.xml"
fi
