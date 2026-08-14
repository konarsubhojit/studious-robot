'use strict';

/**
 * Unit tests for the text-message store and the conversation-id derivation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  deriveConversationId,
  createMemoryMessageStore,
  createMongoMessageStore,
  createMessageStore,
} = require('../src/messageStore.js');

// ─── Conversation ids ─────────────────────────────────────────────────────────

test('conversation id is independent of participant order', () => {
  assert.equal(deriveConversationId('alice', 'bob'), deriveConversationId('bob', 'alice'));
});

test('conversation id differs between different pairs', () => {
  assert.notEqual(deriveConversationId('alice', 'bob'), deriveConversationId('alice', 'carol'));
});

// ─── Memory store ─────────────────────────────────────────────────────────────

/** Save `count` messages with strictly increasing timestamps. */
async function seed(store, conversationId, count) {
  const saved = [];
  for (let i = 0; i < count; i++) {
    saved.push(await store.saveMessage({
      conversationId,
      senderId: 'alice',
      recipientId: 'bob',
      body: `message ${i}`,
      // Deterministic, strictly increasing timestamps keep ordering assertions stable.
      createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString(),
    }));
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
});

test('listMessages returns newest first', async () => {
  const store = createMemoryMessageStore();
  const conversationId = deriveConversationId('alice', 'bob');
  await seed(store, conversationId, 3);

  const messages = await store.listMessages({ conversationId });
  assert.deepEqual(messages.map((m) => m.body), ['message 2', 'message 1', 'message 0']);
});

test('listMessages only returns the requested conversation', async () => {
  const store = createMemoryMessageStore();
  await seed(store, deriveConversationId('alice', 'bob'), 2);
  await seed(store, deriveConversationId('alice', 'carol'), 3);

  const messages = await store.listMessages({ conversationId: deriveConversationId('alice', 'bob') });
  assert.equal(messages.length, 2);
});

test('listMessages clamps the limit between 1 and 100', async () => {
  const store = createMemoryMessageStore();
  const conversationId = deriveConversationId('alice', 'bob');
  await seed(store, conversationId, 5);

  assert.equal((await store.listMessages({ conversationId, limit: 2 })).length, 2);
  assert.equal((await store.listMessages({ conversationId, limit: 0 })).length, 1, 'clamped up to 1');
  assert.equal((await store.listMessages({ conversationId, limit: -5 })).length, 1, 'clamped up to 1');
  assert.equal((await store.listMessages({ conversationId, limit: 1000 })).length, 5, 'clamped to max');
  assert.equal(
    (await store.listMessages({ conversationId, limit: 'not-a-number' })).length,
    5,
    'falls back to the default',
  );
  assert.ok(DEFAULT_MESSAGE_LIMIT <= MAX_MESSAGE_LIMIT);
});

test('listMessages honours the `before` cursor', async () => {
  const store = createMemoryMessageStore();
  const conversationId = deriveConversationId('alice', 'bob');
  const seeded = await seed(store, conversationId, 5);

  const firstPage = await store.listMessages({ conversationId, limit: 2 });
  assert.deepEqual(firstPage.map((m) => m.body), ['message 4', 'message 3']);

  const secondPage = await store.listMessages({
    conversationId,
    limit: 2,
    before: firstPage[firstPage.length - 1].createdAt,
  });
  assert.deepEqual(secondPage.map((m) => m.body), ['message 2', 'message 1']);
  assert.equal(seeded.length, 5);
});

