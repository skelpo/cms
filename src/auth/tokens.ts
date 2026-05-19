// API tokens — long-lived bearer tokens for SDK/mobile clients.
//
// Token shape: skp_v1_<32-bytes-hex>. We store sha256(token) in DB so a
// DB leak can't impersonate. Prefix (first 12 chars) shown to admins for
// disambiguation. Token plaintext is shown ONCE on creation.

import { execute, query, queryOne } from '../db/client.js';

export interface TokenRow {
  id: number;
  userId: number;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface TokenDbRow extends Omit<TokenRow, 'scopes'> {
  scopes: string;
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomBytesHex(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createToken(opts: {
  userId: number;
  name: string;
  scopes: string[];
  expiresAt?: Date;
}): Promise<{ id: number; token: string }> {
  const raw = `skp_v1_${randomBytesHex(32)}`;
  const hash = await sha256Hex(raw);
  const prefix = raw.slice(0, 12);
  const r = await execute(
    'INSERT INTO `apiTokens` (`userId`, `name`, `tokenHash`, `prefix`, `scopes`, `expiresAt`) VALUES (?, ?, ?, ?, ?, ?)',
    [
      opts.userId,
      opts.name,
      hash,
      prefix,
      JSON.stringify(opts.scopes),
      opts.expiresAt ? opts.expiresAt.toISOString().slice(0, 19).replace('T', ' ') : null,
    ],
  );
  return { id: Number(r.insertId), token: raw };
}

export async function lookupToken(raw: string): Promise<TokenRow | null> {
  if (!raw.startsWith('skp_v1_') || raw.length < 20) return null;
  const hash = await sha256Hex(raw);
  const row = await queryOne<TokenDbRow>(
    'SELECT `id`, `userId`, `name`, `prefix`, `scopes`, `lastUsedAt`, `expiresAt`, `revokedAt`, `createdAt` FROM `apiTokens` WHERE `tokenHash` = ?',
    [hash],
  );
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && new Date(row.expiresAt) <= new Date()) return null;

  // Update lastUsedAt asynchronously — don't block the request.
  void execute('UPDATE `apiTokens` SET `lastUsedAt` = NOW() WHERE `id` = ?', [row.id]);

  return { ...row, scopes: parseScopes(row.scopes) };
}

function parseScopes(s: string | string[]): string[] {
  if (Array.isArray(s)) return s;
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export async function listTokensForUser(userId: number): Promise<TokenRow[]> {
  const rows = await query<TokenDbRow>(
    'SELECT `id`, `userId`, `name`, `prefix`, `scopes`, `lastUsedAt`, `expiresAt`, `revokedAt`, `createdAt` FROM `apiTokens` WHERE `userId` = ? ORDER BY `createdAt` DESC',
    [userId],
  );
  return rows.map((r) => ({ ...r, scopes: parseScopes(r.scopes) }));
}

export async function revokeToken(id: number, userId: number): Promise<boolean> {
  const r = await execute(
    'UPDATE `apiTokens` SET `revokedAt` = NOW() WHERE `id` = ? AND `userId` = ?',
    [id, userId],
  );
  return r.affectedRows > 0;
}
