/**
 * Unit tests for the text-message store and the conversation-id derivation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT, deriveConversationId, createMemoryMessageStore, createMessageStore } from '../src/messageStore.ts';
import { asDatabase } from './helpers.ts';

// ─── Conversation ids ─────────────────────────────────────────────────────────

test('conversation id is independent of participant order', () => {
  assert.equal(deriveConversationId('alice', 'bob'), deriveConversationId('bob', 'alice'));
});

test('conversation id differs between different pairs', () => {
  assert.notEqual(deriveConversationId('alice', 'bob'), deriveConversationId('alice', 'carol'));
});

// ─── Memory store ─────────────────────────────────────────────────────────────

/**
 * Save `count` messages with strictly increasing timestamps.
 */
async function seed(store: any, conversationId: string, count: number) {
  const saved: any[] = [];
  for (let i = 0; i < count; i++) {
    saved.push(
      await store.saveMessage({
        conversationId,
        senderId: 'alice',
        recipientId: 'bob',
        body: `message ${i}`,
        // Deterministic, strictly increasing timestamps keep ordering assertions stable.
        createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString(),
      })
    );
  }
  return saved;
}

test('saveMessage fills in server-owned fields', async () => {
  const store = createMemoryMessageStore();
  const message = await store.saveMessage({
    senderId: 'alice',
    recipientId: 'bob',
    body: 'hello',
  });

  assert.equal(typeof message.messageId, 'string');
  assert.ok(message.messageId.length > 0);
  assert.equal(message.conversationId, deriveConversationId('alice', 'bob'));
  assert.equal(message.senderId, 'alice');
  assert.equal(message.recipientId, 'bob');
  assert.equal(message.body, 'hello');
  assert.equal(typeof message.createdAt, 'string');
  assert.deepEqual(message.deliveredTo, []);
  assert.equal(message.readAt, null);
});

test('saveMessage is idempotent for a repeated client messageId', async () => {
  const store = createMemoryMessageStore();
  const conversationId = deriveConversationId('alice', 'bob');

  const first = await store.saveMessage({
    conversationId,
    messageId: 'dup-1',
    senderId: 'alice',
    recipientId: 'bob',
    body: 'first send',
  });
  // Simulates a client replaying the same send from its durable outbox.
  const replay = await store.saveMessage({
    conversationId,
    messageId: 'dup-1',
    senderId: 'alice',
    recipientId: 'bob',
    body: 'retried send',
  });

  assert.equal(replay.messageId, first?.messageId);
  assert.equal(replay.body, 'first send', 'the stored message is returned, not the replay');
  const messages = await store.listMessages({ conversationId });
  assert.equal(messages.length, 1, 'the replay must not create a second message');
});

test('listMessages returns newest first', async () => {
  const store = createMemoryMessageStore();
  const conversationId = deriveConversationId('alice', 'bob');
  await seed(store, conversationId, 3);

  const messages = await store.listMessages({ conversationId });
  assert.deepEqual(
    messages.map((m) => m.body),
    ['message 2', 'message 1', 'message 0']
  );
});

test('listMessages only returns the requested conversation', async () => {
  const store = createMemoryMessageStore();
  await seed(store, deriveConversationId('alice', 'bob'), 2);
  await seed(store, deriveConversationId('alice', 'carol'), 3);

  const messages = await store.listMessages({
    conversationId: deriveConversationId('alice', 'bob'),
  });
  assert.equal(messages.length, 2);
});

test('listMessages clamps the limit between 1 and 100', async () => {
  const store = createMemoryMessageStore();
  const conversationId = deriveConversationId('alice', 'bob');
  await seed(store, conversationId, 5);

  assert.equal((await store.listMessages({ conversationId, limit: 2 })).length, 2);
  assert.equal(
    (await store.listMessages({ conversationId, limit: 0 })).length,
    1,
    'clamped up to 1'
  );
  assert.equal(
    (await store.listMessages({ conversationId, limit: -5 })).length,
    1,
    'clamped up to 1'
  );
  assert.equal(
    (await store.listMessages({ conversationId, limit: 1000 })).length,
    5,
    'clamped to max'
  );
  assert.equal(
    (await store.listMessages({ conversationId, limit: 'not-a-number' })).length,
    5,
    'falls back to the default'
  );
  assert.ok(DEFAULT_MESSAGE_LIMIT <= MAX_MESSAGE_LIMIT);
});

