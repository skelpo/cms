// imgproxy signed-URL builder.
//
// URL form: {IMGPROXY_URL}/{sig}/{processing}/{base64url(sourceUrl)}.{ext}
// sig = base64url( HMAC_SHA256(key, salt || path) ), path = "/{processing}/{b64src}"
// When IMGPROXY_SIGN_KEY/SALT are unset we emit /insecure/ (imgproxy must
// run with IMGPROXY_ALLOW_UNSAFE=1 in dev).

import { config } from '../config.js';

export interface TransformOpts {
  w?: number;
  h?: number;
  format?: 'auto' | 'webp' | 'avif' | 'jpeg' | 'png';
  quality?: number;
  fit?: 'cover' | 'contain';
  gravity?: 'ce' | 'sm' | 'fp';
  focalPoint?: { x: number; y: number };
}

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function buildProcessing(o: TransformOpts): string {
  const parts: string[] = [];
  if (o.w || o.h) {
    const fit = o.fit === 'contain' ? 'fit' : 'fill';
    parts.push(`rs:${fit}:${o.w ?? 0}:${o.h ?? 0}:0`);
  }
  if (o.gravity === 'fp' && o.focalPoint) {
    parts.push(`g:fp:${o.focalPoint.x.toFixed(3)}:${o.focalPoint.y.toFixed(3)}`);
  } else if (o.gravity === 'sm') {
    parts.push('g:sm');
  }
  if (o.quality) parts.push(`q:${o.quality}`);
  const ext = !o.format || o.format === 'auto' ? '' : `@${o.format}`;
  return parts.join('/') + (ext ? `/${'ext:' + o.format}` : '');
}

export async function signedImgproxyUrl(
  sourceUrl: string,
  opts: TransformOpts = {},
): Promise<string> {
  const base = (config.imgproxy.url || '').replace(/\/+$/, '');
  const processing = buildProcessing(opts) || 'rs:fit:0:0:0';
  const encodedSrc = b64urlStr(sourceUrl);
  const ext = !opts.format || opts.format === 'auto' ? '' : `.${opts.format}`;
  const path = `/${processing}/${encodedSrc}${ext}`;

  if (!config.imgproxy.signKey || !config.imgproxy.salt) {
    return `${base}/insecure${path}`;
  }
  const keyBytes = hexToBytes(config.imgproxy.signKey);
  const saltBytes = hexToBytes(config.imgproxy.salt);
  const msg = new Uint8Array(saltBytes.length + path.length);
  msg.set(saltBytes, 0);
  msg.set(new TextEncoder().encode(path), saltBytes.length);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, msg as BufferSource));
  return `${base}/${b64url(sig)}${path}`;
}
