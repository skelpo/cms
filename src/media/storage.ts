// Storage-agnostic media backend. The DB layer (media/store.ts) talks to
// this interface; concrete backends live in ./local.ts and ./s3.ts.
//
// Why an interface, not just a switch: ensures every byte path goes
// through the same contract. New backends (GCS, Azure Blob, Spaces) drop
// in as a third file without touching callers.

export interface MediaStorage {
  /** Persist `bytes` at `key`. Idempotent for the same key + bytes. */
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;

  /** Fetch bytes for `key`. Throws if absent. */
  get(key: string): Promise<Uint8Array>;

  /** Best-effort delete. No-throws when key already gone. */
  delete(key: string): Promise<void>;

  /**
   * Direct URL the public can hit for this key, bypassing the CMS.
   *  - `null` → caller proxies via /api/v1/media/:id/raw (private bucket
   *    or local disk).
   *  - non-null → public bucket or CDN; CMS may 302-redirect to it for
   *    cache-friendliness.
   */
  publicUrl(key: string): string | null;

  /** Human-readable backend identifier for logs + healthchecks. */
  readonly name: 'local' | 's3';
}

// ── Factory ──────────────────────────────────────────────────────────

import { config } from '../config.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';

let cached: MediaStorage | null = null;

export function mediaStorage(): MediaStorage {
  if (cached) return cached;
  switch (config.media.backend) {
    case 's3':
      cached = new S3Storage();
      break;
    case 'local':
    default:
      cached = new LocalStorage(config.media.localPath);
      break;
  }
  return cached;
}

// Reset between tests / on hot reload.
export function resetMediaStorage(): void {
  cached = null;
}