test('listMessages honours the `before` cursor', async () => {
  const store = createMemoryMessageStore();
  const conversationId = deriveConversationId('alice', 'bob');
  const seeded = await seed(store, conversationId, 5);

  const firstPage = await store.listMessages({ conversationId, limit: 2 });
  assert.deepEqual(
    firstPage.map((m) => m.body),
    ['message 4', 'message 3']
  );

  const secondPage = await store.listMessages({
    conversationId,
    limit: 2,
    before: firstPage[firstPage.length - 1].createdAt,
  });
  assert.deepEqual(
    secondPage.map((m) => m.body),
    ['message 2', 'message 1']
  );
  assert.equal(seeded.length, 5);
});

test('searchMessages returns only the requesting user matches, newest first', async () => {
  const store = createMemoryMessageStore();
  await store.saveMessage({
    senderId: 'alice',
    recipientId: 'bob',
    body: 'lunch at noon',
    createdAt: '2024-01-01T00:00:00.000Z',
  });
  await store.saveMessage({
    senderId: 'bob',
    recipientId: 'alice',
    body: 'Lunch sounds good',
    createdAt: '2024-01-01T00:00:01.000Z',
  });
  await store.saveMessage({
    senderId: 'bob',
    recipientId: 'carol',
    body: 'lunch without alice',
    createdAt: '2024-01-01T00:00:02.000Z',
  });

  const results = await store.searchMessages({ userId: 'alice', query: 'lunch' });
  assert.deepEqual(
    results.map((m) => m.body),
    ['Lunch sounds good', 'lunch at noon'],
    'case-insensitive, newest first, and never another pair conversation'
  );
});

test('searchMessages honours the limit and the `before` cursor', async () => {
  const store = createMemoryMessageStore();
  const conversationId = deriveConversationId('alice', 'bob');
  await seed(store, conversationId, 5);

  const firstPage = await store.searchMessages({ userId: 'alice', query: 'message', limit: 2 });
  assert.deepEqual(
    firstPage.map((m) => m.body),
    ['message 4', 'message 3']
  );

  const secondPage = await store.searchMessages({
    userId: 'alice',
    query: 'message',
    limit: 2,
    before: firstPage[firstPage.length - 1].createdAt,
  });
  assert.deepEqual(
    secondPage.map((m) => m.body),
    ['message 2', 'message 1']
  );
});

test('searchMessages returns nothing without a user or a term', async () => {
  const store = createMemoryMessageStore();
  await seed(store, deriveConversationId('alice', 'bob'), 2);

  assert.deepEqual(await store.searchMessages({ userId: 'alice', query: '   ' }), []);
  assert.deepEqual(await store.searchMessages({ query: 'message' }), []);
  assert.deepEqual(await store.searchMessages(), []);
});

test('markDelivered is idempotent', async () => {
  const store = createMemoryMessageStore();
  const message = await store.saveMessage({
    senderId: 'alice',
    recipientId: 'bob',
    body: 'hello',
  });

  const first = await store.markDelivered(message.messageId, 'bob');
  assert.deepEqual(first?.deliveredTo, ['bob']);

  const second = await store.markDelivered(message.messageId, 'bob');
  assert.deepEqual(second?.deliveredTo, ['bob'], 'no duplicate entry');

  const third = await store.markDelivered(message.messageId, 'carol');
  assert.deepEqual(third?.deliveredTo, ['bob', 'carol']);
});

test('markDelivered returns null for an unknown message', async () => {
  const store = createMemoryMessageStore();
  assert.equal(await store.markDelivered('missing', 'bob'), null);
});

