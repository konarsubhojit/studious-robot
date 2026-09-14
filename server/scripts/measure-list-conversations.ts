/**
 * Throwaway measurement harness for konarsubhojit/studious-robot#391 (parent:
 * the `listConversations` projection proposal). This is deliberately NOT a
 * committed test — it seeds a scratch database with a skewed message
 * distribution, runs `EXPLAIN (ANALYZE, BUFFERS)` against the *current*
 * `listConversations` query at several history sizes, and prints the plans so
 * the growth curve can be read off and pasted into the parent issue.
 *
 * Usage:
 *   DATABASE_URL_DIRECT=postgres://... node scripts/measure-list-conversations.ts
 *
 * `DATABASE_URL_DIRECT` (falling back to `DATABASE_URL`) must be the
 * owner/direct connection: migrations 0010 and 0012 run `CREATE EXTENSION`,
 * which the pooled/runtime role may not have privileges for — the same
 * requirement `drizzle.config.ts` documents for `db:migrate`.
 *
 * If you're on Neon, pin the compute size before running this (Neon scales to
 * zero and autoscaling would make every timing noise).
 *
 * The script creates `listconv_measure_<random>`, migrates it, seeds it, runs
 * the measurements, and drops it in a `finally` — never touches app data.
 */

import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'path';

import * as schema from '../db/schema.ts';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(thisDir, '..', 'db', 'migrations');

const rawOwnerUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;

if (!rawOwnerUrl) {
  console.error(
    'Set DATABASE_URL_DIRECT (or DATABASE_URL) to a scratch-capable Postgres owner connection.'
  );
  process.exit(1);
}

/** Owner/direct connection string, narrowed to `string` once at module scope. */
const OWNER_URL: string = rawOwnerUrl;

/** The user whose conversation list we measure throughout. */
const MEASURED_USER = 'measured-user';
/** The peer on the one very active conversation. */
const HOT_PEER = 'hot-peer';
/** History sizes to measure, in ascending order — the growth curve. */
const HISTORY_SIZES = [1_000, 10_000, 100_000];
/** Sparse conversations: enough to exceed MAX_CONVERSATION_LIMIT (100). */
const SPARSE_CONVERSATION_COUNT = 300;
/** Messages per sparse conversation. */
const SPARSE_MESSAGES_PER_CONVERSATION = 5;
/** Extra users whose combined history is unrelated noise in the table. */
const BACKGROUND_USER_COUNT = 50;
const BACKGROUND_MESSAGES_PER_USER = 2_000;

function deriveConversationId(a: string, b: string): string {
  return [a, b].sort().join(':');
}

async function seedSparseConversations(pool: Pool) {
  // A handful of messages per conversation, for `SPARSE_CONVERSATION_COUNT`
  // distinct peers of the measured user — enough rows that
  // `MAX_CONVERSATION_LIMIT` (100) is exceeded and the outer `LIMIT` actually
  // has to discard candidates rather than return everything it found.
  for (let i = 0; i < SPARSE_CONVERSATION_COUNT; i++) {
    const peer = `sparse-peer-${i}`;
    const conversationId = deriveConversationId(MEASURED_USER, peer);
    await pool.query(
      `INSERT INTO messages
         (conversation_id, message_id, sender_id, recipient_id, body, type,
          reactions, delivered_to, read_at, created_at)
       SELECT
         $1,
         gen_random_uuid()::text,
         CASE WHEN g % 2 = 0 THEN $2 ELSE $3 END,
         CASE WHEN g % 2 = 0 THEN $3 ELSE $2 END,
         'sparse message ' || g,
         'text',
         '{}'::jsonb,
         '{}'::text[],
         -- every third message unread, to give the measured user *some*
         -- unread backlog outside the hot conversation too.
         CASE WHEN g % 3 = 0 THEN NULL ELSE now() END,
         now() - (g || ' minutes')::interval
       FROM generate_series(1, $4) AS g`,
      [conversationId, MEASURED_USER, peer, SPARSE_MESSAGES_PER_CONVERSATION]
    );
  }
}

