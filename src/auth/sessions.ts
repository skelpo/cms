// DB-backed sessions. Token is 256 bits of random hex stored as the PK.
// We never log or display the token; the cookie is HttpOnly/Secure.

import { execute, query, queryOne } from '../db/client.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export interface SessionRow {
  id: string;
  userId: number;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Session tokens are stored HASHED (sha256) so a read-only DB exposure (backup
// leak, replica, SQLi elsewhere) can't be replayed to hijack a session — same
// design as API tokens. The raw token lives only in the client's HttpOnly cookie.
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(
  userId: number,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await execute(
    'INSERT INTO `sessions` (`id`, `userId`, `expiresAt`, `ip`, `userAgent`) VALUES (?, ?, ?, ?, ?)',
    [
      await sha256Hex(token),
      userId,
      expiresAt.toISOString().slice(0, 19).replace('T', ' '),
      meta.ip ?? null,
      meta.userAgent ?? null,
    ],
  );
  return { token, expiresAt };
}

export async function lookupSession(token: string): Promise<SessionRow | null> {
  if (!token || token.length !== 64) return null;
  const row = await queryOne<SessionRow>(
    'SELECT `id`, `userId`, `expiresAt`, `ip`, `userAgent`, `createdAt` FROM `sessions` WHERE `id` = ? AND `expiresAt` > NOW()',
    [await sha256Hex(token)],
  );
  return row;
}

export async function deleteSession(token: string): Promise<void> {
  await execute('DELETE FROM `sessions` WHERE `id` = ?', [await sha256Hex(token)]);
}

export async function deleteAllSessionsForUser(userId: number): Promise<number> {
  const r = await execute('DELETE FROM `sessions` WHERE `userId` = ?', [userId]);
  return r.affectedRows;
}

/** Run periodically by the jobs worker. */
export async function pruneExpiredSessions(): Promise<number> {
  const r = await execute('DELETE FROM `sessions` WHERE `expiresAt` <= NOW()', []);
  return r.affectedRows;
}

export async function listSessionsForUser(userId: number): Promise<SessionRow[]> {
  return query<SessionRow>(
    'SELECT `id`, `userId`, `expiresAt`, `ip`, `userAgent`, `createdAt` FROM `sessions` WHERE `userId` = ? ORDER BY `createdAt` DESC',
    [userId],
  );
}
