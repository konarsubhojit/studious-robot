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
import { describeSqlStatement, sqlTextOf, timeQuery } from '../src/lib/queryTiming.ts';

/** Maximum app-side pool size; keep small since Neon pools server-side too. */
const DEFAULT_POOL_MAX = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** Marks an already-wrapped pool/client, see {@link instrumentQuery}. */
const INSTRUMENTED = Symbol('queryTimingInstrumented');

/**
 * Wrap a `query` method so every statement it runs is timed.
 *
 * Instrumenting the pool (and each checked-out client) rather than the
 * individual call sites means every statement Drizzle generates — including
 * ones added later, and the ones issued inside a transaction — is measured,
 * without touching a single query.
 *
 * `pg`'s `query()` supports both a promise and a callback form; only the
 * promise form is used in this codebase, so a callback call is passed straight
 * through untimed rather than being wrapped incorrectly.
 */
function instrumentQuery<T extends { query: Function }>(target: T): T {
  // Pooled clients are checked out repeatedly; wrapping one twice would nest
  // the timers and double-count every statement it runs.
  if ((target as Record<PropertyKey, unknown>)[INSTRUMENTED]) return target;
  (target as Record<PropertyKey, unknown>)[INSTRUMENTED] = true;

  const original = target.query.bind(target);
  target.query = function timedQuery(this: unknown, ...args: unknown[]) {
    if (typeof args[args.length - 1] === 'function') {
      return original(...args);
    }
    const { operation, kind, target: table } = describeSqlStatement(sqlTextOf(args[0]));
    return timeQuery({ backend: 'pg', operation, kind, target: table }, () => original(...args));
  } as T['query'];
  return target;
}

/**
 * The Drizzle handle every server module talks to.
 *
 * Injected into `createServer()` (and from there onto the server state), so it
 * is the type that guards the composition root: the query builder is bound to
 * this project's schema, which makes a misspelled column, a value of the wrong
 * type or a table that does not exist a compile error rather than a runtime
 * one.  Test doubles implement only the subset of the surface the case
 * exercises and are asserted once, at the injection point.
 */
export type Database = import('drizzle-orm/node-postgres').NodePgDatabase<typeof schema>;

let _pool: import('pg').Pool | null = null;
let _db: Database | null = null;

/**
 * Lazily create (or return the cached) `pg` Pool bound to `DATABASE_URL`.
 */
function getPool(): import('pg').Pool {
  if (_pool) return _pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set; cannot create Postgres pool');
  }

  const configuredPoolSize = Number(process.env.DB_POOL_SIZE ?? process.env.DATABASE_POOL_MAX);
  const poolMax =
    Number.isSafeInteger(configuredPoolSize) && configuredPoolSize > 0
      ? configuredPoolSize
      : DEFAULT_POOL_MAX;
  const configuredIdleTimeout = Number(process.env.DATABASE_POOL_IDLE_TIMEOUT_MS);
  const idleTimeoutMillis =
    Number.isSafeInteger(configuredIdleTimeout) && configuredIdleTimeout > 0
      ? configuredIdleTimeout
      : DEFAULT_IDLE_TIMEOUT_MS;

  _pool = new Pool({
    connectionString,
    max: poolMax,
    idleTimeoutMillis,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  _pool.on('error', (error) => {
    console.error('[database] unexpected idle Postgres client error:', error?.message);
  });

  instrumentQuery(_pool);

  // A statement run on a checked-out client (transactions, `LISTEN`) never
  // passes through `pool.query`, so instrument the client on the way out.
  const connect = _pool.connect.bind(_pool);
  _pool.connect = function timedConnect(this: unknown, ...args: unknown[]) {
    if (typeof args[0] === 'function') {
      return (connect as Function)(...args);
    }
    return (connect as Function)(...args).then((client: { query: Function }) =>
      instrumentQuery(client)
    );
  } as typeof _pool.connect;

  return _pool;
}

/**
 * Lazily create (or return the cached) Drizzle instance.
 */
function getDb(): Database {
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
