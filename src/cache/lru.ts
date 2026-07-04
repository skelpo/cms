// Minimal LRU map. Map-based — insertion order doubles as recency in V8/
// JSC since key access via get() doesn't reorder. We re-insert on hit to
// bump recency.
//
// Bounded by entry count. For byte-budget caps, layer on top.

export class LruMap<K, V> {
  private readonly maxEntries: number;
  private readonly store = new Map<K, V>();
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(maxEntries: number, onEvict?: (key: K, value: V) => void) {
    if (maxEntries <= 0) throw new Error('maxEntries must be positive');
    this.maxEntries = maxEntries;
    this.onEvict = onEvict;
  }

  get(key: K): V | undefined {
    const v = this.store.get(key);
    if (v === undefined) return undefined;
    // Re-insert to bump recency.
    this.store.delete(key);
    this.store.set(key, v);
    return v;
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      // Evict oldest (insertion-order first key), notifying the owner so it can
      // release any side structures (e.g. the cache dependency graph).
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.store.get(oldest);
        this.store.delete(oldest);
        if (evicted !== undefined) this.onEvict?.(oldest, evicted);
      }
    }
    this.store.set(key, value);
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  *keys(): IterableIterator<K> {
    yield* this.store.keys();
  }

  *entries(): IterableIterator<[K, V]> {
    yield* this.store.entries();
  }
}
