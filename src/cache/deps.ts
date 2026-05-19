// Dependency graph for cache invalidation.
//
// While building a response, the request context collects DepKey strings
// it touched (content rows fetched, type-lists queried, menus rendered,
// settings consumed). Those deps are stored alongside the cache entry.
//
// On invalidation (content publish, menu update, etc.), we look up the
// reverse index from depKey → cacheKey set and delete affected entries.
//
// DepKey conventions (also emitted as Surrogate-Key on responses for CDN
// purges):
//   content:<id>                   — single content row
//   type-list:<typeSlug>:<locale>  — any list of that type+locale
//   type-list:<typeSlug>           — any list of that type, any locale
//   setting:<key>                  — single setting
//   menu:<slug>:<locale>           — menu in a locale
//   menu:<slug>                    — menu, any locale
//   redirects                      — redirect table (broad invalidation)
//   schema:<typeSlug>              — schema for a type changed

export type DepKey = string;
export type CacheKey = string;

export interface CacheEntry {
  status: number;
  bodyBytes: Uint8Array;
  contentType: string;
  etag: string;
  deps: DepKey[];
  storedAt: number;
  // Optional pre-compressed body (brotli/gzip) — added later when we wire
  // compression in the hot path.
  brotli?: Uint8Array;
}

// ────────────────────────────────────────────────────────────────────────

import { LruMap } from './lru.js';

const MAX_ENTRIES = 5_000;
const cache = new LruMap<CacheKey, CacheEntry>(MAX_ENTRIES);
const deps = new Map<DepKey, Set<CacheKey>>();

export function cacheGet(key: CacheKey): CacheEntry | undefined {
  return cache.get(key);
}

export function cacheSet(key: CacheKey, entry: CacheEntry): void {
  // Drop any previous registration for this key so its old deps don't
  // accumulate stale pointers.
  const prev = cache.get(key);
  if (prev) {
    for (const d of prev.deps) deps.get(d)?.delete(key);
  }
  cache.set(key, entry);
  for (const d of entry.deps) {
    let set = deps.get(d);
    if (!set) {
      set = new Set<CacheKey>();
      deps.set(d, set);
    }
    set.add(key);
  }
}

export function cacheDelete(key: CacheKey): void {
  const entry = cache.get(key);
  if (entry) {
    for (const d of entry.deps) deps.get(d)?.delete(key);
    cache.delete(key);
  }
}

/**
 * Invalidate every cache entry that depends on any of these dep keys.
 * Returns the count of entries removed.
 *
 * Also supports broad-prefix invalidation: passing `type-list:post` with
 * the `prefix: true` flag removes every entry under `type-list:post:*`.
 */
export function invalidate(depKeys: DepKey[], opts: { prefix?: boolean } = {}): number {
  const toRemove = new Set<CacheKey>();
  for (const dk of depKeys) {
    if (opts.prefix) {
      // Walk the deps map looking for keys that start with `dk:` or equal dk.
      for (const [stored, set] of deps) {
        if (stored === dk || stored.startsWith(dk + ':')) {
          for (const ck of set) toRemove.add(ck);
        }
      }
    } else {
      const set = deps.get(dk);
      if (set) for (const ck of set) toRemove.add(ck);
    }
  }
  for (const ck of toRemove) cacheDelete(ck);
  return toRemove.size;
}

/** Reset the entire cache. Use sparingly (admin-driven flush). */
export function flushAll(): number {
  const n = cache.size;
  cache.clear();
  deps.clear();
  return n;
}

/** Cache stats for /metrics. */
export function cacheStats(): { entries: number; depKeys: number } {
  return { entries: cache.size, depKeys: deps.size };
}

// ────────────────────────────────────────────────────────────────────────
// Dep-key collector — used while a response is being computed.

export class DepCollector {
  private readonly set = new Set<DepKey>();

  add(key: DepKey): void {
    this.set.add(key);
  }

  addContent(id: number | bigint): void {
    this.set.add(`content:${id}`);
  }

  addTypeList(typeSlug: string, locale?: string): void {
    this.set.add(locale ? `type-list:${typeSlug}:${locale}` : `type-list:${typeSlug}`);
  }

  addSetting(key: string): void {
    this.set.add(`setting:${key}`);
  }

  addMenu(slug: string, locale?: string): void {
    this.set.add(locale ? `menu:${slug}:${locale}` : `menu:${slug}`);
  }

  list(): DepKey[] {
    return [...this.set];
  }

  /** Format as Surrogate-Key header value: space-separated tokens. */
  toSurrogateKey(): string {
    // Surrogate-Key cannot contain spaces in individual keys; our keys
    // use ':' as separator which is allowed by Fastly/Cloudflare.
    return this.list().join(' ');
  }
}
