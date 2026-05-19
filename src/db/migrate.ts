// Migration runner.
//
// Applies migrations/*.sql files in lexical order. Tracks applied versions
// in `schemaMigrations` with a sha256 checksum. Refuses to re-apply a
// previously-applied migration if its contents changed (protects against
// accidental edits of frozen migration files).
//
// The schemaMigrations table is created on demand if missing — bootstrap
// case handled inline.

import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pool } from './client.js';

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS \`schemaMigrations\` (
      \`version\`    VARCHAR(64)  NOT NULL,
      \`appliedAt\`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`checksum\`   CHAR(64)     NOT NULL,
      PRIMARY KEY (\`version\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}

interface Applied {
  version: string;
  checksum: string;
}

async function loadApplied(): Promise<Map<string, string>> {
  const result = await pool.query<Applied>(
    'SELECT `version`, `checksum` FROM `schemaMigrations`',
  );
  const m = new Map<string, string>();
  for (const r of result.rows) m.set(r.version, r.checksum);
  return m;
}

interface MigrationFile {
  version: string;
  path: string;
  sql: string;
  checksum: string;
}

async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files: MigrationFile[] = [];
  for (const e of entries) {
    if (!e.endsWith('.sql')) continue;
    const version = e.replace(/\.sql$/, '');
    const path = join(MIGRATIONS_DIR, e);
    const sql = await readFile(path, 'utf8');
    files.push({ version, path, sql, checksum: sha256(sql) });
  }
  files.sort((a, b) => a.version.localeCompare(b.version));
  return files;
}

/** Split a SQL file into statements. Naive — splits on `;` at line end. */
function splitStatements(sql: string): string[] {
  // Strip line comments to avoid stray semicolons inside them.
  const cleaned = sql
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .join('\n');
  return cleaned
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

export async function runMigrations(): Promise<{
  applied: string[];
  skipped: string[];
}> {
  await ensureMigrationsTable();
  const applied = await loadApplied();
  const files = await loadMigrationFiles();

  const newlyApplied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const recordedChecksum = applied.get(file.version);
    if (recordedChecksum !== undefined) {
      if (recordedChecksum !== file.checksum) {
        throw new Error(
          `Migration ${file.version} was previously applied with a different checksum. ` +
            `Recorded: ${recordedChecksum.slice(0, 8)}…  Current: ${file.checksum.slice(0, 8)}…  ` +
            `Migrations are immutable once applied — restore the original file or create a new migration.`,
        );
      }
      skipped.push(file.version);
      continue;
    }

    // Apply statements sequentially. Each migration runs as a single
    // logical unit; MySQL DDL statements auto-commit so a partial failure
    // can leave the DB half-migrated. The version row is only inserted
    // after every statement succeeds.
    const statements = splitStatements(file.sql);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
    await pool.query(
      'INSERT INTO `schemaMigrations` (`version`, `checksum`) VALUES (?, ?)',
      [file.version, file.checksum],
    );
    newlyApplied.push(file.version);
  }

  return { applied: newlyApplied, skipped };
}
