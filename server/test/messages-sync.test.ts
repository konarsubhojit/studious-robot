import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';

import { API_ROUTES } from '../../shared/index.ts';
import { closeTestServer, getJson, listenOnRandomPort, postJson } from './helpers.ts';
import { createMemoryMessageStore } from '../src/messageStore.ts';
import { createServer } from '../src/index.ts';

const VERSION = 2;

async function startServer(opts = {}) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;
  return { ...server, url, teardown: () => closeTestServer(server) };
}

async function createSession(url: string, userId: string): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId: `device-${userId}` });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

async function connectSocket(url: string, sessionId: string) {
  const socket = ioClient(url, { auth: { sessionId } });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  return socket;
}

function emitWithAck(socket: import('socket.io-client').Socket, event: string, payload: unknown) {
  return new Promise<any>((resolve) => socket.emit(event, payload, resolve));
}

async function sendMessage(socket: import('socket.io-client').Socket, recipientId: string, body: string) {
  const ack = await emitWithAck(socket, 'message.send', { version: VERSION, recipientId, body });
  assert.equal(ack.ok, true);
  return ack.message;
}

const since = '2000-01-01T00:00:00.000Z';

test('GET /messages/sync requires a valid session and since timestamp', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  assert.equal((await getJson(url, `${API_ROUTES.MESSAGES_SYNC}?since=${since}`, 'bad')).status, 401);
  const session = await createSession(url, 'sync-input-alice');
  assert.equal((await getJson(url, API_ROUTES.MESSAGES_SYNC, session)).status, 400);
  assert.equal(
    (await getJson(url, `${API_ROUTES.MESSAGES_SYNC}?since=invalid`, session)).status,
    400
  );
});

test('GET /messages/sync returns ordered, participant-scoped pages', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'sync-alice');
  const carolSession = await createSession(url, 'sync-carol');
  await createSession(url, 'sync-bob');
  await createSession(url, 'sync-dave');
  const alice = await connectSocket(url, aliceSession);
  const carol = await connectSocket(url, carolSession);
  t.after(() => alice.disconnect());
  t.after(() => carol.disconnect());

  await sendMessage(alice, 'sync-bob', 'first delta');
  await sendMessage(alice, 'sync-carol', 'second delta');
  await sendMessage(carol, 'sync-dave', 'not Alice’s message');

  const first = await getJson(
    url,
    `${API_ROUTES.MESSAGES_SYNC}?since=${since}&limit=1`,
    aliceSession
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.changes[0].type, 'new');
  assert.equal(first.body.changes[0].message.body, 'first delta');
  assert.equal(first.body.hasMore, true);
  assert.equal(typeof first.body.nextCursor, 'string');

  const second = await getJson(
    url,
    `${API_ROUTES.MESSAGES_SYNC}?since=${since}&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    aliceSession
  );
  assert.equal(second.status, 200, `${JSON.stringify(second.body)} cursor=${first.body.nextCursor}`);
  assert.deepEqual(second.body.changes.map((change: any) => change.message.body), ['second delta']);
  assert.equal(second.body.hasMore, false);
});

test('GET /messages/sync hides a conversation after either participant blocks', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'sync-block-alice');
  await createSession(url, 'sync-block-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());
  await sendMessage(alice, 'sync-block-bob', 'private delta');

  assert.equal(
    (await getJson(url, `${API_ROUTES.MESSAGES_SYNC}?since=${since}`, aliceSession)).body.changes.length,
    1
  );
  assert.equal(
    (await postJson(url, '/blocks', { blockeeId: 'sync-block-bob' }, aliceSession)).status,
    200
  );
  assert.deepEqual(
    (await getJson(url, `${API_ROUTES.MESSAGES_SYNC}?since=${since}`, aliceSession)).body.changes,
    []
  );
});

test('the in-memory change log records new, reaction, and deletion deltas', async () => {
  const store = createMemoryMessageStore();
  const saved = await store.saveMessage({
    messageId: 'sync-message',
    conversationId: 'sync-alice:sync-bob',
    senderId: 'sync-alice',
    recipientId: 'sync-bob',
    body: 'a message',
  });
  await store.reactToMessage({
    conversationId: saved.conversationId,
    messageId: saved.messageId,
    userId: 'sync-bob',
    emoji: '👍',
    action: 'add',
  });
  await store.deleteMessage(saved.conversationId, saved.messageId, saved.senderId);

  const changes = await store.listMessageChanges?.({ userId: 'sync-alice', since });
  assert.deepEqual(changes?.map((change) => change.type), ['new', 'reactions', 'deleted']);
  assert.equal(changes?.[2].message.deletedAt !== null, true);
  assert.deepEqual(changes?.[1].message.reactions, { '👍': ['sync-bob'] });
});

test('search and sync honor the configured message-retention cutoff', async (t) => {
  const store = createMemoryMessageStore();
  await store.saveMessage({
    messageId: 'expired-message',
    conversationId: 'retention-alice:retention-bob',
    senderId: 'retention-alice',
    recipientId: 'retention-bob',
    body: 'expired lunch',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  const { url, teardown } = await startServer({ messageStore: store, messageRetentionMs: 1000 });
  t.after(teardown);
  const session = await createSession(url, 'retention-alice');

  const search = await getJson(url, `${API_ROUTES.MESSAGES_SEARCH}?q=lunch`, session);
  assert.deepEqual(search.body.results, []);
  const sync = await getJson(url, `${API_ROUTES.MESSAGES_SYNC}?since=${since}`, session);
  assert.deepEqual(sync.body.changes, []);
});

test('GET /messages/sync rate limits each authenticated caller', async (t) => {
  const { url, teardown } = await startServer({ messageSyncRateLimit: 1 });
  t.after(teardown);
  const session = await createSession(url, 'sync-limited-alice');

  assert.equal(
    (await getJson(url, `${API_ROUTES.MESSAGES_SYNC}?since=${since}`, session)).status,
    200
  );
  assert.equal(
    (await getJson(url, `${API_ROUTES.MESSAGES_SYNC}?since=${since}`, session)).status,
    429
  );
});
