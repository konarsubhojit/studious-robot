/**
 * Unit tests for the text-message store and the conversation-id derivation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT, deriveConversationId, createMemoryMessageStore, createMongoMessageStore, createMessageStore } from '../src/messageStore.ts';

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

test('createMessageStore requires explicit production memory opt-in', () => {
  const previousUri = process.env.MONGODB_URI;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOptIn = process.env.ALLOW_IN_MEMORY_MESSAGE_STORE;
  delete process.env.MONGODB_URI;
  delete process.env.ALLOW_IN_MEMORY_MESSAGE_STORE;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => createMessageStore(), /MONGODB_URI is required in production/);
    process.env.ALLOW_IN_MEMORY_MESSAGE_STORE = 'true';
    assert.equal(createMessageStore().type, 'memory');
  } finally {
    if (previousUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previousUri;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousOptIn === undefined) delete process.env.ALLOW_IN_MEMORY_MESSAGE_STORE;
    else process.env.ALLOW_IN_MEMORY_MESSAGE_STORE = previousOptIn;
  }
});

test('createMessageStore fails closed for a malformed MONGODB_URI', () => {
  const previous = process.env.MONGODB_URI;
  process.env.MONGODB_URI = 'not a uri';
  try {
    assert.throws(() => createMessageStore(), /Invalid MONGODB_URI/);
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

// Regression: both the factory and the lazy `connect()` used to build the
// driver with CommonJS `require('mongodb')`, which throws
// `ReferenceError: require is not defined` under this ESM package. These two
// tests take the non-injected path so the real driver import is covered.
test('createMessageStore builds a Mongo store from MONGODB_URI without an injected client', () => {
  const previous = process.env.MONGODB_URI;
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/wetalk';
  try {
    const store = createMessageStore();
    assert.equal(store.type, 'mongo');
  } finally {
    if (previous === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previous;
  }
});

test('mongo store connects with the real driver when no client is injected', async () => {
  // Port 1 is never listening, so the driver fails server selection — the point
  // is that it fails with a *driver* error rather than a ReferenceError.
  const store = createMongoMessageStore({ uri: 'mongodb://127.0.0.1:1/wetalk?directConnection=true' });
  await assert.rejects(
    () => store.listMessages({ conversationId: 'alice:bob', limit: 1 }),
    (error: Error) => {
      assert.ok(!(error instanceof ReferenceError), `unexpected ReferenceError: ${error.message}`);
      assert.doesNotMatch(error.message, /require is not defined/);
      return true;
    }
  );
  await store.close?.();
});

// ─── Mongo store (driver stubbed) ─────────────────────────────────────────────

/** Whether `doc` matches every field of an equality-only `filter`. */
function matchesFilter(doc: any, filter: any): boolean {
  return Object.entries(filter).every(([field, value]) => {
    if (field === '$or') {
      return (value as any[]).some((clause) => matchesFilter(doc, clause));
    }
    const actual = field.split('.').reduce((current, part) => current?.[part], doc);
    if (value && typeof value === 'object' && '$lt' in value) {
      return actual < (value as { $lt: string }).$lt;
    }
    return actual === value;
  });
}

function setPath(doc: any, field: string, value: any) {
  const parts = field.split('.');
  const leaf = parts.pop() as string;
  const parent = parts.reduce((current, part) => (current[part] ??= {}), doc);
  parent[leaf] = value;
}

function applyFakeUpdate(existing: any, update: any) {
  for (const [field, value] of Object.entries(update.$set ?? {})) {
    setPath(existing, field, value);
  }
  for (const [field, value] of Object.entries(update.$inc ?? {})) {
    setPath(existing, field, (existing[field] ?? 0) + (value as number));
  }
  for (const [field, value] of Object.entries(update.$max ?? {})) {
    if (existing[field] === undefined || existing[field] < (value as string)) {
      existing[field] = value;
    }
  }
}

