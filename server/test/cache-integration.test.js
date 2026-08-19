'use strict';

/**
 * Integration tests for the shared read cache in front of the chat endpoints:
 * `GET /conversations`, the first page of `GET /messages`, and `GET /calls`.
 *
 * The assertions focus on the two properties that matter operationally:
 * repeated reads inside the TTL do not hit the store, and every write path
 * evicts precisely enough that no participant can observe a stale read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createServer } = require('../src/index.js');
const { createMemoryMessageStore } = require('../src/messageStore');
const { createMemoryMessageBus } = require('../src/messageBus');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Wrap a memory message store, counting how often each read reaches it.
 *
 * @returns {{ store: object, counts: { listMessages: number, listConversations: number } }}
 */
function createCountingMessageStore() {
  const inner = createMemoryMessageStore();
  const counts = { listMessages: 0, listConversations: 0 };
  return {
    counts,
    store: {
      ...inner,
      async listMessages(query) {
        counts.listMessages += 1;
        return inner.listMessages(query);
      },
      async listConversations(userId) {
        counts.listConversations += 1;
        return inner.listConversations(userId);
      },
    },
  };
}

async function startServer(opts = {}) {
  const server = createServer(opts);
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  const url = `http://127.0.0.1:${port}`;

  async function teardown() {
    server.httpServer.closeAllConnections?.();
    await new Promise((resolve) => server.io.close(() => server.httpServer.close(resolve)));
  }

  return { ...server, url, teardown };
}