test('saved messages are snapshots, not live references', async () => {
  const store = createMemoryMessageStore();
  const conversationId = deriveConversationId('alice', 'bob');
  const saved = await store.saveMessage({
    conversationId,
    senderId: 'alice',
    recipientId: 'bob',
    body: 'hello',
  });

  saved.body = 'tampered';
  const [stored] = await store.listMessages({ conversationId });
  assert.equal(stored.body, 'hello');
});

// ─── listConversations ────────────────────────────────────────────────────────

test('deleteMessage tombstones only the author own message', async () => {
  const store = createMemoryMessageStore();
  const conversationId = deriveConversationId('alice', 'bob');
  const mine = await store.saveMessage({
    conversationId,
    senderId: 'alice',
    recipientId: 'bob',
    body: 'mine',
  });
  await store.saveMessage({
    conversationId,
    senderId: 'bob',
    recipientId: 'alice',
    body: 'theirs',
  });

  assert.equal(await store.deleteMessage(conversationId, mine.messageId, 'bob'), null);
  const deleted = await store.deleteMessage(conversationId, mine.messageId, 'alice');
  // "Delete for everyone" leaves a tombstone: the content is gone, the row
  // stays so a reply quoting it still resolves.
  assert.equal(deleted?.body, '');
  assert.ok(deleted?.deletedAt);
  // Idempotent: a repeated delete finds an already-tombstoned row.
  assert.equal(await store.deleteMessage(conversationId, mine.messageId, 'alice'), null);

  const remaining = await store.listMessages({ conversationId });
  assert.deepEqual(
    remaining.map((m) => m.body),
    ['theirs', '']
  );
});

test('listConversations returns one entry per conversation, newest first', async () => {
  const store = createMemoryMessageStore();

  await store.saveMessage({
    senderId: 'alice',
    recipientId: 'bob',
    body: 'hi bob',
    createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, 0)).toISOString(),
  });
  await store.saveMessage({
    senderId: 'alice',
    recipientId: 'carol',
    body: 'hi carol',
    createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, 1)).toISOString(),
  });
  await store.saveMessage({
    senderId: 'bob',
    recipientId: 'alice',
    body: 'hi alice',
    createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, 2)).toISOString(),
  });

  const conversations = await store.listConversations('alice');
  assert.equal(conversations.length, 2);
  // Bob's conversation has the most recent message (0:0:2) so it sorts first.
  assert.equal(conversations[0].peerId, 'bob');
  assert.equal(conversations[0].lastMessage.body, 'hi alice');
  assert.equal(conversations[1].peerId, 'carol');
  assert.equal(conversations[1].lastMessage.body, 'hi carol');
});

test('listConversations reports the peerId relative to the requesting user', async () => {
  const store = createMemoryMessageStore();
  await store.saveMessage({ senderId: 'alice', recipientId: 'bob', body: 'hi' });

  const [fromAlice] = await store.listConversations('alice');
  assert.equal(fromAlice.peerId, 'bob');

  const [fromBob] = await store.listConversations('bob');
  assert.equal(fromBob.peerId, 'alice');
});

test('listConversations counts only unread messages addressed to the requesting user', async () => {
  const store = createMemoryMessageStore();
  const first = await store.saveMessage({ senderId: 'alice', recipientId: 'bob', body: 'one' });
  await store.saveMessage({ senderId: 'alice', recipientId: 'bob', body: 'two' });
  await store.saveMessage({ senderId: 'bob', recipientId: 'alice', body: 'reply' });

  const [bobsView] = await store.listConversations('bob');
  assert.equal(bobsView.unreadCount, 2, 'both alice→bob messages are unread');

  const [alicesView] = await store.listConversations('alice');
  assert.equal(alicesView.unreadCount, 1, 'only the bob→alice reply is unread for alice');

  await store.markDelivered(first?.messageId, 'bob');
  const [afterDelivery] = await store.listConversations('bob');
  assert.equal(afterDelivery.unreadCount, 2, 'delivery does not affect the unread count');
});

test('listConversations excludes conversations the user has no part in', async () => {
  const store = createMemoryMessageStore();
  await store.saveMessage({ senderId: 'bob', recipientId: 'carol', body: 'hi' });

  assert.deepEqual(await store.listConversations('alice'), []);
});

