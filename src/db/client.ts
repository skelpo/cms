// MySQL connection pool via @perryts/mysql.
//
// Single shared Pool. Hot path uses pool.query() directly; for transactions
// or multi-statement work, use pool.withConnection(cb) / pool.transaction(cb).
//
// @perryts/mysql returns QueryResult = { rows, rowsArray, rowsRaw, fields,
// command, rowCount, lastInsertId, warningCount }. We expose helpers that
// return rows directly to keep call sites tidy.

import { createPool, type Pool, type SqlQuery } from '@perryts/mysql';
import { config } from '../config.js';

export const pool: Pool = createPool({
  host:               config.db.host,
  port:               config.db.port,
  user:               config.db.user,
  password:           config.db.password,
  database:           config.db.database,
  max:                20,
  idleTimeoutMs:      30_000,
  acquireTimeoutMs:   30_000,
  connectTimeoutMs:   10_000,
  charset:            255, // utf8mb4_0900_ai_ci
  ssl:                config.db.ssl ? { mode: 'verify-full' } : undefined,
  multipleStatements: false,
  localInfile:        'refuse',
});

/** Run a query, return only the rows array. The common case. */
export async function query<T = Record<string, unknown>>(
  sql: string | SqlQuery,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

/** Run a query, return the first row or null. */
export async function queryOne<T = Record<string, unknown>>(
  sql: string | SqlQuery,
  params?: unknown[],
): Promise<T | null> {
  const result = await pool.query<T>(sql, params);
  return result.rows[0] ?? null;
}

/** Run a write, return affected rows + lastInsertId. */
export async function execute(
  sql: string | SqlQuery,
  params?: unknown[],
): Promise<{ affectedRows: number; insertId: number | bigint }> {
  const result = await pool.query(sql, params);
  return { affectedRows: result.rowCount, insertId: result.lastInsertId };
}

/** Close the pool. Called on graceful shutdown. */
export async function closeDb(): Promise<void> {
  await pool.end();
}

/** Liveness check: simple SELECT 1. Used by /healthz. */
export async function ping(): Promise<boolean> {
  try {
    await pool.query('SELECT 1 AS ok');
    return true;
  } catch {
    return false;
  }
}
