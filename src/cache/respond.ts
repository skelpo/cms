// withCache(c, key, fn) — the read-through cache helper.
//
// On hit:  serves the stored buffer (or 304 if If-None-Match matches).
// On miss: runs `fn(deps)` to compute the body, then stores+serves.
//
// fn receives a DepCollector — call addContent/addTypeList/etc. as you
// build the response so the entry gets a proper dependency footprint.
//
// Use only for stable, public, cacheable JSON responses. Authenticated
// (admin/api token) writes and reads of drafts skip the cache entirely.

import type { Context } from 'hono';
import {
  cacheGet,
  cacheSet,
  DepCollector,
  type CacheEntry,
} from './deps.js';
import { computeEtag, ifNoneMatchHits } from './etag.js';

export interface CachedResult {
  status?: number;
  contentType?: string;
  body: string | Uint8Array | object;
  /** Cache-Control override; defaults to 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400' */
  cacheControl?: string;
}

const DEFAULT_CACHE_CONTROL =
  'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';

export async function withCache(
  c: Context,
  cacheKey: string,
  fn: (deps: DepCollector) => Promise<CachedResult>,
): Promise<Response> {
  // Hit path.
  const hit = cacheGet(cacheKey);
  if (hit) {
    return respondFromEntry(c, hit);
  }

  // Miss — compute.
  const deps = new DepCollector();
  const result = await fn(deps);
  const body = normalizeBody(result.body);
  const contentType = result.contentType ?? 'application/json; charset=utf-8';
  const etag = await computeEtag(body);
  const entry: CacheEntry = {
    status: result.status ?? 200,
    bodyBytes: body,
    contentType,
    etag,
    deps: deps.list(),
    storedAt: Date.now(),
  };
  cacheSet(cacheKey, entry);
  return respondFromEntry(c, entry, result.cacheControl);
}

function respondFromEntry(
  c: Context,
  entry: CacheEntry,
  cacheControl: string = DEFAULT_CACHE_CONTROL,
): Response {
  const ifNoneMatch = c.req.header('if-none-match') ?? null;
  if (ifNoneMatchHits(ifNoneMatch, entry.etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: entry.etag,
        'Cache-Control': cacheControl,
        'Surrogate-Key': entry.deps.join(' '),
      },
    });
  }
  return new Response(entry.bodyBytes as BodyInit, {
    status: entry.status,
    headers: {
      'Content-Type': entry.contentType,
      ETag: entry.etag,
      'Cache-Control': cacheControl,
      'Surrogate-Key': entry.deps.join(' '),
    },
  });
}

function normalizeBody(b: string | Uint8Array | object): Uint8Array {
  if (b instanceof Uint8Array) return b;
  if (typeof b === 'string') return new TextEncoder().encode(b);
  return new TextEncoder().encode(JSON.stringify(b));
}