test('listConversations returns snapshots, not live references', async () => {
  const store = createMemoryMessageStore();
  await store.saveMessage({ senderId: 'alice', recipientId: 'bob', body: 'hi' });

  const [conversation] = await store.listConversations('alice');
  conversation.lastMessage.body = 'tampered';

  const [again] = await store.listConversations('alice');
  assert.equal(again.lastMessage.body, 'hi');
});

// ─── markRead ─────────────────────────────────────────────────────────────────

test('markRead marks unread messages addressed to the user and is idempotent', async () => {
  const store = createMemoryMessageStore();
  const conversationId = deriveConversationId('alice', 'bob');
  await store.saveMessage({ conversationId, senderId: 'alice', recipientId: 'bob', body: 'one' });
  await store.saveMessage({ conversationId, senderId: 'alice', recipientId: 'bob', body: 'two' });
  await store.saveMessage({ conversationId, senderId: 'bob', recipientId: 'alice', body: 'reply' });

  const updated = await store.markRead(conversationId, 'bob');
  assert.equal(updated, 2, 'only the messages addressed to bob are marked read');

  const messages = await store.listMessages({ conversationId });
  const forBob = messages.filter((m) => m.recipientId === 'bob');
  assert.ok(forBob.every((m) => typeof m.readAt === 'string'));
  const forAlice = messages.filter((m) => m.recipientId === 'alice');
  assert.ok(forAlice.every((m) => m.readAt === null));

  const second = await store.markRead(conversationId, 'bob');
  assert.equal(second, 0, 'idempotent: nothing left to mark read');
});

test('markRead only affects the requested conversation', async () => {
  const store = createMemoryMessageStore();
  await store.saveMessage({
    conversationId: deriveConversationId('alice', 'bob'),
    senderId: 'alice',
    recipientId: 'bob',
    body: 'hi bob',
  });
  await store.saveMessage({
    conversationId: deriveConversationId('alice', 'carol'),
    senderId: 'alice',
    recipientId: 'carol',
    body: 'hi carol',
  });

  const updated = await store.markRead(deriveConversationId('alice', 'bob'), 'bob');
  assert.equal(updated, 1);

  const [carolsConversation] = await store.listConversations('carol');
  assert.equal(carolsConversation.unreadCount, 1, 'carol conversation is untouched');
});

// ─── Factory ──────────────────────────────────────────────────────────────────

test('createMessageStore returns the memory store without a database handle', () => {
  assert.equal(createMessageStore().type, 'memory');
  assert.equal(createMessageStore({ db: null }).type, 'memory');
});

test('createMessageStore returns the Postgres store when a database handle is supplied', () => {
  assert.equal(createMessageStore({ db: asDatabase({}) }).type, 'postgres');
});

test('createMessageStore requires explicit production memory opt-in', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOptIn = process.env.ALLOW_IN_MEMORY_MESSAGE_STORE;
  delete process.env.ALLOW_IN_MEMORY_MESSAGE_STORE;
  process.env.NODE_ENV = 'production';
  try {
    // Losing chat history on restart is data loss, not a degraded mode.
    assert.throws(() => createMessageStore(), /DATABASE_URL is required in production/);
    // A database handle satisfies the requirement without the opt-in.
    assert.equal(createMessageStore({ db: asDatabase({}) }).type, 'postgres');
    process.env.ALLOW_IN_MEMORY_MESSAGE_STORE = 'true';
    assert.equal(createMessageStore().type, 'memory');
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousOptIn === undefined) delete process.env.ALLOW_IN_MEMORY_MESSAGE_STORE;
    else process.env.ALLOW_IN_MEMORY_MESSAGE_STORE = previousOptIn;
  }
});

test('createMessageStore honours an injected store', () => {
  const injected = createMemoryMessageStore();
  assert.equal(createMessageStore({ messageStore: injected }), injected);
  // The injected store wins even when Postgres is available.
  assert.equal(createMessageStore({ messageStore: injected, db: asDatabase({}) }), injected);
});
