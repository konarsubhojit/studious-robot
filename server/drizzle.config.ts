/**
 * drizzle-kit configuration.
 *
 * Schema lives in `db/schema.ts`; generated SQL migrations are written to
 * `db/migrations/`.
 *
 * Connection split (Neon): DDL/migrations MUST use the **direct (unpooled)**
 * endpoint via `DATABASE_URL_DIRECT`.  Neon's pooled endpoint runs PgBouncer in
 * transaction mode, which can't acquire the advisory locks / run some DDL that
 * migrations need.  Runtime app queries use the pooled `DATABASE_URL` instead
 * (see `db/client.ts`).
 */

// Load .env when present so local `npm run db:*` picks up DATABASE_URL_DIRECT.
// A static import is required: drizzle-kit bundles this config to CommonJS,
// where top-level `await import(...)` cannot be transformed.  Only drizzle-kit
// (a dev dependency itself) ever loads this file, so dotenv is always present.
import 'dotenv/config';

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL,
  },
};
