/**
 * Rebuild the `conversations` projection from `messages`.
 *
 * `messages` is the single source of truth. If projection drift is ever
 * suspected, this script truncates `conversations` and reruns the exact
 * migration backfill SQL, giving the Postgres projection the escape hatch the
 * old MongoDB `conversation_index` never had.
 *
 * Usage:
 *   DATABASE_URL_DIRECT=postgres://... node scripts/rebuild-conversations.ts
 *
 * Prefer `DATABASE_URL_DIRECT` so the rebuild uses an unpooled connection. On
 * Neon, pin the compute size while this runs: the derivation scans `messages`
 * once and should not be stretched by scale-to-zero/autoscaling noise.
 *
 * The transaction takes an ACCESS EXCLUSIVE lock on `conversations` from
 * `TRUNCATE` until commit, so reads and writes to the projection are blocked
 * while the backfill runs.
 */

import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { getConversationsBackfillSql } from '../db/conversationsProjectionBackfill.ts';

type RebuildClient = {
  query: (sql: string) => Promise<unknown>;
  release: () => void;
};

type RebuildPool = {
  connect: () => Promise<RebuildClient>;
  end: () => Promise<void>;
};

export async function rebuildConversations(
  pool: RebuildPool,
  backfillSql: string = getConversationsBackfillSql()
) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE "conversations"');
    await client.query(backfillSql);
    await client.query('COMMIT');
    console.log('Rebuilt conversations projection from messages.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const rawDatabaseUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;

  if (!rawDatabaseUrl) {
    console.error('Set DATABASE_URL_DIRECT (or DATABASE_URL) before rebuilding conversations.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: rawDatabaseUrl, max: 1 });

  try {
    await rebuildConversations(pool);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
