/**
 * Runtime Drizzle client for the Postgres-backed stores.
 *
 * App/runtime queries use the **pooled** Neon endpoint via `DATABASE_URL`
 * (small app-side pool).  Migrations use the direct endpoint instead — see
 * `drizzle.config.js`.
 *
 * The client is created lazily so that importing this module never opens a
 * connection (or throws) when `DATABASE_URL` is absent — important for the many
 * server paths and tests that don't touch Postgres.  Call `getDb()` to obtain
 * the Drizzle instance, or `getPool()` for the underlying `pg` Pool.
 */

import * as schema from './schema.ts';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

/** Maximum app-side pool size; keep small since Neon pools server-side too. */
const DEFAULT_POOL_MAX = 10;

let _pool: import('pg').Pool | null = null;
let _db: import('drizzle-orm/node-postgres').NodePgDatabase<typeof schema> | null = null;

/**
 * Lazily create (or return the cached) `pg` Pool bound to `DATABASE_URL`.
 */
function getPool(): import('pg').Pool {
  if (_pool) return _pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set; cannot create Postgres pool');
  }

  _pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX) || DEFAULT_POOL_MAX,
  });
  _pool.on('error', (error) => {
    console.error('[database] unexpected idle Postgres client error:', error?.message);
  });
  return _pool;
}

/**
 * Lazily create (or return the cached) Drizzle instance.
 */
function getDb(): import('drizzle-orm/node-postgres').NodePgDatabase<typeof schema> {
  if (_db) return _db;
  _db = drizzle(getPool(), { schema });
  return _db;
}

/**
 * Close the pool and reset cached state.  Used on shutdown and in tests.
 */
async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}

export { getPool, getDb, closeDb, schema };
