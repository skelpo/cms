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

/**
 * Split a SQL file into statements on top-level `;`. Quote/comment-aware so a
 * semicolon or `--` inside a string literal or `` `identifier` `` doesn't
 * corrupt the split — the old line-based splitter would truncate statements
 * like `VALUES ('a;b')` or strip `--` out of `VALUES ('a--b')`.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let inSingle = false, inDouble = false, inBacktick = false;
  let inLine = false, inBlock = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (inLine)   { if (ch === '\n') { inLine = false; buf += ch; } continue; }
    if (inBlock)  { if (ch === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inSingle) { buf += ch; if (ch === '\\') { buf += next ?? ''; i++; } else if (ch === "'") inSingle = false; continue; }
    if (inDouble) { buf += ch; if (ch === '\\') { buf += next ?? ''; i++; } else if (ch === '"') inDouble = false; continue; }
    if (inBacktick) { buf += ch; if (ch === '`') inBacktick = false; continue; }
    // Not inside a string or comment.
    if (ch === '-' && next === '-' && (sql[i + 2] === undefined || /\s/.test(sql[i + 2]!))) { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    if (ch === "'") { inSingle = true; buf += ch; continue; }
    if (ch === '"') { inDouble = true; buf += ch; continue; }
    if (ch === '`') { inBacktick = true; buf += ch; continue; }
    if (ch === ';') { const s = buf.trim(); if (s) statements.push(s); buf = ''; continue; }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}

export async function runMigrations(): Promise<{
  applied: string[];
  skipped: string[];
}> {
  await ensureMigrationsTable();

  // Serialize concurrent boots: hold a named advisory lock on ONE dedicated
  // connection for the whole run so two instances don't both apply migrations
  // (which would otherwise collide on the schemaMigrations primary key).
  return pool.withConnection(async (lockConn) => {
    const got = await lockConn.query<{ ok: number | null }>(
      "SELECT GET_LOCK('skelpo_cms_migrate', 30) AS ok",
    );
    if (Number(got.rows[0]?.ok) !== 1) {
      throw new Error('Could not acquire the migration lock within 30s (another instance may be migrating).');
    }
    try {
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

        // MySQL DDL auto-commits, so a partial failure can leave the DB
        // half-migrated; the version row is only recorded after every statement
        // in the file succeeds.
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
    } finally {
      await lockConn.query("SELECT RELEASE_LOCK('skelpo_cms_migrate')");
    }
  });
}
