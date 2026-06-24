'use strict';

/**
 * drizzle-kit configuration.
 *
 * Schema lives in `db/schema.js`; generated SQL migrations are written to
 * `db/migrations/`.
 *
 * Connection split (Neon): DDL/migrations MUST use the **direct (unpooled)**
 * endpoint via `DATABASE_URL_DIRECT`.  Neon's pooled endpoint runs PgBouncer in
 * transaction mode, which can't acquire the advisory locks / run some DDL that
 * migrations need.  Runtime app queries use the pooled `DATABASE_URL` instead
 * (see `db/client.js`).
 */

// Load .env when present so local `npm run db:*` picks up DATABASE_URL_DIRECT.
// dotenv is a dev dependency; ignore if it isn't installed (e.g. prod runtime).
try {
  require('dotenv').config();
} catch {
  /* dotenv optional */
}

/** @type {import('drizzle-kit').Config} */
module.exports = {
  schema: './db/schema.js',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL,
  },
};
