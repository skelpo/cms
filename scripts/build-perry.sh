#!/usr/bin/env bash
#
# Compile the CMS to a native binary with Perry.
#
# WHY THIS WRAPPER EXISTS — Perry must run from its REAL executable path inside
# the perry workspace checkout, NOT via the `~/.cargo/bin/perry` symlink.
#
# The compiler locates the workspace (and thus the on-demand "auto-optimize"
# step that builds + links the per-feature ext libs, including the node:http
# server lib `libperry_ext_http.a`) by walking up from its own executable path
# looking for `crates/perry-runtime`. Invoked through the symlink,
# `current_exe()` resolves to `~/.cargo/bin`, no `crates/` dir is found, and the
# compiler silently falls back to linking only libperry_runtime.a +
# libperry_stdlib.a. The node:http server symbols then go unlinked, and the
# binary dies at the HTTP bind with `TypeError: value is not a function`.
#
# Setting PERRY_RUNTIME_DIR does NOT fix this — the fallback link path never
# pulls in the ext libs regardless. Resolving the symlink is what works.
#
# NOTE: the CMS cannot use `@hono/node-server` under Perry (its indirect
# createServer call can't bind to native node:http when compiled as a package).
# server.ts must serve via an inline node:http adapter. See CLAUDE.md.
set -euo pipefail

PERRY="$(command -v perry || true)"
if [ -z "$PERRY" ]; then
  echo "error: 'perry' not found on PATH" >&2
  exit 1
fi

# Resolve a one-level symlink (macOS BSD readlink prints the target, or fails
# with non-zero if PERRY is a regular file — in which case keep PERRY as-is).
REAL="$(readlink "$PERRY" 2>/dev/null || true)"
if [ -n "$REAL" ]; then
  PERRY="$REAL"
fi

echo "[build:perry] using perry at: $PERRY"
exec "$PERRY" compile src/server.ts -o dist/skelpo-cms "$@"
