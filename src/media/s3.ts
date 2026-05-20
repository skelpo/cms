// S3 backend. Works with AWS S3, Cloudflare R2, Backblaze B2, MinIO,
// Wasabi, DigitalOcean Spaces — anything speaking sigv4 + the standard
// PutObject/GetObject/DeleteObject API.
//
// Implementation uses native fetch + the Web Crypto API for HMAC/SHA-256
// instead of pulling in @aws-sdk/client-s3 (~1 MB). Keeps the binary
// tiny and the Perry-compiled native binary minimal.
//
// Env vars:
//   MEDIA_BACKEND=s3
//   S3_BUCKET=my-bucket                (required)
//   S3_REGION=us-east-1                (default: us-east-1)
//   S3_ENDPOINT=https://...            (optional; for R2/B2/MinIO etc.
//                                       default: AWS regional endpoint)
//   S3_ACCESS_KEY_ID=...               (required)
//   S3_SECRET_ACCESS_KEY=...           (required)
//   S3_PUBLIC_URL_BASE=https://cdn.x   (optional; if set, publicUrl
//                                       returns `${BASE}/${key}` so the
//                                       customer site / CDN can hit the
//                                       bucket directly)
//   S3_FORCE_PATH_STYLE=1              (MinIO / older R2 setups)

import type { MediaStorage } from './storage.js';
import { config } from '../config.js';

const enc = new TextEncoder();
const SERVICE = 's3';

async function sha256Hex(data: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, data as BufferSource);
  return new Uint8Array(sig);
}
async function hmacHex(key: Uint8Array, data: Uint8Array): Promise<string> {
  return Array.from(await hmac(key, data), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isoTimestamp(d: Date): string {
  // 20240520T123456Z
  return d.toISOString().replace(/[-:]|\.\d{3}/g, '');
}
function ymd(d: Date): string { return isoTimestamp(d).slice(0, 8); }

// Encode per AWS rules: leave unreserved chars, percent-encode the rest.
function awsEncode(s: string, encodeSlash = true): string {
  let out = '';
  for (const ch of s) {
    if (/[A-Za-z0-9._~-]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += ch;
    else out += encodeURIComponent(ch).replace(/!|\*|'|\(|\)/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  }
  return out;
}

interface S3Config {
  bucket: string;
  region: string;
  endpoint: string;        // e.g. https://s3.us-east-1.amazonaws.com OR https://<acct>.r2.cloudflarestorage.com
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  publicUrlBase: string | null;
}

function loadS3Config(): S3Config {
  const env = process.env;
  const region = env.S3_REGION ?? 'us-east-1';
  const bucket = env.S3_BUCKET;
  const accessKey = env.S3_ACCESS_KEY_ID;
  const secretKey = env.S3_SECRET_ACCESS_KEY;
  if (!bucket)    throw new Error('S3 backend selected: S3_BUCKET is required');
  if (!accessKey) throw new Error('S3 backend selected: S3_ACCESS_KEY_ID is required');
  if (!secretKey) throw new Error('S3 backend selected: S3_SECRET_ACCESS_KEY is required');
  const endpoint = env.S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`;
  // Path-style for endpoints without a clear *.bucket. subdomain (MinIO,
  // some R2 setups). Default to virtual-hosted style for AWS.
  const forcePathStyle = env.S3_FORCE_PATH_STYLE === '1' || env.S3_FORCE_PATH_STYLE === 'true';
  return {
    bucket, region, endpoint, accessKey, secretKey, forcePathStyle,
    publicUrlBase: env.S3_PUBLIC_URL_BASE ?? null,
  };
}

export class S3Storage implements MediaStorage {
  readonly name = 's3' as const;
  private cfg: S3Config | null = null;

  private c(): S3Config {
    if (!this.cfg) this.cfg = loadS3Config();
    return this.cfg;
  }

  private urlFor(key: string): { url: URL; host: string; canonicalPath: string } {
    const cfg = this.c();
    const ep = new URL(cfg.endpoint);
    let host: string, pathPrefix: string;
    if (cfg.forcePathStyle) {
      host = ep.host;
      pathPrefix = `/${cfg.bucket}`;
    } else {
      // virtual-hosted: bucket as subdomain
      host = `${cfg.bucket}.${ep.host}`;
      pathPrefix = '';
    }
    const canonicalPath = `${pathPrefix}/${awsEncode(key, false)}`;
    const url = new URL(`${ep.protocol}//${host}${canonicalPath}`);
    return { url, host, canonicalPath };
  }

  private async sign(opts: {
    method: 'PUT' | 'GET' | 'DELETE';
    key: string;
    payload: Uint8Array;
    extraHeaders?: Record<string, string>;
  }): Promise<{ url: URL; headers: Record<string, string> }> {
    const cfg = this.c();
    const { url, host, canonicalPath } = this.urlFor(opts.key);
    const now = new Date();
    const ts = isoTimestamp(now);
    const date = ymd(now);
    const payloadHash = await sha256Hex(opts.payload);

    // Canonical headers (lowercase, sorted, trimmed values)
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': ts,
      ...(opts.extraHeaders ?? {}),
    };
    const sortedKeys = Object.keys(headers).map((k) => k.toLowerCase()).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]!.trim().replace(/\s+/g, ' ')}\n`).join('');
    const signedHeaders = sortedKeys.join(';');

    const canonicalRequest = [
      opts.method,
      canonicalPath,
      '',                  // canonical query string (none for these ops)
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${date}/${cfg.region}/${SERVICE}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      ts,
      scope,
      await sha256Hex(enc.encode(canonicalRequest)),
    ].join('\n');

    // Derive signing key
    const kDate    = await hmac(enc.encode(`AWS4${cfg.secretKey}`), enc.encode(date));
    const kRegion  = await hmac(kDate, enc.encode(cfg.region));
    const kService = await hmac(kRegion, enc.encode(SERVICE));
    const kSigning = await hmac(kService, enc.encode('aws4_request'));
    const signature = await hmacHex(kSigning, enc.encode(stringToSign));

    headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { url, headers };
  }

  async put(key: string, bytes: Uint8Array, mime: string): Promise<void> {
    const { url, headers } = await this.sign({
      method: 'PUT', key, payload: bytes,
      extraHeaders: { 'content-type': mime },
    });
    const r = await fetch(url, {
      method: 'PUT',
      headers,
      body: bytes as BodyInit,
    });
    if (!r.ok) throw new Error(`S3 PUT ${key}: ${r.status} ${await r.text().catch(() => '')}`);
  }

  async get(key: string): Promise<Uint8Array> {
    const { url, headers } = await this.sign({ method: 'GET', key, payload: new Uint8Array() });
    const r = await fetch(url, { method: 'GET', headers });
    if (!r.ok) throw new Error(`S3 GET ${key}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const { url, headers } = await this.sign({ method: 'DELETE', key, payload: new Uint8Array() });
    const r = await fetch(url, { method: 'DELETE', headers });
    // 204 (deleted) and 404 (already gone) both fine.
    if (!r.ok && r.status !== 404) throw new Error(`S3 DELETE ${key}: ${r.status}`);
  }

  publicUrl(key: string): string | null {
    const cfg = this.c();
    if (!cfg.publicUrlBase) return null;
    return `${cfg.publicUrlBase.replace(/\/+$/, '')}/${awsEncode(key, false)}`;
  }
}