async function seedBackgroundNoise(pool: Pool) {
  // Unrelated users' history: makes `idx_messages_recipient_created` and the
  // trigram indexes carry realistic total volume, so the measured user's plan
  // isn't reading indexes that only ever contained their own rows.
  for (let i = 0; i < BACKGROUND_USER_COUNT; i++) {
    const a = `bg-user-${i}-a`;
    const b = `bg-user-${i}-b`;
    const conversationId = deriveConversationId(a, b);
    await pool.query(
      `INSERT INTO messages
         (conversation_id, message_id, sender_id, recipient_id, body, type,
          reactions, delivered_to, read_at, created_at)
       SELECT
         $1,
         gen_random_uuid()::text,
         CASE WHEN g % 2 = 0 THEN $2 ELSE $3 END,
         CASE WHEN g % 2 = 0 THEN $3 ELSE $2 END,
         'background message ' || g,
         'text',
         '{}'::jsonb,
         '{}'::text[],
         now(),
         now() - (g || ' seconds')::interval
       FROM generate_series(1, $4) AS g`,
      [conversationId, a, b, BACKGROUND_MESSAGES_PER_USER]
    );
  }
}

/**
 * Top the hot conversation (measured user <-> hot peer) up to `targetTotal`
 * messages, with a substantial unread backlog for the measured user (every
 * other message arrives unread, mimicking a user who doesn't keep up).
 */
async function growHotConversation(pool: Pool, alreadySeeded: number, targetTotal: number) {
  const toAdd = targetTotal - alreadySeeded;
  if (toAdd <= 0) return;
  const conversationId = deriveConversationId(MEASURED_USER, HOT_PEER);
  await pool.query(
    `INSERT INTO messages
       (conversation_id, message_id, sender_id, recipient_id, body, type,
        reactions, delivered_to, read_at, created_at)
     SELECT
       $1,
       gen_random_uuid()::text,
       CASE WHEN (g + $4) % 2 = 0 THEN $2 ELSE $3 END,
       CASE WHEN (g + $4) % 2 = 0 THEN $3 ELSE $2 END,
       'hot conversation message ' || (g + $4),
       'text',
       '{}'::jsonb,
       '{}'::text[],
       -- unread when the recipient is the measured user: since recipient is
       -- MEASURED_USER exactly when (g + $4) is odd (per the CASE above),
       -- that parity alone is sufficient. Offsetting by alreadySeeded keeps
       -- the read/unread oscillation continuous across growth phases instead
       -- of restarting it every time this function is called again, so the
       -- backlog stays a stable, large, permanent fraction of the total.
       CASE WHEN (g + $4) % 2 = 1 THEN NULL ELSE now() END,
       now() - (g || ' seconds')::interval
     FROM generate_series(1, $5) AS g`,
    [conversationId, HOT_PEER, MEASURED_USER, alreadySeeded, toAdd]
  );
}

/**
 * Raw SQL mirroring exactly what Drizzle renders for
 * `createPgMessageStore().listConversations` (verified against `.toSQL()` for
 * the query in `src/messageStore/pgStore.ts`). Deliberately **not** rewritten
 * as CTEs: the real query builds `last_messages` and `unread_counts` as inline
 * derived-table subqueries, and whether Postgres materialises them before the
 * outer `LIMIT` is exactly one of the open questions this harness answers —
 * so the SQL under test has to be the actual shape, not an equivalent one.
 */
const LIST_CONVERSATIONS_SQL = `
  SELECT last_messages.conversation_id, last_messages.message_id, last_messages.sender_id,
         last_messages.recipient_id, last_messages.body, last_messages.type,
         last_messages.attachment, last_messages.reply_to, last_messages.reactions,
         last_messages.delivered_to, last_messages.read_at, last_messages.deleted_at,
         last_messages.created_at, unread_counts.unread_count
  FROM (
    SELECT DISTINCT ON (messages.conversation_id)
      conversation_id, message_id, sender_id, recipient_id, body, type, attachment,
      reply_to, reactions, delivered_to, read_at, deleted_at, created_at
    FROM messages
    WHERE (messages.sender_id = $1 OR messages.recipient_id = $1)
    ORDER BY messages.conversation_id ASC, messages.created_at DESC, messages.message_id DESC
  ) last_messages
  LEFT JOIN (
    SELECT conversation_id, count(*)::int AS unread_count
    FROM messages
    WHERE (messages.recipient_id = $1 AND messages.read_at IS NULL)
    GROUP BY messages.conversation_id
  ) unread_counts ON last_messages.conversation_id = unread_counts.conversation_id
  ORDER BY last_messages.created_at DESC, last_messages.message_id DESC
  LIMIT 100
`;

