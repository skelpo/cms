// ETag helpers. We use a 16-hex-char prefix of sha256(body) — collision
// risk negligible for our use case and saves a few bytes per response.

export async function computeEtag(body: Uint8Array | string): Promise<string> {
  const data = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 8; i++) {
    const byte = arr[i] ?? 0;
    hex += byte.toString(16).padStart(2, '0');
  }
  return `"${hex}"`;
}

/** Returns true if If-None-Match matches the given etag. */
export function ifNoneMatchHits(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  // Accept comma-separated list or "*".
  if (ifNoneMatch.trim() === '*') return true;
  const tags = ifNoneMatch.split(',').map((s) => s.trim());
  return tags.includes(etag);
}