test('markDelivered is idempotent', async () => {
  const store = createMemoryMessageStore();
  const message = await store.saveMessage({
    senderId: 'alice',
    recipientId: 'bob',
    body: 'hello',
  });

  const first = await store.markDelivered(message.messageId, 'bob');
  assert.deepEqual(first.deliveredTo, ['bob']);

  const second = await store.markDelivered(message.messageId, 'bob');
  assert.deepEqual(second.deliveredTo, ['bob'], 'no duplicate entry');

  const third = await store.markDelivered(message.messageId, 'carol');
  assert.deepEqual(third.deliveredTo, ['bob', 'carol']);
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

// ─── Factory ──────────────────────────────────────────────────────────────────

test('createMessageStore returns the memory store when MONGODB_URI is unset', () => {
  const previous = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  try {
    assert.equal(createMessageStore().type, 'memory');
  } finally {
    if (previous === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previous;
  }
});

test('createMessageStore honours an injected store', () => {
  const injected = createMemoryMessageStore();
  assert.equal(createMessageStore({ messageStore: injected }), injected);
});

test('createMongoMessageStore requires a uri', () => {
  assert.throws(() => createMongoMessageStore({}), /uri.*required/);
});

// ─── Mongo store (driver stubbed) ─────────────────────────────────────────────

/** Minimal in-memory stand-in for the pieces of the driver the store uses. */
function createFakeMongoClient() {
  const docs = [];
  const createdIndexes = [];
  let closed = false;

  const collection = {
    async createIndex(spec, options) { createdIndexes.push({ spec, options }); },
    async insertOne(doc) { docs.push(doc); return { insertedId: doc.messageId }; },
    find(query) {
      let results = docs.filter((d) => d.conversationId === query.conversationId);
      if (query.createdAt?.$lt) {
        results = results.filter((d) => d.createdAt < query.createdAt.$lt);
      }
      return {
        sort() { results = [...results].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); return this; },
        limit(n) { results = results.slice(0, n); return this; },
        async toArray() { return results.map((d) => ({ _id: 'oid', ...d })); },
      };
    },
    async findOneAndUpdate(filter, update) {
      const doc = docs.find((d) => d.messageId === filter.messageId);
      if (!doc) return null;
      const userId = update.$addToSet.deliveredTo;
      if (!doc.deliveredTo.includes(userId)) doc.deliveredTo.push(userId);
      return { value: { _id: 'oid', ...doc } };
    },
  };

  return {
    client: {
      async connect() {},
      db() { return { collection: () => collection }; },
      async close() { closed = true; },
    },
    createdIndexes,
    isClosed: () => closed,
  };
}

test('mongo store creates its indexes on first use', async () => {
  const fake = createFakeMongoClient();
  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: fake.client });

  await store.saveMessage({ senderId: 'alice', recipientId: 'bob', body: 'hi' });

  assert.deepEqual(fake.createdIndexes.map((i) => i.spec), [
    { conversationId: 1, createdAt: -1 },
    { messageId: 1 },
  ]);
  assert.deepEqual(fake.createdIndexes[1].options, { unique: true });
  await store.close();
  assert.equal(fake.isClosed(), true);
});

test('mongo store round-trips messages and strips the driver _id', async () => {
  const fake = createFakeMongoClient();
  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: fake.client });
  const conversationId = deriveConversationId('alice', 'bob');

  await seed(store, conversationId, 3);
  const messages = await store.listMessages({ conversationId, limit: 2 });

  assert.deepEqual(messages.map((m) => m.body), ['message 2', 'message 1']);
  assert.equal(messages[0]._id, undefined, 'driver _id is not leaked');

  const delivered = await store.markDelivered(messages[0].messageId, 'bob');
  assert.deepEqual(delivered.deliveredTo, ['bob']);
  assert.equal(delivered._id, undefined);
  assert.equal(await store.markDelivered('missing', 'bob'), null);

  await store.close();
});

test('mongo store survives index-creation failure', async () => {
  const fake = createFakeMongoClient();
  fake.client.db = () => ({
    collection: () => ({
      async createIndex() { throw new Error('cosmos throttled the index build'); },
      async insertOne() { return {}; },
    }),
  });

  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: fake.client });
  // Must not reject: the server has to keep running without the indexes.
  await store.saveMessage({ senderId: 'alice', recipientId: 'bob', body: 'hi' });
  await store.close();
});
