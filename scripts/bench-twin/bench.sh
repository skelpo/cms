#!/bin/bash
# Direct Node vs Perry comparison.
#
# Same source (src/server.ts), same machine, same harness.
# Each mode runs all endpoints, then the other mode does.
#
# Tunables:
#   DURATION=15  CONNS=10  WARMUP=3

set -euo pipefail
cd "$(dirname "$0")"

DURATION="${DURATION:-15}"
CONNS="${CONNS:-10}"
WARMUP="${WARMUP:-3}"
PORT=5060

ENDPOINTS=(
  "GET /healthz       http://127.0.0.1:$PORT/healthz"
  "GET /json          http://127.0.0.1:$PORT/json"
  "GET /loop          http://127.0.0.1:$PORT/loop"
  "GET /text          http://127.0.0.1:$PORT/text"
  "GET /headers       http://127.0.0.1:$PORT/headers"
)

# Free the port if anything is there
free_port() {
  lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true
  sleep 1
}

# Capture RSS in KB of a PID
rss_kb() {
  ps -o rss= -p "$1" 2>/dev/null | tr -d ' ' || echo 0
}

# Format autocannon JSON into one line of stats
fmt() {
  python3 -c "
import sys, json
d = json.load(sys.stdin)
lat = d.get('latency', {})
rps = d.get('requests', {})
thr = d.get('throughput', {})
err = d.get('non2xx', 0) + d.get('errors', 0)
def latfmt(v):
    return '<1' if v < 1 else f'{v:.0f}'
print(f\"{rps.get('average', 0):>9.0f} RPS  |  avg {lat.get('average', 0):>6.2f} ms  |  p50 {latfmt(lat.get('p50',0)):>4} ms  |  p99 {latfmt(lat.get('p99',0)):>4} ms  |  max {int(lat.get('max',0)):>4} ms  |  {thr.get('average', 0)/1024/1024:>5.2f} MB/s  |  errors={err}\")
"
}

# Run autocannon once: warm-up + measured
bench_one() {
  local url="$1"
  autocannon -d "$WARMUP" -c "$CONNS" "$url" >/dev/null 2>&1 || true
  autocannon -d "$DURATION" -c "$CONNS" -j "$url" 2>/dev/null | fmt
}

# Bench a running server with the full endpoint set
bench_server() {
  local label="$1"
  local pid="$2"
  echo
  echo "════════════════════════════════════════════════════════════════════════════════"
  printf "%-78s\n" "$label  (pid=$pid)"
  echo "════════════════════════════════════════════════════════════════════════════════"
  local rss_before
  rss_before=$(rss_kb "$pid")
  printf "RSS at start: %d KB\n" "$rss_before"
  for entry in "${ENDPOINTS[@]}"; do
    local name="${entry%%http*}"
    local url="${entry##* }"
    printf "%-20s  " "$name"
    bench_one "$url"
  done
  local rss_after
  rss_after=$(rss_kb "$pid")
  printf "RSS at end:   %d KB\n" "$rss_after"
}

echo "Bench: ${DURATION}s @ ${CONNS} conns (warm-up ${WARMUP}s)   $(uname -srm)"
echo "Date:  $(date)"
echo
echo "Node:  $(node --version 2>/dev/null || echo '?')"
echo "Perry: $(/Users/amlug/projects/perry/perry/target/release/perry --version 2>/dev/null || echo '?')"

# ── Node ─────────────────────────────────────────────────────
free_port
PORT=$PORT npx tsx src/server.ts > /tmp/twin-node.log 2>&1 &
NODE_PID=$!
sleep 2
bench_server "NODE  + tsx (npx tsx src/server.ts)" "$NODE_PID"
kill "$NODE_PID" 2>/dev/null || true
wait "$NODE_PID" 2>/dev/null || true

# ── Perry ────────────────────────────────────────────────────
free_port
PORT=$PORT ./dist/bench-twin > /tmp/twin-perry.log 2>&1 &
PERRY_PID=$!
sleep 2
bench_server "PERRY native  (./dist/bench-twin, $(stat -f '%z' ./dist/bench-twin) bytes)" "$PERRY_PID"
kill "$PERRY_PID" 2>/dev/null || true
wait "$PERRY_PID" 2>/dev/null || true

echo
echo "Logs:  /tmp/twin-node.log  /tmp/twin-perry.log"