/**
 * The `unreadCounts` half in isolation, so its cost can be attributed
 * separately from the `last_messages` half and the join/limit above it.
 */
const UNREAD_COUNTS_SQL = `
  SELECT conversation_id, count(*)::int AS unread_count
  FROM messages
  WHERE recipient_id = $1 AND read_at IS NULL
  GROUP BY conversation_id
`;

async function explain(pool: Pool, label: string, sqlText: string, params: unknown[]) {
  const { rows } = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sqlText}`,
    params
  );
  const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
  console.log(`\n===== ${label} =====`);
  console.log(plan);
  return plan;
}

async function main() {
  const tmpDb = `listconv_measure_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  // `tmpDb` is always our own `[a-z0-9_]` literal, never external input, but
  // asserting the shape before it's interpolated into DDL (identifiers can't
  // be bound as query parameters) keeps that invariant enforced rather than
  // just assumed.
  if (!/^[a-z0-9_]+$/.test(tmpDb)) {
    throw new Error(`Unexpected scratch database name: ${tmpDb}`);
  }
  const ownerUrl = new URL(OWNER_URL);
  const admin = new Pool({ connectionString: OWNER_URL });

  try {
    console.log(`Creating scratch database ${tmpDb}...`);
    await admin.query(`CREATE DATABASE "${tmpDb}"`);

    const tmpUrl = new URL(ownerUrl.toString());
    tmpUrl.pathname = `/${tmpDb}`;
    const pool = new Pool({ connectionString: tmpUrl.toString() });

    try {
      const db = drizzle(pool, { schema });
      console.log('Applying migrations...');
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      console.log('Seeding sparse conversations (exceeds MAX_CONVERSATION_LIMIT)...');
      await seedSparseConversations(pool);

      console.log('Seeding background noise from unrelated users...');
      await seedBackgroundNoise(pool);

      let seededHotMessages = 0;
      for (const targetSize of HISTORY_SIZES) {
        console.log(`\nGrowing hot conversation to ${targetSize} messages...`);
        await growHotConversation(pool, seededHotMessages, targetSize);
        seededHotMessages = targetSize;

        // Refresh planner statistics: without this, a freshly bulk-loaded
        // table still carries the old (or default) row-count estimate and the
        // plan reflects that stale estimate rather than the data actually
        // seeded.
        await pool.query('VACUUM ANALYZE messages');

        await explain(
          pool,
          `listConversations @ ${targetSize} hot messages`,
          LIST_CONVERSATIONS_SQL,
          [MEASURED_USER]
        );
        await explain(
          pool,
          `unreadCounts alone @ ${targetSize} hot messages`,
          UNREAD_COUNTS_SQL,
          [MEASURED_USER]
        );
      }

      const { rows: countRows } = await pool.query('SELECT count(*)::int AS n FROM messages');
      console.log(`\nTotal rows in messages table at end of run: ${countRows[0].n}`);
    } finally {
      await pool.end();
      // Only reached once CREATE DATABASE above succeeded, so the database
      // exists and there's something to drop; logged rather than swallowed so
      // a failed cleanup (e.g. a lingering connection holding it open) leaves
      // a visible trail instead of a silently orphaned scratch database.
      await admin
        .query(`DROP DATABASE IF EXISTS "${tmpDb}"`)
        .catch((err) => console.error(`Failed to drop scratch database ${tmpDb}:`, err));
    }
  } finally {
    await admin.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
