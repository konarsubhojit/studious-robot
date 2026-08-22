// @ts-check
'use strict';

/**
 * Integration tests for `GET /messages/search`: the authorization boundary
 * (a caller only ever sees messages they took part in), blocklist visibility,
 * pagination and rate limiting.
 *
 * Mirrors the helper style of `messages.test.js` / `messages-timeline.test.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

const { API_ROUTES } = require('../../shared');
const { getJson, listenOnRandomPort, postJson } = require('./helpers');

const VERSION = 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function startServer(opts = {}) {
  const { createServer } = require('../src/index.js');
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  async function teardown() {
    server.httpServer.closeAllConnections?.();
    await new Promise((resolve) =>
      server.io.close(() => server.httpServer.close(() => resolve(undefined)))
    );
  }

  return { ...server, url, teardown };
}

/**
 * @param {string} url - Base URL of the server under test.
 * @param {string} userId
 * @param {string} [deviceId]
 * @returns {Promise<string>} the created session id
 */
async function createSession(url, userId, deviceId = `device-${userId}`) {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

async function connectSocket(/** @type {any} */ url, /** @type {any} */ sessionId) {
  const socket = ioClient(url, { auth: { sessionId } });
  await new Promise((resolve) => socket.once('connect', () => resolve(undefined)));
  return socket;
}

/**
 * @param {import('socket.io-client').Socket} socket
 * @param {string} event
 * @param {unknown} payload
 * @returns {Promise<any>} the server's acknowledgement
 */
function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function sendMessage(/** @type {any} */ socket, /** @type {any} */ recipientId, /** @type {any} */ body) {
  const ack = await emitWithAck(socket, 'message.send', {
    version: VERSION,
    recipientId,
    body,
  });
  assert.equal(ack.ok, true);
  return ack.message;
}

function searchPath(/** @type {any} */ term, extra = '') {
  return `${API_ROUTES.MESSAGES_SEARCH}?q=${encodeURIComponent(term)}${extra}`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('GET /messages/search requires a valid session', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const res = await getJson(url, searchPath('hello'), 'bad-session');
  assert.equal(res.status, 401);
});

test('GET /messages/search requires a query term', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'search-alice');

  const missing = await getJson(url, API_ROUTES.MESSAGES_SEARCH, session);
  assert.equal(missing.status, 400);

  const blank = await getJson(url, searchPath('   '), session);
  assert.equal(blank.status, 400);
});

test('GET /messages/search returns the caller matches newest-first with a peer id', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'find-alice');
  await createSession(url, 'find-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await sendMessage(alice, 'find-bob', 'lunch at noon');
  await sendMessage(alice, 'find-bob', 'dinner later');
  await sendMessage(alice, 'find-bob', 'Lunch tomorrow?');

  const res = await getJson(url, searchPath('lunch'), aliceSession);
  assert.equal(res.status, 200);
  assert.equal(res.body.query, 'lunch');
  assert.deepEqual(
    res.body.results.map((/** @type {any} */ m) => m.body),
    ['Lunch tomorrow?', 'lunch at noon']
  );
  // Enough context to deep-link into the conversation at that message.
  assert.equal(res.body.results[0].peerId, 'find-bob');
  assert.ok(res.body.results[0].conversationId);
  assert.ok(res.body.results[0].messageId);
  assert.ok(res.body.results[0].createdAt);
});

test('GET /messages/search never returns another pair conversation', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'peek-alice');
  await createSession(url, 'peek-bob');
  const carolSession = await createSession(url, 'peek-carol');

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());
  await sendMessage(alice, 'peek-bob', 'secret plan');

  // Carol was never a participant: the term matches a stored message, but not
  // one of hers.
  const carol = await getJson(url, searchPath('secret'), carolSession);
  assert.equal(carol.status, 200);
  assert.deepEqual(carol.body.results, []);

  // Both participants of the conversation do see it.
  const fromAlice = await getJson(url, searchPath('secret'), aliceSession);
  assert.equal(fromAlice.body.results.length, 1);
});

