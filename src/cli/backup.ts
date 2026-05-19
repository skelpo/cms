// Single-file backup/restore. A .skelpo-backup is gzipped JSON:
//   { version, createdAt, tables: {name: rows[]}, media: {key: base64} }
// Adequate for the single-tenant agency-site scale this CMS targets
// (the schema doc estimates ~100 MB/yr for a busy small-business site).
// Large-scale streaming backup is a v0.2 concern.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { pool } from '../db/client.js';
import { config } from '../config.js';

const TABLES = [
  'roles', 'users', 'apiTokens', 'passwordResets', 'loginAttempts',
  'contentTypes', 'contentTypeRevisions', 'content', 'contentRelations',
  'contentRevisions', 'media', 'menus', 'menuItems', 'settings', 'redirects',
  'formSubmissions', 'emailTemplates', 'jobs', 'webhooks', 'webhookDeliveries',
  'auditLog', 'analyticsEvents', 'schemaMigrations',
];

interface BackupFile {
  version: 1;
  createdAt: string;
  tables: Record<string, Record<string, unknown>[]>;
  media: Record<string, string>; // storageKey -> base64
}

// @perryts/mysql returns DATETIME/TIMESTAMP columns as structured
// MyDateTime objects ({year,month,day,...,raw}). JSON-stringifying those
// and re-inserting into a TIMESTAMP column fails, so we flatten them to
// their `raw` 'YYYY-MM-DD HH:MM:SS' string at backup time. Genuine JSON
// columns (objects WITHOUT a year+month+day+raw shape) are left intact.
function isMyDateTime(v: unknown): v is { raw: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    'raw' in v &&
    'year' in v &&
    'month' in v &&
    'day' in v &&
    typeof (v as { raw: unknown }).raw === 'string'
  );
}
function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = isMyDateTime(v) ? v.raw : v;
  }
  return out;
}

export async function createBackup(outPath: string): Promise<{ tables: number; mediaFiles: number; bytes: number }> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES) {
    const res = await pool.query(`SELECT * FROM \`${t}\``);
    tables[t] = (res.rows as Record<string, unknown>[]).map(flattenRow);
  }
  const media: Record<string, string> = {};
  for (const row of tables.media ?? []) {
    const key = String((row as { storageKey?: string }).storageKey ?? '');
    if (!key) continue;
    try {
      const buf = await readFile(join(config.media.localPath, key));
      media[key] = buf.toString('base64');
    } catch {
      /* file missing — skip, metadata still backed up */
    }
  }
  const payload: BackupFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    tables,
    media,
  };
  const gz = gzipSync(Buffer.from(JSON.stringify(payload)));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, gz);
  return {
    tables: Object.keys(tables).length,
    mediaFiles: Object.keys(media).length,
    bytes: gz.length,
  };
}

export async function restoreBackup(inPath: string): Promise<{ tables: number; rows: number; mediaFiles: number }> {
  const gz = await readFile(inPath);
  const payload = JSON.parse(gunzipSync(gz).toString('utf8')) as BackupFile;
  if (payload.version !== 1) throw new Error(`unsupported backup version: ${payload.version}`);

  // Discover JSON columns so we re-encode ALL values bound for them —
  // not just objects. The driver returns JSON columns parsed, so a stored
  // `""` comes back as the JS string '' which is NOT valid JSON on insert.
  const jsonColsRes = await pool.query<{ TABLE_NAME: string; COLUMN_NAME: string }>(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'json'`,
  );
  const jsonCols = new Map<string, Set<string>>();
  for (const r of jsonColsRes.rows) {
    let s = jsonCols.get(r.TABLE_NAME);
    if (!s) { s = new Set(); jsonCols.set(r.TABLE_NAME, s); }
    s.add(r.COLUMN_NAME);
  }

  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  let rowCount = 0;
  try {
    // DELETE (not TRUNCATE): MySQL rejects TRUNCATE on any table that's
    // the target of a FK from another table, even with FK checks off.
    // Rows are inserted with their original ids; we then realign each
    // table's AUTO_INCREMENT past MAX(id) so future inserts don't collide.
    for (const t of [...TABLES].reverse()) {
      await pool.query(`DELETE FROM \`${t}\``);
    }
    for (const t of TABLES) {
      const rows = payload.tables[t];
      if (!rows || rows.length === 0) continue;
      const tableJsonCols = jsonCols.get(t) ?? new Set<string>();
      for (const row of rows) {
        const cols = Object.keys(row);
        if (cols.length === 0) continue;
        const placeholders = cols.map(() => '?').join(',');
        const vals = cols.map((c) => {
          const v = (row as Record<string, unknown>)[c];
          // JSON columns: always re-encode (incl. '', numbers, null →
          // 'null') so the value is a valid JSON document on insert.
          if (tableJsonCols.has(c)) return JSON.stringify(v ?? null);
          return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
        });
        await pool.query(
          `INSERT INTO \`${t}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${placeholders})`,
          vals,
        );
        rowCount++;
      }
      // Realign AUTO_INCREMENT if this table has a numeric `id`.
      if (rows[0] && 'id' in rows[0]) {
        const maxId = rows.reduce((m, r) => {
          const v = Number((r as { id?: unknown }).id);
          return Number.isFinite(v) && v > m ? v : m;
        }, 0);
        await pool.query(`ALTER TABLE \`${t}\` AUTO_INCREMENT = ${maxId + 1}`);
      }
    }
  } finally {
    await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  // Restore media files.
  let mediaFiles = 0;
  for (const [key, b64] of Object.entries(payload.media)) {
    const abs = join(config.media.localPath, key);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from(b64, 'base64'));
    mediaFiles++;
  }
  return { tables: Object.keys(payload.tables).length, rows: rowCount, mediaFiles };
}

