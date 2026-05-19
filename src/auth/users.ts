// User row helpers — kept separate from auth flow code so route handlers
// stay thin.

import { execute, query, queryOne } from '../db/client.js';
import { dateToIso } from '../db/datetime.js';

export interface UserRow {
  id: number;
  email: string;
  passwordHash: string;
  displayName: string;
  roleId: number;
  locale: string;
  totpSecret: string | null;
  totpVerified: number;
  status: 'active' | 'suspended' | 'invited';
  inviteToken: string | null;
  inviteExpiresAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoleRow {
  id: number;
  slug: string;
  label: string;
  capabilities: RoleCapabilities;
  isBuiltin: number;
}

export interface RoleCapabilities {
  global: string[];
  types: Record<string, string[]>;
}

interface RoleDbRow extends Omit<RoleRow, 'capabilities'> {
  capabilities: string | RoleCapabilities;
}

function parseCapabilities(v: string | RoleCapabilities): RoleCapabilities {
  if (typeof v === 'object' && v !== null) return v;
  try {
    return JSON.parse(v) as RoleCapabilities;
  } catch {
    return { global: [], types: {} };
  }
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    'SELECT * FROM `users` WHERE `email` = ? AND `status` = "active"',
    [email.toLowerCase()],
  );
}

export async function findUserById(id: number): Promise<UserRow | null> {
  return queryOne<UserRow>(
    'SELECT * FROM `users` WHERE `id` = ?',
    [id],
  );
}

export async function findRoleById(id: number): Promise<RoleRow | null> {
  const row = await queryOne<RoleDbRow>('SELECT * FROM `roles` WHERE `id` = ?', [id]);
  if (!row) return null;
  return { ...row, capabilities: parseCapabilities(row.capabilities) };
}

export async function findRoleBySlug(slug: string): Promise<RoleRow | null> {
  const row = await queryOne<RoleDbRow>('SELECT * FROM `roles` WHERE `slug` = ?', [slug]);
  if (!row) return null;
  return { ...row, capabilities: parseCapabilities(row.capabilities) };
}

export async function listRoles(): Promise<RoleRow[]> {
  const rows = await query<RoleDbRow>('SELECT * FROM `roles` ORDER BY `id`');
  return rows.map((r) => ({ ...r, capabilities: parseCapabilities(r.capabilities) }));
}

export async function touchLastLogin(userId: number): Promise<void> {
  await execute('UPDATE `users` SET `lastLoginAt` = NOW() WHERE `id` = ?', [userId]);
}

export interface PublicUser {
  id: number;
  email: string;
  displayName: string;
  role: { id: number; slug: string; label: string };
  locale: string;
  totpEnabled: boolean;
  status: UserRow['status'];
  lastLoginAt: string | null;
  createdAt: string;
}

export function toPublicUser(u: UserRow, role: RoleRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: { id: role.id, slug: role.slug, label: role.label },
    locale: u.locale,
    totpEnabled: u.totpVerified === 1,
    status: u.status,
    lastLoginAt: dateToIso(u.lastLoginAt),
    createdAt: dateToIso(u.createdAt) ?? new Date().toISOString(),
  };
}
