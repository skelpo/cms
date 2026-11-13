// Time-based one-time passwords (RFC 6238, SHA-1, 6 digits, 30 s steps) —
// the scheme every authenticator app speaks. Secrets are stored base32 in
// `users.totpSecret`; `users.totpVerified = 1` means sign-in requires a code.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A fresh 160-bit secret, base32 (32 characters). */
export function generateTotpSecret(): string {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return base32Encode(b);
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const msg = new Uint8Array(8);
  let n = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code an authenticator shows at `atMs` (exported for tests). */
export function totpAt(secretBase32: string, atMs: number = Date.now()): Promise<string> {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 1000 / STEP_SECONDS));
}

function sameDigits(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Check a 6-digit code against the secret, allowing one step of clock drift
 * either way. Returns the matched time step (so callers can refuse a replay),
 * or null when the code is wrong.
 */
export async function matchTotp(secretBase32: string, code: string, atMs: number = Date.now()): Promise<number | null> {
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretBase32);
  if (secret.length < 10) return null;
  const now = Math.floor(atMs / 1000 / STEP_SECONDS);
  let matched: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    if (sameDigits(await hotp(secret, step), clean)) matched = step;
  }
  return matched;
}

// A code is good for ~90 s; remember the last step each user spent so a code
// that was observed once cannot be used a second time.
const lastStep = new Map<number, number>();

/** Verify a sign-in code for a user; each code is accepted at most once. */
export async function verifyTotpForUser(userId: number, secretBase32: string | null, code: string): Promise<boolean> {
  if (!secretBase32) return false;
  const step = await matchTotp(secretBase32, code);
  if (step === null) return false;
  if ((lastStep.get(userId) ?? -1) >= step) return false;
  lastStep.set(userId, step);
  return true;
}

/** The `otpauth://` link an authenticator app reads from the QR code. */
export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const cleanIssuer = issuer.replace(/:/g, ' ').trim() || 'Skelpo CMS';
  const label = encodeURIComponent(`${cleanIssuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(cleanIssuer)}`;
}

/** Group a secret in fours so it can be typed by hand. */
export function formatSecret(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, '$1 ').trim();
}

// ── Pending sign-ins ───────────────────────────────────────────────────
// After the password step a 2FA account gets a short-lived ticket instead of
// a session; the ticket plus a valid code completes the sign-in. Kept in
// memory: losing them on restart only means signing in again.

interface Pending { userId: number; email: string; expires: number; tries: number }
const pending = new Map<string, Pending>();
const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_TRIES = 5;

export function createPendingLogin(userId: number, email: string): string {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  const ticket = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  pending.set(ticket, { userId, email, expires: now + PENDING_TTL_MS, tries: 0 });
  return ticket;
}

/** Look up a ticket and count the attempt. Null when unknown, expired or used up. */
export function usePendingLogin(ticket: string): { userId: number; email: string } | null {
  const p = pending.get(ticket);
  if (!p) return null;
  if (p.expires < Date.now() || p.tries >= MAX_TRIES) {
    pending.delete(ticket);
    return null;
  }
  p.tries++;
  return { userId: p.userId, email: p.email };
}

export function clearPendingLogin(ticket: string): void {
  pending.delete(ticket);
}
