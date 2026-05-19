// Brute-force protection for /auth/login.
//
// Two windows tracked in `loginAttempts` table:
//   - Per (email, 15min): block at 5 failures
//   - Per (ip,    15min): block at 10 failures (looser, to avoid NAT lockout)
//
// Successful logins reset both counters by deleting all attempts for the
// email + IP. Failed attempts insert a row. Background job prunes rows
// older than 30 days.

import { execute, queryOne } from '../db/client.js';

const WINDOW_MIN = 15;
const EMAIL_LIMIT = 5;
const IP_LIMIT = 10;

export interface RateLimitResult {
  allowed: boolean;
  reason?: 'tooManyAttemptsEmail' | 'tooManyAttemptsIp';
  retryAfterSeconds?: number;
}

export async function checkLoginRateLimit(email: string, ip: string): Promise<RateLimitResult> {
  const lowerEmail = email.toLowerCase();

  const emailRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM \`loginAttempts\`
     WHERE \`email\` = ? AND \`success\` = 0
       AND \`createdAt\` > (NOW() - INTERVAL ${WINDOW_MIN} MINUTE)`,
    [lowerEmail],
  );
  if (emailRow && emailRow.n >= EMAIL_LIMIT) {
    return {
      allowed: false,
      reason: 'tooManyAttemptsEmail',
      retryAfterSeconds: WINDOW_MIN * 60,
    };
  }

  const ipRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM \`loginAttempts\`
     WHERE \`ip\` = ? AND \`success\` = 0
       AND \`createdAt\` > (NOW() - INTERVAL ${WINDOW_MIN} MINUTE)`,
    [ip],
  );
  if (ipRow && ipRow.n >= IP_LIMIT) {
    return {
      allowed: false,
      reason: 'tooManyAttemptsIp',
      retryAfterSeconds: WINDOW_MIN * 60,
    };
  }

  return { allowed: true };
}

export async function recordLoginAttempt(
  email: string,
  ip: string,
  success: boolean,
): Promise<void> {
  await execute(
    'INSERT INTO `loginAttempts` (`email`, `ip`, `success`) VALUES (?, ?, ?)',
    [email.toLowerCase(), ip, success ? 1 : 0],
  );
}

export async function clearFailedAttemptsForEmail(email: string): Promise<void> {
  await execute(
    'DELETE FROM `loginAttempts` WHERE `email` = ? AND `success` = 0',
    [email.toLowerCase()],
  );
}

/** Background prune. */
export async function pruneOldLoginAttempts(): Promise<number> {
  const r = await execute(
    'DELETE FROM `loginAttempts` WHERE `createdAt` < (NOW() - INTERVAL 30 DAY)',
    [],
  );
  return r.affectedRows;
}
