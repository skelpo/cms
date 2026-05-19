// Optional in-memory cache for SDK GETs. Keyed on the URL + locale; deps
// tracked the same way the CMS does it (content:<id>, type-list:<type>:<locale>,
// menu:<slug>:<locale>, setting:<key>). Webhook handler calls invalidate()
// with the same dep-keys the CMS emits.

type CacheKey = string;
type DepKey = string;

interface Entry<T> {
  value: T;
  deps: DepKey[];
  etag?: string;
  storedAt: number;
}

export class SdkCache {
  private readonly entries = new Map<CacheKey, Entry<unknown>>();
  private readonly deps = new Map<DepKey, Set<CacheKey>>();
  private readonly maxEntries: number;

  constructor(maxEntries = 2_000) {
    this.maxEntries = maxEntries;
  }

  get<T>(key: CacheKey): { value: T; etag?: string } | undefined {
    const e = this.entries.get(key) as Entry<T> | undefined;
    if (!e) return undefined;
    // Bump recency.
    this.entries.delete(key);
    this.entries.set(key, e);
    return { value: e.value, etag: e.etag };
  }

  set<T>(key: CacheKey, value: T, deps: DepKey[], etag?: string): void {
    // Drop previous deps registration.
    const prev = this.entries.get(key);
    if (prev) {
      for (const d of prev.deps) this.deps.get(d)?.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    const entry: Entry<T> = { value, deps, storedAt: Date.now() };
    if (etag !== undefined) entry.etag = etag;
    this.entries.set(key, entry);
    for (const d of deps) {
      let set = this.deps.get(d);
      if (!set) { set = new Set<CacheKey>(); this.deps.set(d, set); }
      set.add(key);
    }
  }

  delete(key: CacheKey): void {
    const e = this.entries.get(key);
    if (!e) return;
    for (const d of e.deps) this.deps.get(d)?.delete(key);
    this.entries.delete(key);
  }

  /**
   * Invalidate every cached entry depending on any of these dep keys.
   * Supports exact match and prefix match (e.g. invalidating `menu:main`
   * removes all `menu:main:*` entries).
   */
  invalidate(depKeys: DepKey[]): number {
    const toRemove = new Set<CacheKey>();
    for (const dk of depKeys) {
      const exact = this.deps.get(dk);
      if (exact) for (const ck of exact) toRemove.add(ck);
      // Prefix match.
      for (const [stored, set] of this.deps) {
        if (stored !== dk && stored.startsWith(dk + ':')) {
          for (const ck of set) toRemove.add(ck);
        }
      }
    }
    for (const ck of toRemove) this.delete(ck);
    return toRemove.size;
  }

  clear(): void {
    this.entries.clear();
    this.deps.clear();
  }

  size(): { entries: number; depKeys: number } {
    return { entries: this.entries.size, depKeys: this.deps.size };
  }
}
