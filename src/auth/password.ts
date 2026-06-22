// Password hashing via bcryptjs (pure JS, runs everywhere).
//
// Cost factor: lowered 12 → 10 as a performance accommodation for the perry
// runtime. Perry's bcrypt is ~8s of CPU at cost-12 even after the typed-array
// perf fixes (PerryTS/perry #5544/#5551; remaining gap tracked in #5525), vs
// ~250ms on Node; cost-10 is ~2-3s. Acceptable for a single admin login; raise
// back to 12 once perry's bcrypt nears native speed. Changing this only affects
// NEW hashes — existing stored hashes embed their own cost, so re-hash the admin
// password when changing it.

import bcrypt from 'bcryptjs';

const COST = 10;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (plain.length > 200) {
    throw new Error('Password must be 200 characters or fewer');
  }
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!plain || !hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