// ── Schema export / import (content types + roles + email templates) ────

export async function exportSchema(): Promise<string> {
  const [types, roles, templates] = await Promise.all([
    pool.query('SELECT `slug`,`labelSingular`,`labelPlural`,`isRoutable`,`urlPattern`,`fieldsSchema`,`icon` FROM `contentTypes`'),
    pool.query('SELECT `slug`,`label`,`capabilities`,`isBuiltin` FROM `roles`'),
    pool.query('SELECT `slug`,`locale`,`subject`,`bodyHtml`,`bodyText` FROM `emailTemplates`'),
  ]);
  return JSON.stringify(
    { version: 1, contentTypes: types.rows, roles: roles.rows, emailTemplates: templates.rows },
    null,
    2,
  );
}

export async function importSchema(json: string): Promise<{ types: number; roles: number }> {
  const data = JSON.parse(json) as {
    contentTypes?: Record<string, unknown>[];
    roles?: Record<string, unknown>[];
  };
  let types = 0;
  let roles = 0;
  for (const t of data.contentTypes ?? []) {
    const fs = typeof t.fieldsSchema === 'object' ? JSON.stringify(t.fieldsSchema) : String(t.fieldsSchema);
    await pool.query(
      `INSERT INTO \`contentTypes\` (\`slug\`,\`labelSingular\`,\`labelPlural\`,\`isRoutable\`,\`urlPattern\`,\`fieldsSchema\`,\`icon\`,\`currentRevision\`)
       VALUES (?,?,?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE \`fieldsSchema\`=VALUES(\`fieldsSchema\`),\`labelSingular\`=VALUES(\`labelSingular\`),\`labelPlural\`=VALUES(\`labelPlural\`)`,
      [t.slug, t.labelSingular, t.labelPlural, t.isRoutable ?? 1, t.urlPattern ?? null, fs, t.icon ?? null],
    );
    types++;
  }
  for (const r of data.roles ?? []) {
    const caps = typeof r.capabilities === 'object' ? JSON.stringify(r.capabilities) : String(r.capabilities);
    await pool.query(
      `INSERT INTO \`roles\` (\`slug\`,\`label\`,\`capabilities\`,\`isBuiltin\`)
       VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE \`label\`=VALUES(\`label\`),\`capabilities\`=VALUES(\`capabilities\`)`,
      [r.slug, r.label, caps, r.isBuiltin ?? 0],
    );
    roles++;
  }
  return { types, roles };
}

// ── types-codegen: emit TS interfaces from content type schemas ────────

const TS_FIELD: Record<string, string> = {
  text: 'string', textarea: 'string', richtext: 'unknown', email: 'string',
  url: 'string', color: 'string', number: 'number', boolean: 'boolean',
  date: 'string', datetime: 'string', select: 'string', multiselect: 'string[]',
  image: 'number', file: 'number', gallery: 'number[]', relation: 'number[]',
  repeater: 'Record<string, unknown>[]', json: 'unknown',
};

export async function generateTypes(): Promise<string> {
  const res = await pool.query<{ slug: string; fieldsSchema: string | { fields: { name: string; type: string; required?: boolean }[] } }>(
    'SELECT `slug`,`fieldsSchema` FROM `contentTypes` ORDER BY `slug`',
  );
  const out: string[] = [
    '// AUTO-GENERATED by `skelpo-cms types-codegen`. Do not edit by hand.',
    '// Regenerate after content-type schema changes.',
    '',
  ];
  for (const row of res.rows) {
    const schema =
      typeof row.fieldsSchema === 'string' ? JSON.parse(row.fieldsSchema) : row.fieldsSchema;
    const iface = row.slug.charAt(0).toUpperCase() + row.slug.slice(1);
    out.push(`export interface ${iface}Fields {`);
    for (const f of schema.fields ?? []) {
      const ts = TS_FIELD[f.type] ?? 'unknown';
      out.push(`  ${f.name}${f.required ? '' : '?'}: ${ts};`);
    }
    out.push('}', '');
  }
  return out.join('\n');
}
