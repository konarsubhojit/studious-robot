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
// dotenv is a dev dependency; ignore if it isn't installed (e.g. prod runtime).
try {
  const dotenv = await import('dotenv');
  dotenv.default.config();
} catch {
  /* dotenv optional */
}

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL,
  },
};
