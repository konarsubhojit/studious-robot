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
 */

import { Pool } from 'pg';

import { getConversationsBackfillSql } from '../db/conversationsProjectionBackfill.ts';

const rawDatabaseUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;

if (!rawDatabaseUrl) {
  console.error('Set DATABASE_URL_DIRECT (or DATABASE_URL) before rebuilding conversations.');
  process.exit(1);
}

const DATABASE_URL: string = rawDatabaseUrl;

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });

  try {
    await pool.query('BEGIN');
    await pool.query('TRUNCATE TABLE "conversations"');
    await pool.query(getConversationsBackfillSql());
    await pool.query('COMMIT');
    console.log('Rebuilt conversations projection from messages.');
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await pool.end();
  }
}

await main();

