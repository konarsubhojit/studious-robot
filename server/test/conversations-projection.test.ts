import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

import {
  extractConversationsBackfillSql,
  getConversationsBackfillSql,
} from '../db/conversationsProjectionBackfill.ts';

test('conversations rebuild SQL is extracted from migration 0013', () => {
  const sql = getConversationsBackfillSql();

  assert.match(sql, /^INSERT INTO "conversations"/);
  assert.match(sql, /SELECT DISTINCT ON \("conversation_id"\)/);
  assert.match(sql, /ORDER BY "conversation_id", "created_at" DESC, "message_id" DESC/);
  assert.match(sql, /WHERE "read_at" IS NULL/);
  assert.match(sql, /GROUP BY "conversation_id", "recipient_id"/);
  assert.match(sql, /LEAST\("sender_id", "recipient_id"\) AS "participant_a"/);
  assert.match(sql, /GREATEST\("sender_id", "recipient_id"\) AS "participant_b"/);
  assert.doesNotMatch(sql, /split_part|string_to_array|regexp_split_to_array/i);
});

test('conversations backfill extraction rejects missing or malformed blocks', () => {
  assert.throws(
    () => extractConversationsBackfillSql('SELECT 1;'),
    /Could not find conversations backfill block/
  );
  assert.throws(
    () =>
      extractConversationsBackfillSql(
        '-- conversations-backfill:start\nSELECT 1;\n-- conversations-backfill:end'
      ),
    /must insert into conversations/
  );
});

test('rebuild script uses the shared migration backfill extractor', () => {
  const script = readFileSync(
    new URL('../scripts/rebuild-conversations.ts', import.meta.url),
    'utf8'
  );

  assert.match(script, /getConversationsBackfillSql/);
});
