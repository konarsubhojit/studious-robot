/**
 * Integration tests for `GET /messages/search`: the authorization boundary
 * (a caller only ever sees messages they took part in), blocklist visibility,
 * pagination and rate limiting.
 *
 * Mirrors the helper style of `messages.test.js` / `messages-timeline.test.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';

import { API_ROUTES } from '../../shared/index.ts';
import { closeTestServer, getJson, listenOnRandomPort, postJson } from './helpers.ts';
import { createServer } from '../src/index.ts';

const VERSION = 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function startServer(opts = {}) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  async function teardown() {
    await closeTestServer(server);
  }

  return { ...server, url, teardown };
}

/**
 * @param url - Base URL of the server under test.
 * @returns the created session id
 */
async function createSession(url: string, userId: string, deviceId: string = `device-${userId}`): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

async function connectSocket(url: any, sessionId: any) {
  const socket = ioClient(url, { auth: { sessionId } });
  await new Promise((resolve) => socket.once('connect', () => resolve(undefined)));
  return socket;
}

/**
 * @returns the server's acknowledgement
 */
function emitWithAck(socket: import('socket.io-client').Socket, event: string, payload: unknown): Promise<any> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function sendMessage(socket: any, recipientId: any, body: any) {
  const ack = await emitWithAck(socket, 'message.send', {
    version: VERSION,
    recipientId,
    body,
  });
  assert.equal(ack.ok, true);
  return ack.message;
}

function searchPath(term: any, extra = '') {
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
    res.body.results.map((m: any) => m.body),
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
    first.body.results.map((m: any) => m.body),
    ['note 3', 'note 2']
  );

  const cursor = first.body.results[first.body.results.length - 1].createdAt;
  const second = await getJson(
    url,
    searchPath('note', `&limit=2&before=${encodeURIComponent(cursor)}`),
    aliceSession
  );
  assert.deepEqual(
    second.body.results.map((m: any) => m.body),
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
    async saveMessage(message: any) {
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
    async saveMessage(message: any) {
      return message;
    },
    async listMessages() {
      return [];
    },
    async searchMessages({ userId }: { userId: string; }) {
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
    res.body.results.map((message: any) => message.messageId),
    ['m-own']
  );
});