test('GET /messages/search paginates with a before cursor', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'cursor-alice');
  await createSession(url, 'cursor-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  for (let i = 0; i < 4; i++) {
    await sendMessage(alice, 'cursor-bob', `note ${i}`);
  }

  const first = await getJson(url, searchPath('note', '&limit=2'), aliceSession);
  assert.deepEqual(
    first.body.results.map((/** @type {any} */ m) => m.body),
    ['note 3', 'note 2']
  );

  const cursor = first.body.results[first.body.results.length - 1].createdAt;
  const second = await getJson(
    url,
    searchPath('note', `&limit=2&before=${encodeURIComponent(cursor)}`),
    aliceSession
  );
  assert.deepEqual(
    second.body.results.map((/** @type {any} */ m) => m.body),
    ['note 1', 'note 0']
  );
});

test('GET /messages/search hides a blocked peer conversation', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'block-search-alice');
  await createSession(url, 'block-search-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await sendMessage(alice, 'block-search-bob', 'match me');

  const before = await getJson(url, searchPath('match'), aliceSession);
  assert.equal(before.body.results.length, 1);

  const blocked = await postJson(
    url,
    '/blocks',
    { blockeeId: 'block-search-bob' },
    aliceSession
  );
  assert.equal(blocked.status, 200);

  const after = await getJson(url, searchPath('match'), aliceSession);
  assert.deepEqual(after.body.results, []);
});

test('GET /messages/search matches the term literally', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'regex-alice');
  await createSession(url, 'regex-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await sendMessage(alice, 'regex-bob', 'plain text');

  // A regular expression must not be interpreted as one.
  const res = await getJson(url, searchPath('.*'), aliceSession);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results, []);
});

test('GET /messages/search rate limits each authenticated caller', async (t) => {
  const { url, teardown } = await startServer({ messageSearchRateLimit: 1 });
  t.after(teardown);

  const session = await createSession(url, 'ratelimited-alice');

  const first = await getJson(url, searchPath('anything'), session);
  assert.equal(first.status, 200);

  const second = await getJson(url, searchPath('anything'), session);
  assert.equal(second.status, 429);
  assert.equal(second.body.error, 'too many requests');
});

test('GET /messages/search reports an unavailable store', async (t) => {
  const failingStore = {
    type: 'memory',
    async ready() {},
    async saveMessage(/** @type {any} */ message) {
      return message;
    },
    async listMessages() {
      return [];
    },
    async searchMessages() {
      throw new Error('store down');
    },
    async markDelivered() {
      return null;
    },
    async listConversations() {
      return [];
    },
    async markRead() {
      return 0;
    },
    async deleteMessage() {
      return null;
    },
    async close() {},
  };
  const { url, teardown } = await startServer({ messageStore: failingStore });
  t.after(teardown);

  const session = await createSession(url, 'degraded-alice');
  const res = await getJson(url, searchPath('anything'), session);
  assert.equal(res.status, 503);
});

test('GET /messages/search drops a result the caller did not take part in', async (t) => {
  // A store that (wrongly) hands back somebody else's message: the route's
  // defence-in-depth filter must remove it without failing the whole page.
  const leakyStore = {
    type: 'memory',
    async ready() {},
    async saveMessage(/** @type {any} */ message) {
      return message;
    },
    async listMessages() {
      return [];
    },
    async searchMessages(/** @type {{ userId: string }} */ { userId }) {
      return [
        {
          messageId: 'm-own',
          conversationId: 'c-own',
          senderId: userId,
          recipientId: 'bob',
          body: 'note to bob',
          createdAt: new Date().toISOString(),
        },
        {
          messageId: 'm-foreign',
          conversationId: 'c-foreign',
          senderId: 'carol',
          recipientId: 'dave',
          body: 'note between strangers',
          createdAt: new Date().toISOString(),
        },
      ];
    },
    async markDelivered() {
      return null;
    },
    async listConversations() {
      return [];
    },
    async markRead() {
      return 0;
    },
    async deleteMessage() {
      return null;
    },
    async close() {},
  };
  const { url, teardown } = await startServer({ messageStore: leakyStore });
  t.after(teardown);

  const session = await createSession(url, 'leaky-alice');
  const res = await getJson(url, searchPath('note'), session);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.results.map((/** @type {any} */ message) => message.messageId),
    ['m-own']
  );
});
