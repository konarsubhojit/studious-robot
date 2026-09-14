import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractConversationsBackfillSql,
  getConversationsBackfillSql,
} from '../db/conversationsProjectionBackfill.ts';
import { rebuildConversations } from '../scripts/rebuild-conversations.ts';

test('conversations rebuild SQL is extracted from migration 0013', () => {
  const sql = getConversationsBackfillSql();

  assert.match(sql, /^INSERT INTO "conversations"/);
  assert.match(sql, /SELECT DISTINCT ON \("conversation_id"\)/);
  assert.match(sql, /ORDER BY "conversation_id", "created_at" DESC, "message_id" DESC/);
  assert.match(sql, /WHERE "read_at" IS NULL/);
  assert.match(sql, /GROUP BY "conversation_id", "recipient_id"/);
  assert.match(sql, /LEFT JOIN "unread_counts" AS "unread_a"/);
  assert.match(sql, /LEFT JOIN "unread_counts" AS "unread_b"/);
  assert.match(
    sql,
    /LEAST\("sender_id" COLLATE "C", "recipient_id" COLLATE "C"\) AS "participant_a"/
  );
  assert.match(
    sql,
    /GREATEST\("sender_id" COLLATE "C", "recipient_id" COLLATE "C"\) AS "participant_b"/
  );
  assert.doesNotMatch(sql, /split_part|string_to_array|regexp_split_to_array/i);
});

test('conversations backfill extraction rejects missing or malformed blocks', () => {
  assert.throws(
    () => extractConversationsBackfillSql('SELECT 1;'),
    /Missing "-- conversations-backfill:start" marker/
  );
  assert.throws(
    () =>
      extractConversationsBackfillSql(
        '-- conversations-backfill:start\nSELECT 1;\n-- conversations-backfill:end'
      ),
    /must insert into conversations/
  );
});

test('rebuild script runs the shared migration backfill SQL inside one transaction', async () => {
  const queries: string[] = [];
  const released: boolean[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
    },
    release() {
      released.push(true);
    },
  };
  const pool = {
    async connect() {
      return client;
    },
    async end() {},
  };

  const backfillSql = 'INSERT INTO "conversations" SELECT injected';

  await rebuildConversations(pool, backfillSql);

  assert.deepEqual(queries, [
    'BEGIN',
    'TRUNCATE TABLE "conversations"',
    backfillSql,
    'COMMIT',
  ]);
  assert.deepEqual(released, [true]);
});
