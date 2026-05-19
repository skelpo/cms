// Settings registry. All settings loaded into memory at boot; refreshed
// after writes. Hot path (every public request) reads these in O(1).

import { execute, query, queryOne } from '../db/client.js';

interface SettingRow {
  keyName: string;
  value: string | unknown;
}

let cache: Map<string, unknown> | null = null;

function parseValue(v: string | unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

export async function loadSettings(force = false): Promise<void> {
  if (cache && !force) return;
  const rows = await query<SettingRow>('SELECT `keyName`, `value` FROM `settings`');
  cache = new Map(rows.map((r) => [r.keyName, parseValue(r.value)]));
}

export async function getSetting<T = unknown>(key: string, fallback?: T): Promise<T> {
  await loadSettings();
  return (cache!.has(key) ? cache!.get(key) : fallback) as T;
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  await loadSettings();
  return Object.fromEntries(cache!);
}

export async function setSetting(key: string, value: unknown, updatedBy?: number | null): Promise<void> {
  await execute(
    `INSERT INTO \`settings\` (\`keyName\`, \`value\`, \`updatedBy\`)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), \`updatedBy\` = VALUES(\`updatedBy\`)`,
    [key, JSON.stringify(value), updatedBy ?? null],
  );
  // Refresh just this key in cache.
  await loadSettings();
  if (cache) cache.set(key, value);
}

export async function getSiteUrl(): Promise<string> {
  return getSetting<string>('site.url', 'http://localhost:3000');
}

export async function getDefaultLocale(): Promise<string> {
  return getSetting<string>('site.defaultLocale', 'en');
}

export async function getConfiguredLocales(): Promise<string[]> {
  const v = await getSetting<string[]>('site.locales', ['en']);
  return Array.isArray(v) ? v : ['en'];
}

export function invalidateSettingsCache(): void {
  cache = null;
}

/** Existence check without forcing a load. */
export async function hasSetting(key: string): Promise<boolean> {
  if (cache) return cache.has(key);
  const row = await queryOne<{ keyName: string }>(
    'SELECT `keyName` FROM `settings` WHERE `keyName` = ?',
    [key],
  );
  return !!row;
}
