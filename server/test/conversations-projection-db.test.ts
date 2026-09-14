/**
 * Database-backed invariants for the denormalised conversations projection.
 *
 * These tests are deliberately gated on `DATABASE_URL`: CI supplies a real
 * Postgres service, while local runs without one skip this suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import * as schema from '../db/schema.ts';
import { rebuildConversations } from '../scripts/rebuild-conversations.ts';
import {
  createMemoryMessageStore,
  createPgMessageStore,
  deriveConversationId,
} from '../src/messageStore.ts';
import { createMemoryStores } from '../src/stores/index.ts';
import { createServer } from '../src/index.ts';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'db',
  'migrations'
);

test('Postgres conversation projection invariants', { skip: !HAS_DB }, async (t) => {
  const databaseUrl = process.env.DATABASE_URL as string;
  const tmpDb = `conversations_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE DATABASE "${tmpDb}"`);

  const tmpUrl = new URL(databaseUrl);
  tmpUrl.pathname = `/${tmpDb}`;
  const pool = new Pool({ connectionString: tmpUrl.toString() });
  const db = drizzle(pool, { schema });
  const store = createPgMessageStore({ db });

  async function resetProjection() {
    await pool.query('TRUNCATE TABLE "messages", "conversations"');
  }

  async function projectionBytes() {
    const { rows } = await pool.query(
      `SELECT conversation_id, participant_a, participant_b, last_message_id,
              last_created_at, unread_a, unread_b
         FROM conversations
        ORDER BY conversation_id`
    );
    return JSON.stringify(rows);
  }

  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    await t.test('incremental maintenance is byte-identical to a rebuild', async () => {
      await resetProjection();
      const conversationId = deriveConversationId('alice', 'bob');
      await store.saveMessage({
        conversationId,
        messageId: 'm-new',
        senderId: 'alice',
        recipientId: 'bob',
        body: 'newest',
        createdAt: '2024-01-03T00:00:00.000Z',
      });
      await store.saveMessage({
        conversationId,
        messageId: 'm-reply',
        senderId: 'bob',
        recipientId: 'alice',
        body: 'reply',
        createdAt: '2024-01-02T00:00:00.000Z',
      });
      await store.saveMessage({
        conversationId,
        messageId: 'm-old',
        senderId: 'alice',
        recipientId: 'bob',
        body: 'late arrival',
        createdAt: '2024-01-01T00:00:00.000Z',
      });
      await store.saveMessage({
        conversationId,
        messageId: 'm-old',
        senderId: 'alice',
        recipientId: 'bob',
        body: 'replay',
        createdAt: '2024-01-01T00:00:00.000Z',
      });
      await store.markRead(conversationId, 'bob');

      const incremental = await projectionBytes();
      await rebuildConversations(pool);
      assert.equal(
        await projectionBytes(),
        incremental,
        'the rebuild derivation must reproduce incremental state exactly'
      );
    });

    await t.test('replay and opposite-direction sends keep one correctly counted row', async () => {
      await resetProjection();
      const conversationId = deriveConversationId('alice', 'bob');
      const original = {
        conversationId,
        messageId: 'm-1',
        senderId: 'alice',
        recipientId: 'bob',
        body: 'hello',
        createdAt: '2024-01-01T00:00:00.000Z',
      };
      await store.saveMessage(original);
      await store.saveMessage({ ...original, body: 'replayed' });
      await store.saveMessage({
        conversationId,
        messageId: 'm-2',
        senderId: 'bob',
        recipientId: 'alice',
        body: 'reply',
        createdAt: '2024-01-02T00:00:00.000Z',
      });

      const { rows } = await pool.query(
        'SELECT last_message_id, unread_a, unread_b FROM conversations'
      );
      assert.deepEqual(rows, [{ last_message_id: 'm-2', unread_a: 1, unread_b: 1 }]);
    });

    await t.test('an out-of-order send increments unread without moving the pointer', async () => {
      await resetProjection();
      const conversationId = deriveConversationId('alice', 'bob');
      await store.saveMessage({
        conversationId,
        messageId: 'newer',
        senderId: 'alice',
        recipientId: 'bob',
        body: 'newer',
        createdAt: '2024-01-02T00:00:00.000Z',
      });
      await store.saveMessage({
        conversationId,
        messageId: 'older',
        senderId: 'alice',
        recipientId: 'bob',
        body: 'older',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const { rows: [row] } = await pool.query(
        'SELECT last_message_id, unread_b FROM conversations'
      );
      assert.equal(row.last_message_id, 'newer');
      assert.equal(row.unread_b, 2);
    });

    await t.test('deleting the newest message preserves its tombstoned preview', async () => {
      await resetProjection();
      const conversationId = deriveConversationId('alice', 'bob');
      await store.saveMessage({
        conversationId,
        messageId: 'newest',
        senderId: 'alice',
        recipientId: 'bob',
        body: 'remove me',
        createdAt: '2024-01-02T00:00:00.000Z',
      });
      await store.deleteMessage(conversationId, 'newest', 'alice');

      const [summary] = await store.listConversations('bob');
      assert.equal(summary.lastMessage.messageId, 'newest');
      assert.equal(summary.lastMessage.body, '');
      assert.ok(summary.lastMessage.deletedAt);
    });

    await t.test('markRead zeroes only the reader counter', async () => {
      await resetProjection();
      const conversationId = deriveConversationId('alice', 'bob');
      await store.saveMessage({
        conversationId,
        messageId: 'for-bob',
        senderId: 'alice',
        recipientId: 'bob',
        body: 'hello',
      });
      await store.saveMessage({
        conversationId,
        messageId: 'for-alice',
        senderId: 'bob',
        recipientId: 'alice',
        body: 'reply',
      });
      await store.markRead(conversationId, 'bob');

      const { rows: [row] } = await pool.query(
        'SELECT unread_a, unread_b FROM conversations'
      );
      assert.deepEqual(row, { unread_a: 1, unread_b: 0 });
    });

    await t.test('Postgres and memory agree on cap, ties, peers, and unread counts', async () => {
      await resetProjection();
      const memory = createMemoryMessageStore();
      const count = 105;
      for (let index = 0; index < count; index += 1) {
        const input = {
          messageId: `m-${String(index).padStart(3, '0')}`,
          senderId: index % 2 === 0 ? 'alice' : `peer-${index}`,
          recipientId: index % 2 === 0 ? `peer-${index}` : 'alice',
          body: `message ${index}`,
          // Every conversation ties on time, so message_id DESC alone decides
          // which 100 survive the cap in both implementations.
          createdAt: '2024-01-01T00:00:00.000Z',
        };
        await Promise.all([store.saveMessage(input), memory.saveMessage(input)]);
      }

      assert.deepEqual(
        await store.listConversations('alice'),
        await memory.listConversations('alice')
      );
    });

    await t.test('account erasure removes every projection row naming the user', async () => {
      await resetProjection();
      await store.saveMessage({
        messageId: 'erase-me',
        senderId: 'delete-alice',
        recipientId: 'bob',
        body: 'hello',
      });
      await store.saveMessage({
        messageId: 'keep-me',
        senderId: 'carol',
        recipientId: 'dave',
        body: 'unrelated',
      });

      const stores = createMemoryStores();
      const server = createServer({
        stores,
        db,
        messageStore: store,
        accountDeletionSweepIntervalMs: 0,
      });
      t.after(() => server.shutdown());
      const now = Date.now();
      stores.accountDeletions.set('delete-alice', {
        userId: 'delete-alice',
        status: 'pending',
        requestedAt: new Date(now).toISOString(),
        scheduledFor: new Date(now).toISOString(),
        completedAt: null,
      });
      assert.equal(await server.runAccountDeletionSweep(now), 1);

      const { rows } = await pool.query(
        'SELECT conversation_id FROM conversations ORDER BY conversation_id'
      );
      assert.deepEqual(rows, [{ conversation_id: 'carol:dave' }]);
    });
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${tmpDb}"`).catch(() => {});
    await admin.end();
  }
});