async function postJson(url, path, body, sessionId) {
  const payload = sessionId ? { ...body, sessionId } : body;
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(url, path, sessionId) {
  const pathname = sessionId
    ? `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(sessionId)}`
    : path;
  const response = await fetch(`${url}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function createSession(url, userId, deviceId = `device-${userId}`) {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

async function connectSocket(url, sessionId) {
  const { io: ioClient } = require('socket.io-client');
  const socket = ioClient(url, { auth: { sessionId } });
  await new Promise((resolve) => socket.once('connect', resolve));
  return socket;
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

const VERSION = 1;

// ─── Cache hits ───────────────────────────────────────────────────────────────

test('GET /conversations is served from cache on a repeat request', async (t) => {
  const { store, counts } = createCountingMessageStore();
  const { url, teardown } = await startServer({ messageStore: store });
  t.after(teardown);

  const aliceSession = await createSession(url, 'cache-alice');
  await createSession(url, 'cache-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'cache-bob',
    body: 'hello',
  });

  const first = await getJson(url, '/conversations', aliceSession);
  assert.equal(first.status, 200);
  assert.equal(first.body.conversations.length, 1);
  const afterFirst = counts.listConversations;

  const second = await getJson(url, '/conversations', aliceSession);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.conversations, first.body.conversations);
  assert.equal(counts.listConversations, afterFirst, 'repeat read must not hit the store');
});

test('GET /messages first page is cached but deep pagination is not', async (t) => {
  const { store, counts } = createCountingMessageStore();
  const { url, teardown } = await startServer({ messageStore: store });
  t.after(teardown);

  const aliceSession = await createSession(url, 'cache-alice');
  await createSession(url, 'cache-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'cache-bob',
    body: 'hello',
  });

  const first = await getJson(url, '/messages?peerId=cache-bob', aliceSession);
  assert.equal(first.status, 200);
  assert.equal(first.body.messages.length, 1);
  const afterFirst = counts.listMessages;

  const second = await getJson(url, '/messages?peerId=cache-bob', aliceSession);
  assert.deepEqual(second.body.messages, first.body.messages);
  assert.equal(counts.listMessages, afterFirst, 'repeat first-page read must not hit the store');

  // `before` cursors are deliberately uncached.
  const cursor = encodeURIComponent(first.body.messages[0].createdAt);
  await getJson(url, `/messages?peerId=cache-bob&before=${cursor}`, aliceSession);
  await getJson(url, `/messages?peerId=cache-bob&before=${cursor}`, aliceSession);
  assert.equal(counts.listMessages, afterFirst + 2, 'paginated reads always hit the store');
});

test('cache hits and misses are exposed through the telemetry counters', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'cache-alice');
  await getJson(url, '/conversations', aliceSession);
  await getJson(url, '/conversations', aliceSession);

  const metrics = await getJson(url, '/metrics');
  assert.equal(metrics.status, 200);
  assert.equal(metrics.body.counters.cache_misses, 1);
  assert.equal(metrics.body.counters.cache_hits, 1);
  assert.equal(metrics.body.derived.cache_hit_rate, 0.5);
});

// ─── Invalidation ─────────────────────────────────────────────────────────────

test('a new message refreshes both participants conversation lists', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'cache-alice');
  const bobSession = await createSession(url, 'cache-bob');
  const alice = await connectSocket(url, aliceSession);
  const bob = await connectSocket(url, bobSession);
  t.after(() => {
    alice.disconnect();
    bob.disconnect();
  });

  // Warm both users' caches while the conversation is still empty.
  assert.deepEqual((await getJson(url, '/conversations', aliceSession)).body.conversations, []);
  assert.deepEqual((await getJson(url, '/conversations', bobSession)).body.conversations, []);
  const emptyHistory = await getJson(url, '/messages?peerId=cache-bob', aliceSession);
  assert.deepEqual(emptyHistory.body.messages, []);

  const received = new Promise((resolve) => bob.once('message.received', resolve));
  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'cache-bob',
    body: 'hello bob',
  });
  await received;

  const aliceList = await getJson(url, '/conversations', aliceSession);
  assert.equal(aliceList.body.conversations.length, 1);
  assert.equal(aliceList.body.conversations[0].lastMessage.body, 'hello bob');

  const bobList = await getJson(url, '/conversations', bobSession);
  assert.equal(bobList.body.conversations.length, 1);
  assert.equal(bobList.body.conversations[0].unreadCount, 1);

  const aliceHistory = await getJson(url, '/messages?peerId=cache-bob', aliceSession);
  assert.equal(aliceHistory.body.messages.length, 1);
});

test('POST /messages/read refreshes the sender unread count', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'cache-alice');
  const bobSession = await createSession(url, 'cache-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'cache-bob',
    body: 'hello bob',
  });

  // Warm both lists so a stale read would be observable.
  const warmBob = await getJson(url, '/conversations', bobSession);
  assert.equal(warmBob.body.conversations[0].unreadCount, 1);
  const warmAlice = await getJson(url, '/conversations', aliceSession);
  assert.equal(warmAlice.body.conversations.length, 1);

  const read = await postJson(url, '/messages/read', { peerId: 'cache-alice' }, bobSession);
  assert.equal(read.status, 200);
  assert.equal(read.body.updated, 1);

  const bobList = await getJson(url, '/conversations', bobSession);
  assert.equal(bobList.body.conversations[0].unreadCount, 0);

  const aliceHistory = await getJson(url, '/messages?peerId=cache-bob', aliceSession);
  assert.equal(typeof aliceHistory.body.messages[0].readAt, 'string');
});

test('creating a call invalidates the cached call history of both participants', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'cache-alice');
  const bobSession = await createSession(url, 'cache-bob');

  assert.deepEqual((await getJson(url, '/calls', aliceSession)).body.calls, []);
  assert.deepEqual((await getJson(url, '/calls', bobSession)).body.calls, []);

  const created = await postJson(url, '/calls', { calleeId: 'cache-bob' }, aliceSession);
  assert.equal(created.status, 201);

  assert.equal((await getJson(url, '/calls', aliceSession)).body.calls.length, 1);
  assert.equal((await getJson(url, '/calls', bobSession)).body.calls.length, 1);
});

// ─── Cross-instance invalidation ──────────────────────────────────────────────

test('a write on one instance invalidates the cached read of another instance', async (t) => {
  // Two instances sharing one message store and one bus, each with its own
  // in-process cache — the shape of a REDIS_URL deployment behind a balancer.
  const messageStore = createMemoryMessageStore();
  const messageBus = createMemoryMessageBus();
  t.after(() => messageBus.close());

  const instanceA = await startServer({ messageStore, messageBus });
  const instanceB = await startServer({ messageStore, messageBus });
  t.after(instanceA.teardown);
  t.after(instanceB.teardown);

  const aliceSession = await createSession(instanceA.url, 'xi-alice');
  const bobSessionOnB = await createSession(instanceB.url, 'xi-bob');
  const alice = await connectSocket(instanceA.url, aliceSession);
  t.after(() => alice.disconnect());

  // Warm instance B's cache while the conversation is still empty.
  const warm = await getJson(instanceB.url, '/conversations', bobSessionOnB);
  assert.deepEqual(warm.body.conversations, []);

  // Write on instance A.
  const ack = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'xi-bob',
    body: 'across instances',
  });
  assert.equal(ack.ok, true);

  // Let the bus deliver the invalidation to instance B.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const fresh = await getJson(instanceB.url, '/conversations', bobSessionOnB);
  assert.equal(fresh.body.conversations.length, 1);
  assert.equal(fresh.body.conversations[0].lastMessage.body, 'across instances');
});