/** Minimal in-memory stand-in for the pieces of the driver the store uses. */
function createFakeMongoClient() {
  const messageDocs: any[] = [];
  const conversationIndexDocs: any[] = [];
  const createdIndexes: any[] = [];
  const findCalls: any[] = [];
  let closed = false;

  function makeCollection(name: string, docs: any[]) {
    return {
      async createIndex(spec: any, options: any) {
        createdIndexes.push({ collection: name, spec, options });
      },
      async insertOne(doc: any) {
        docs.push(doc);
        return { insertedId: doc.messageId };
      },
      async updateOne(filter: any, update: any, options: any) {
        const existing = docs.find((d) => matchesFilter(d, filter));
        if (existing) {
          applyFakeUpdate(existing, update);
          return {
            matchedCount: 1,
            modifiedCount: update.$set ? 1 : 0,
            upsertedCount: 0,
          };
        }
        if (options?.upsert) {
          docs.push({ ...update.$setOnInsert, ...update.$max });
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      },
      async findOne(filter: any) {
        const found = docs.find((d) => matchesFilter(d, filter));
        return found ? { _id: 'oid', ...found } : null;
      },
      async deleteOne(filter: any) {
        const index = docs.findIndex((d) => matchesFilter(d, filter));
        if (index === -1) return { deletedCount: 0 };
        docs.splice(index, 1);
        return { deletedCount: 1 };
      },
      find(query: any, options?: any) {
        const call: any = { collection: name, query, options };
        findCalls.push(call);
        let results = docs.filter((doc) =>
          Object.entries(query ?? {})
            .filter(([field]) => field !== '$or' && field !== 'createdAt' && field !== 'body')
            .every(([field, value]) => doc[field] === value)
        );
        if (query?.createdAt?.$lt) {
          results = results.filter((d) => d.createdAt < query.createdAt.$lt);
        }
        if (query?.$or) {
          results = results.filter((doc) =>
            query.$or.some((clause: any) => {
              const [field, value] = Object.entries(clause)[0];
              return doc[field] === value;
            })
          );
        }
        if (query?.body?.$regex) {
          const pattern = new RegExp(query.body.$regex, query.body.$options ?? '');
          results = results.filter((d) => pattern.test(d.body));
        }
        return {
          sort(spec: any) {
            call.sort = spec;
            const sortField = 'updatedAt' in spec ? 'updatedAt' : 'createdAt';
            results = [...results].sort((a, b) => (a[sortField] < b[sortField] ? 1 : -1));
            return this;
          },
          limit(n: number) {
            call.limit = n;
            results = results.slice(0, n);
            return this;
          },
          async toArray() {
            return results.map((d) => ({ _id: 'oid', ...d }));
          },
        };
      },
      async findOneAndUpdate(filter: any, update: any) {
        const doc = docs.find((d) => d.messageId === filter.messageId);
        if (!doc) return null;
        const userId = update.$addToSet.deliveredTo;
        if (!doc.deliveredTo.includes(userId)) doc.deliveredTo.push(userId);
        return { value: { _id: 'oid', ...doc } };
      },
      async updateMany(filter: any, update: any) {
        let modifiedCount = 0;
        for (const doc of docs) {
          if (
            doc.conversationId === filter.conversationId &&
            doc.recipientId === filter.recipientId &&
            doc.readAt === filter.readAt
          ) {
            Object.assign(doc, update.$set);
            modifiedCount += 1;
          }
        }
        return { modifiedCount };
      },
    };
  }

  const collections = {
    messages: makeCollection('messages', messageDocs),
    conversation_index: makeCollection('conversation_index', conversationIndexDocs),
  };

  return {
    client: {
      async connect() {},
      db() {
        return {
          collection(name: string) {
            return collections[name as keyof typeof collections];
          },
        };
      },
      async close() {
        closed = true;
      },
    },
    createdIndexes,
    findCalls,
    conversationIndexDocs,
    isClosed: () => closed,
  };
}

test('mongo store creates its Cosmos-compatible indexes on first use', async () => {
  const fake = createFakeMongoClient();
  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: fake.client });

  await store.saveMessage({ senderId: 'alice', recipientId: 'bob', body: 'hi' });

  assert.deepEqual(fake.createdIndexes.filter((i) => i.collection === 'messages').map((i) => i.spec), [
    { conversationId: 1, createdAt: -1 },
    { conversationId: 1, createdAt: 1 },
    { conversationId: 1, messageId: 1 },
    { conversationId: 1, createdAt: -1, messageId: -1 },
    { conversationId: 1, body: 1 },
  ]);
  // Every index is prefixed with the shard key (`conversationId`), and the
  // unique guarantee is expressed on the shard-key-prefixed pair so it
  // satisfies Cosmos RU's "unique index must include the shard key" rule.
  assert.deepEqual(
    fake.createdIndexes.find((i) => i.spec.messageId)?.options,
    { unique: true }
  );
  // The search index stays a plain composite index: Cosmos RU supports no
  // `text` index / `$text` operator, so every backend serves the same query.
  assert.ok(
    fake.createdIndexes.every((index) =>
      Object.values(index.spec).every((direction) => direction === 1 || direction === -1)
    ),
    'every index key is a plain ascending/descending direction'
  );
  await store.close?.();
  assert.equal(fake.isClosed(), true);
});

