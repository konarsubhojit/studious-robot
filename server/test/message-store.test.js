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
  assert.equal(message.readAt, null);
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

// ─── listConversations ────────────────────────────────────────────────────────

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

  await store.markDelivered(first.messageId, 'bob');
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
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const doc of docs) {
        if (
          doc.conversationId === filter.conversationId
          && doc.recipientId === filter.recipientId
          && doc.readAt === filter.readAt
        ) {
          Object.assign(doc, update.$set);
          modifiedCount += 1;
        }
      }
      return { modifiedCount };
    },
    // Only interprets the specific pipeline shape `listConversations` builds:
    // $match({ $or }) → $sort(createdAt) → $group(by conversationId) → $sort(lastMessage.createdAt).
    aggregate(pipeline) {
      let results = [...docs];
      for (const stage of pipeline) {
        if (stage.$match) {
          const clauses = stage.$match.$or;
          results = results.filter((doc) => clauses.some((clause) => {
            const [field, value] = Object.entries(clause)[0];
            return doc[field] === value;
          }));
        } else if (stage.$group) {
          const [, groupField] = stage.$group._id.split('$');
          const [recipientClause, readClause] = stage.$group.unreadCount.$sum.$cond[0].$and;
          const [, recipientUserId] = recipientClause.$eq;
          const groups = new Map();
          for (const doc of results) {
            const key = doc[groupField];
            if (!groups.has(key)) {
              groups.set(key, { _id: key, lastMessage: { _id: 'oid', ...doc }, unreadCount: 0 });
            }
            const group = groups.get(key);
            if (doc.recipientId === recipientUserId && doc.readAt === readClause.$eq[1]) {
              group.unreadCount += 1;
            }
          }
          results = [...groups.values()];
        } else if (stage.$sort) {
          const [sortKey] = Object.keys(stage.$sort);
          const readAt = (doc) => (sortKey.startsWith('lastMessage.') ? doc.lastMessage[sortKey.slice('lastMessage.'.length)] : doc[sortKey]);
          results = [...results].sort((a, b) => (readAt(a) < readAt(b) ? 1 : -1));
        }
      }
      return { async toArray() { return results; } };
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

test('mongo store listConversations aggregates by conversation, newest first', async () => {
  const fake = createFakeMongoClient();
  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: fake.client });

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
  assert.equal(conversations[0].peerId, 'bob');
  assert.equal(conversations[0].lastMessage.body, 'hi alice');
  assert.equal(conversations[0].lastMessage._id, undefined, 'driver _id is not leaked');
  assert.equal(conversations[0].unreadCount, 1);
  assert.equal(conversations[1].peerId, 'carol');
  assert.equal(conversations[1].unreadCount, 0, 'alice sent this message, so it is not unread for her');

  await store.close();
});

test('mongo store markRead updates only the matching, still-unread messages', async () => {
  const fake = createFakeMongoClient();
  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: fake.client });
  const conversationId = deriveConversationId('alice', 'bob');

  await store.saveMessage({ conversationId, senderId: 'alice', recipientId: 'bob', body: 'one' });
  await store.saveMessage({ conversationId, senderId: 'alice', recipientId: 'bob', body: 'two' });
  await store.saveMessage({ conversationId, senderId: 'bob', recipientId: 'alice', body: 'reply' });

  const updated = await store.markRead(conversationId, 'bob');
  assert.equal(updated, 2);

  const second = await store.markRead(conversationId, 'bob');
  assert.equal(second, 0, 'idempotent');

  const [conversation] = await store.listConversations('bob');
  assert.equal(conversation.unreadCount, 0, 'alice→bob messages are read now');
  assert.equal((await store.listConversations('alice'))[0].unreadCount, 1, 'bob→alice reply still unread');

  await store.close();
});
