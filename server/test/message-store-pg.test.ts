/**
 * Tests for the Postgres message store (`src/messageStore/pgStore.ts`).
 *
 * The store is driven through a real Drizzle handle bound to a recording fake
 * `pg` client, so what is asserted is the *SQL actually issued* — not a hand-
 * rolled builder double that would happily agree with a query the database
 * would reject. That matters here because the store's whole reason to exist is
 * that it pushes work into the database: if `listConversations` silently stops
 * emitting `DISTINCT ON`, or the search predicate stops matching the shape of
 * the trigram index, the queries still *run* and still return plausible rows —
 * they just do so by scanning the table. Only the statement text catches that.
 *
 * Behaviour that is identical across backends (page bounds, reaction merging,
 * tombstones, conversation grouping) is covered once, over plain data, in
 * `message-store-internals.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';

import * as schema from '../db/schema.ts';
import { createPgMessageStore } from '../src/messageStore/pgStore.ts';
import type { StoredMessage } from '../src/messageStore/types.ts';

/** One statement as the driver received it. */
type RecordedQuery = { text: string; params: unknown[]; };

/**
 * Column order used when a fake result row is built.
 *
 * Drizzle asks the driver for `rowMode: 'array'`, so a result row is a
 * positional tuple rather than an object. Every query in the store selects the
 * full column list in table order (`select()` expands to it, and the explicit
 * list in `listConversations` mirrors it), so one ordering serves them all.
 */
const MESSAGE_COLUMNS = [
  'conversationId',
  'messageId',
  'senderId',
  'recipientId',
  'body',
  'type',
  'attachment',
  'replyTo',
  'reactions',
  'deliveredTo',
  'readAt',
  'deletedAt',
  'createdAt',
] as const;