test('mongo store readiness check connects before the first message operation', async () => {
  const fake = createFakeMongoClient();
  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: fake.client });

  await store.ready?.();

  assert.deepEqual(fake.createdIndexes.filter((i) => i.collection === 'messages').map((i) => i.spec), [
    { conversationId: 1, createdAt: -1 },
    { conversationId: 1, createdAt: 1 },
    { conversationId: 1, messageId: 1 },
    { conversationId: 1, createdAt: -1, messageId: -1 },
    { conversationId: 1, body: 1 },
  ]);
  await store.close?.();
});

test('mongo store round-trips messages and strips the driver _id', async () => {
  const fake = createFakeMongoClient();
  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: fake.client });
  const conversationId = deriveConversationId('alice', 'bob');

  await seed(store, conversationId, 3);
  const messages = await store.listMessages({ conversationId, limit: 2 });

  assert.deepEqual(
    messages.map((m) => m.body),
    ['message 2', 'message 1']
  );
  assert.equal((messages[0] as any)._id, undefined, 'driver _id is not leaked');

  const delivered = await store.markDelivered(messages[0].messageId, 'bob');
  assert.deepEqual(delivered?.deliveredTo, ['bob']);
  assert.equal((delivered as any)._id, undefined);
  assert.equal(await store.markDelivered('missing', 'bob'), null);

  await store.close?.();
});

test('mongo store searchMessages matches literally and sorts in application code', async () => {
  const fake = createFakeMongoClient();
  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: fake.client });

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
    ['Lunch sounds good', 'lunch at noon']
  );
  assert.equal((results[0] as any)._id, undefined, 'driver _id is not leaked');

  // A term containing regex metacharacters is matched literally.
  assert.deepEqual(await store.searchMessages({ userId: 'alice', query: '.*' }), []);

  await store.close?.();
});

test('mongo store survives index-creation failure', async () => {
  const fake = createFakeMongoClient();
  fake.client.db = (() => ({
    collection: () => ({
      async createIndex() {
        throw new Error('cosmos throttled the index build');
      },
      async updateOne() {
        return { upsertedCount: 1 };
      },
    }),
  }) as any);

  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: fake.client });
  // Must not reject: the server has to keep running without the indexes.
  await store.saveMessage({ senderId: 'alice', recipientId: 'bob', body: 'hi' });
  await store.close?.();
});

test('mongo store saveMessage is idempotent for a repeated messageId', async () => {
  const fake = createFakeMongoClient();
  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: fake.client });
  const conversationId = deriveConversationId('alice', 'bob');

  await store.saveMessage({
    conversationId,
    messageId: 'dup-1',
    senderId: 'alice',
    recipientId: 'bob',
    body: 'first send',
  });
  // Simulates a client retry/replay of the same client-generated messageId.
  await store.saveMessage({
    conversationId,
    messageId: 'dup-1',
    senderId: 'alice',
    recipientId: 'bob',
    body: 'retried send',
  });

  const messages = await store.listMessages({ conversationId });
  assert.equal(messages.length, 1, 'the duplicate write must not create a second document');
  assert.equal(messages[0].body, 'first send', 'the original document is preserved');

  await store.close?.();
});

test('mongo store deleteMessage only tombstones the author own message', async () => {
  const fake = createFakeMongoClient();
  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: fake.client });
  const conversationId = deriveConversationId('alice', 'bob');

  const mine = await store.saveMessage({
    conversationId,
    senderId: 'alice',
    recipientId: 'bob',
    body: 'mine',
  });

  assert.equal(await store.deleteMessage(conversationId, mine.messageId, 'bob'), null);
  const deleted = await store.deleteMessage(conversationId, mine.messageId, 'alice');
  assert.equal(deleted?.body, '');
  assert.ok(deleted?.deletedAt);
  assert.equal((deleted as any)._id, undefined);
  const remaining = await store.listMessages({ conversationId });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].body, '');
  assert.ok(remaining[0].deletedAt);

  await store.close?.();
});

