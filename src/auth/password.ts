// Password hashing via bcryptjs (pure JS, runs everywhere).
//
// Cost factor 12 is the 2026 sweet spot — ~250ms per hash on modern HW.
// Verify uses bcryptjs's constant-time compare internally.

import bcrypt from 'bcryptjs';

const COST = 12;

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