/** A complete message row, with only the fields a case cares about overridden. */
function messageRow(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    conversationId: 'alice:bob',
    messageId: 'm-1',
    senderId: 'alice',
    recipientId: 'bob',
    body: 'hello',
    type: 'text',
    attachment: null,
    replyTo: null,
    reactions: {},
    deliveredTo: [],
    readAt: null,
    deletedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Turn a message into the positional tuple the driver would return. */
function toTuple(message: StoredMessage, ...extra: unknown[]): unknown[] {
  return [...MESSAGE_COLUMNS.map((column) => message[column]), ...extra];
}

/**
 * Build a store over a fake driver that records every statement and replays a
 * scripted result for each.
 *
 * @param results - One entry per statement, in order; missing entries yield no
 *   rows, which is what an unmatched query returns anyway.
 */
function createRecordingStore(results: unknown[][][] = []) {
  const queries: RecordedQuery[] = [];
  const client = {
    async query(config: { text: string; }, params: unknown[]) {
      queries.push({ text: config.text, params: params ?? [] });
      const rows = results[queries.length - 1] ?? [];
      return { rows, fields: [], rowCount: rows.length };
    },
  };
  const db = drizzle(client as never, { schema });
  return { store: createPgMessageStore({ db }), queries };
}

// ─── listMessages ─────────────────────────────────────────────────────────────

test('listMessages pages one conversation backwards along the covering index', async () => {
  const { store, queries } = createRecordingStore([[toTuple(messageRow())]]);

  const page = await store.listMessages({
    conversationId: 'alice:bob',
    limit: 10,
    before: '2024-02-01T00:00:00.000Z',
  });

  const [query] = queries;
  // The ordering must match `idx_messages_conversation_created`
  // (conversation_id, created_at desc, message_id desc) exactly, or Postgres
  // has to sort the whole conversation to answer a single page.
  assert.match(query.text, /order by "messages"\."created_at" desc, "messages"\."message_id" desc/);
  assert.match(query.text, /"messages"\."created_at" < \$/);
  assert.deepEqual(query.params, ['alice:bob', '2024-02-01T00:00:00.000Z', 10]);
  assert.equal(page.length, 1);
  assert.equal(page[0].messageId, 'm-1');
});

test('listMessages without a conversation id never reaches the database', async () => {
  const { store, queries } = createRecordingStore();

  assert.deepEqual(await store.listMessages({}), []);
  assert.deepEqual(await store.listMessages(), []);
  // An unscoped read of every message on the instance is not a sensible
  // fallback, so the missing argument short-circuits instead.
  assert.equal(queries.length, 0);
});

test('listMessages clamps the page size rather than trusting the caller', async () => {
  const { store, queries } = createRecordingStore();

  await store.listMessages({ conversationId: 'alice:bob', limit: 10_000 });

  assert.equal(queries[0].params.at(-1), 100);
});

// ─── searchMessages ───────────────────────────────────────────────────────────

test('searchMessages matches the trigram index and escapes the user term', async () => {
  const { store, queries } = createRecordingStore([[toTuple(messageRow({ body: 'save 100%' }))]]);

  const hits = await store.searchMessages({ userId: 'alice', query: '  100%  ', limit: 5 });

  const [query] = queries;
  // `lower(body) like …` is the expression `idx_messages_body_trgm` indexes;
  // any other formulation (ILIKE on the raw column, a regex) cannot use it.
  assert.match(query.text, /lower\("messages"\."body"\) like \$\d+ escape '\\'/);
  assert.match(query.text, /"messages"\."sender_id" = \$\d+ or "messages"\."recipient_id" = \$\d+/);
  // The `%` the user typed is escaped, so it matches a literal percent sign
  // instead of every message the caller can see.
  assert.deepEqual(query.params, ['alice', 'alice', '%100\\%%', 5]);
  assert.equal(hits.length, 1);
});

test('searchMessages needs both a term and a caller before it queries', async () => {
  const { store, queries } = createRecordingStore();

  assert.deepEqual(await store.searchMessages({ userId: 'alice', query: '   ' }), []);
  assert.deepEqual(await store.searchMessages({ query: 'lunch' }), []);
  assert.deepEqual(await store.searchMessages(), []);
  assert.equal(queries.length, 0);
});

// ─── listConversations ────────────────────────────────────────────────────────

test('listConversations resolves the whole summary in one statement', async () => {
  const { store, queries } = createRecordingStore([
    [
      toTuple(messageRow({ conversationId: 'alice:bob', senderId: 'bob', recipientId: 'alice' }), 3),
      toTuple(
        messageRow({
          conversationId: 'alice:carol',
          messageId: 'm-2',
          recipientId: 'carol',
          createdAt: '2023-12-01T00:00:00.000Z',
        }),
        null
      ),
    ],
  ]);

  const conversations = await store.listConversations('alice');

  assert.equal(queries.length, 1, 'a conversation list must not fan out into per-conversation reads');
  const [query] = queries;
  assert.match(query.text, /select distinct on \("messages"\."conversation_id"\)/);
  assert.match(query.text, /count\(\*\)::int/);
  assert.match(query.text, /"messages"\."read_at" is null/);
  assert.match(query.text, /left join/);
  // Bounded: the previous implementation read every message the user had ever
  // exchanged and grouped them in application code.
  assert.equal(query.params.at(-1), 100);

  assert.deepEqual(
    conversations.map((entry) => [entry.conversationId, entry.peerId, entry.unreadCount]),
    [
      // The peer is whichever end of the last message the caller is not on.
      ['alice:bob', 'bob', 3],
      // No unread row joined ⇒ zero, not null.
      ['alice:carol', 'carol', 0],
    ]
  );
});

// ─── saveMessage ──────────────────────────────────────────────────────────────

test('saveMessage inserts once and returns the stored row', async () => {
  const stored = messageRow({ messageId: 'm-9', body: 'hi' });
  const { store, queries } = createRecordingStore([[toTuple(stored)]]);

  const saved = await store.saveMessage({ senderId: 'alice', recipientId: 'bob', body: 'hi' });

  assert.equal(queries.length, 1, 'a fresh insert needs no follow-up read');
  assert.match(queries[0].text, /insert into "messages"/);
  assert.match(queries[0].text, /on conflict do nothing/);
  assert.equal(saved.messageId, 'm-9');
  assert.equal(saved.conversationId, 'alice:bob');
});

test('a replayed message is not overwritten by the replay', async () => {
  // A client resending from its durable outbox must not clobber the reactions
  // and receipts the original has accumulated since — hence DO NOTHING plus a
  // re-read, rather than an upsert.
  const existing = messageRow({
    messageId: 'm-1',
    reactions: { '👍': ['bob'] },
    deliveredTo: ['bob'],
    readAt: '2024-01-02T00:00:00.000Z',
  });
  const { store, queries } = createRecordingStore([[], [toTuple(existing)]]);

  const saved = await store.saveMessage({
    messageId: 'm-1',
    senderId: 'alice',
    recipientId: 'bob',
    body: 'hi',
  });

  assert.equal(queries.length, 2, 'a rejected insert is followed by a read of the winner');
  assert.match(queries[1].text, /select .* from "messages" where/s);
  assert.deepEqual(saved.reactions, { '👍': ['bob'] });
  assert.deepEqual(saved.deliveredTo, ['bob']);
  assert.equal(saved.readAt, '2024-01-02T00:00:00.000Z');
});

// ─── Receipts ─────────────────────────────────────────────────────────────────

test('markDelivered appends a receipt idempotently inside the database', async () => {
  const { store, queries } = createRecordingStore([[toTuple(messageRow({ deliveredTo: ['bob'] }))]]);

  const updated = await store.markDelivered('m-1', 'bob', 'alice:bob');

  // The duplicate check is part of the UPDATE, so two instances processing the
  // same receipt cannot race into a doubled entry.
  assert.match(queries[0].text, /array_append/);
  assert.match(queries[0].text, /@> array\[\$\d+\]::text\[\]/);
  assert.match(queries[0].text, /"messages"\."conversation_id" = \$\d+ and "messages"\."message_id" = \$\d+/);
  assert.deepEqual(updated?.deliveredTo, ['bob']);
});

test('markDelivered reports a miss rather than inventing a message', async () => {
  const { store } = createRecordingStore([[]]);

  assert.equal(await store.markDelivered('missing', 'bob', 'alice:bob'), null);
});

test('markRead returns how many messages it flipped', async () => {
  const { store, queries } = createRecordingStore([[['m-1'], ['m-2']]]);

  const count = await store.markRead('alice:bob', 'bob');

  // Only the recipient's still-unread messages, which is exactly the partial
  // index `idx_messages_unread` covers.
  assert.match(queries[0].text, /"messages"\."recipient_id" = \$\d+ and "messages"\."read_at" is null/);
  assert.equal(count, 2);
});

// ─── deleteMessage ────────────────────────────────────────────────────────────

test('only the author can delete, and only once', async () => {
  const { store, queries } = createRecordingStore([
    [toTuple(messageRow({ body: '', deletedAt: '2024-01-03T00:00:00.000Z' }))],
  ]);

  const tombstoned = await store.deleteMessage('alice:bob', 'm-1', 'alice');

  // Authorship and the not-already-deleted guard are both in the WHERE clause,
  // so they are enforced by the database rather than by a read-then-write two
  // instances could interleave.
  assert.match(queries[0].text, /"messages"\."sender_id" = \$\d+/);
  assert.match(queries[0].text, /"messages"\."deleted_at" is null/);
  assert.equal(tombstoned?.body, '');
  assert.equal(tombstoned?.deletedAt, '2024-01-03T00:00:00.000Z');
});

test('deleting a message that is not the caller\'s is a miss, not an error', async () => {
  const { store } = createRecordingStore([[]]);

  assert.equal(await store.deleteMessage('alice:bob', 'm-1', 'bob'), null);
});

// ─── reactToMessage ───────────────────────────────────────────────────────────

test('a reaction merges into the stored map without dropping other reactors', async () => {
  const existing = messageRow({ reactions: { '👍': ['bob'] } });
  const { store, queries } = createRecordingStore([
    [toTuple(existing)],
    [toTuple(messageRow({ reactions: { '👍': ['bob', 'alice'] } }))],
  ]);

  const updated = await store.reactToMessage({
    conversationId: 'alice:bob',
    messageId: 'm-1',
    userId: 'alice',
    emoji: '👍',
    action: 'add',
  });

  // The merge rule is shared with the memory store rather than reimplemented
  // as a jsonb expression, so the two backends cannot disagree about what a
  // retried reaction does.
  assert.deepEqual(JSON.parse(String(queries[1].params[0])), { '👍': ['bob', 'alice'] });
  assert.deepEqual(updated?.reactions, { '👍': ['bob', 'alice'] });
});

test('a reaction on a tombstoned or missing message is refused', async () => {
  const { store, queries } = createRecordingStore([[]]);

  const result = await store.reactToMessage({
    conversationId: 'alice:bob',
    messageId: 'm-1',
    userId: 'alice',
    emoji: '👍',
  });

  assert.equal(result, null);
  // The read filters on `deleted_at is null`, so a tombstoned row is invisible
  // here and no update follows.
  assert.match(queries[0].text, /"messages"\."deleted_at" is null/);
  assert.equal(queries.length, 1);
});

test('an incomplete reaction request never reaches the database', async () => {
  const { store, queries } = createRecordingStore();

  assert.equal(await store.reactToMessage(), null);
  assert.equal(await store.reactToMessage({ conversationId: 'alice:bob', messageId: 'm-1' }), null);
  assert.equal(queries.length, 0);
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

test('the store is ready on construction and does not close the borrowed pool', async () => {
  const { store, queries } = createRecordingStore();

  assert.equal(store.type, 'postgres');
  await store.ready?.();
  await store.close?.();
  // The pool belongs to `db/client.ts`, which closes it during shutdown; a
  // store that closed it would take the rest of the server down with it.
  assert.equal(queries.length, 0);
});