test('mongo store lists conversations through the user-partition routing index', async () => {
  const fake = createFakeMongoClient();
  const store = createMongoMessageStore({
    uri: 'mongodb://stub',
    client: fake.client,
    conversationIndexReady: true,
  });

  await store.saveMessage({
    senderId: 'alice',
    recipientId: 'bob',
    body: 'older',
    createdAt: '2024-01-01T00:00:00.000Z',
  });
  await store.saveMessage({
    senderId: 'bob',
    recipientId: 'alice',
    body: 'newer',
    createdAt: '2024-01-02T00:00:00.000Z',
  });
  await store.saveMessage({
    senderId: 'alice',
    recipientId: 'bob',
    body: 'late replay',
    createdAt: '2024-01-01T12:00:00.000Z',
  });

  const [conversation] = await store.listConversations('alice');
  assert.equal(conversation.lastMessage.body, 'newer');
  assert.equal(conversation.unreadCount, 1);

  const indexRead = fake.findCalls.find((call) => call.collection === 'conversation_index');
  assert.deepEqual(indexRead.query, { userId: 'alice' });
  assert.deepEqual(indexRead.options, {
    projection: { _id: 0, userId: 0, updatedAt: 0 },
  });
  assert.deepEqual(indexRead.sort, {
    userId: 1,
    updatedAt: -1,
    conversationId: 1,
  });
  assert.equal(indexRead.limit, 100);
  assert.deepEqual(
    fake.createdIndexes.filter((i) => i.collection === 'conversation_index').map((i) => i.spec),
    [
      { userId: 1, conversationId: 1 },
      { userId: 1, updatedAt: -1, conversationId: 1 },
    ]
  );

  assert.equal(
    fake.findCalls.filter((call) => call.collection === 'messages').length,
    0,
    'conversation listing is a single index-collection query'
  );

  await store.markDelivered(conversation.lastMessage.messageId, 'alice');
  const [delivered] = await store.listConversations('alice');
  assert.deepEqual(delivered.lastMessage.deliveredTo, ['alice']);

  assert.equal(await store.markRead('alice:bob', 'alice'), 1);
  const [read] = await store.listConversations('alice');
  assert.equal(read.unreadCount, 0);
  assert.ok(read.lastMessage.readAt);
  fake.conversationIndexDocs.find((row) => row.userId === 'alice').unreadCount = 3;
  assert.equal(await store.markRead('alice:bob', 'alice'), 0);
  assert.equal((await store.listConversations('alice'))[0].unreadCount, 0);

  const deleted = await store.deleteMessage(
    'alice:bob',
    conversation.lastMessage.messageId,
    'bob'
  );
  assert.equal(deleted?.body, '');
  assert.equal((await store.listConversations('alice'))[0].lastMessage.body, '');
  fake.conversationIndexDocs.find((row) => row.userId === 'alice').lastMessage.body = 'stale';
  assert.equal(
    await store.deleteMessage('alice:bob', conversation.lastMessage.messageId, 'bob'),
    null
  );
  assert.equal((await store.listConversations('alice'))[0].lastMessage.body, '');

  fake.conversationIndexDocs.push({
    userId: 'alice',
    conversationId: 'mallory:eve',
    peerId: 'mallory',
    lastMessage: {
      ...conversation.lastMessage,
      conversationId: 'mallory:eve',
      senderId: 'mallory',
      recipientId: 'eve',
    },
    unreadCount: 1,
    updatedAt: '2024-01-03T00:00:00.000Z',
  });
  assert.equal(
    (await store.listConversations('alice')).length,
    1,
    'a malformed index row cannot expose another user conversation'
  );

  await store.close?.();
});

test('mongo store can dual-write the index before indexed reads are enabled', async () => {
  const fake = createFakeMongoClient();
  const store = createMongoMessageStore({
    uri: 'mongodb://stub',
    client: fake.client,
    conversationIndexWrites: true,
    conversationIndexReady: false,
  });

  await store.saveMessage({ senderId: 'alice', recipientId: 'bob', body: 'hi' });
  assert.equal(fake.conversationIndexDocs.length, 2);

  await store.listConversations('alice');
  assert.ok(
    fake.findCalls.some((call) => call.collection === 'messages' && call.query.$or),
    'legacy reads remain active during the dual-write migration phase'
  );

  await store.close?.();
});

test('mongo store listConversations groups and sorts by conversation, newest first', async () => {
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
  assert.equal(
    (conversations[0].lastMessage as any)._id,
    undefined,
    'driver _id is not leaked'
  );
  assert.equal(conversations[0].unreadCount, 1);
  assert.equal(conversations[1].peerId, 'carol');
  assert.equal(
    conversations[1].unreadCount,
    0,
    'alice sent this message, so it is not unread for her'
  );

  await store.close?.();
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
  assert.equal(
    (await store.listConversations('alice'))[0].unreadCount,
    1,
    'bob→alice reply still unread'
  );

  await store.close?.();
});
