import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';

import { API_ROUTES } from '../../shared/index.ts';
import { closeTestServer, getJson, listenOnRandomPort, postJson } from './helpers.ts';
import { createMemoryMessageStore } from '../src/messageStore.ts';
import { createMemoryMessageBus } from '../src/messageBus.ts';
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

function deltaPath(peerId: string, cursor?: string | null, limit?: number) {
  const params = new URLSearchParams({ peerId });
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  return `${API_ROUTES.MESSAGES_DELTA}?${params.toString()}`;
}

test('GET /messages/delta validates the session, peer and cursor', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  assert.equal((await getJson(url, deltaPath('delta-v-bob'), 'bad')).status, 401);
  const session = await createSession(url, 'delta-v-alice');
  assert.equal((await getJson(url, API_ROUTES.MESSAGES_DELTA, session)).status, 400);
  assert.equal((await getJson(url, deltaPath('delta-v-alice'), session)).status, 400);
  assert.equal((await getJson(url, deltaPath('delta-v-bob', 'not-a-cursor'), session)).status, 400);
});

test('offline for N messages: one delta call returns exactly those N, and the cached empty page is not served stale', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'delta-n-alice');
  const bobSession = await createSession(url, 'delta-n-bob');
  await createSession(url, 'delta-n-carol');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await sendMessage(alice, 'delta-n-bob', 'before offline');
  await sendMessage(alice, 'delta-n-carol', 'other conversation');
  const initial = await getJson(url, deltaPath('delta-n-alice'), bobSession);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.changes.map((change: any) => change.message.body), ['before offline']);
  assert.equal(initial.body.hasMore, false);
  assert.equal(initial.body.nextCursor, null);
  const cursor = initial.body.cursor;
  assert.equal(typeof cursor, 'string');

  // Warm the cache for "nothing after cursor" so a missed eviction would show.
  const idle = await getJson(url, deltaPath('delta-n-alice', cursor), bobSession);
  assert.deepEqual(idle.body.changes, []);
  assert.equal(idle.body.cursor, cursor);

  const sent = [];
  for (let i = 1; i <= 3; i += 1) sent.push(await sendMessage(alice, 'delta-n-bob', `offline ${i}`));
  await sendMessage(alice, 'delta-n-carol', 'still elsewhere');

  const delta = await getJson(url, deltaPath('delta-n-alice', cursor), bobSession);
  assert.equal(delta.status, 200);
  assert.equal(delta.body.conversationId, sent[0].conversationId);
  assert.deepEqual(
    delta.body.changes.map((change: any) => [change.type, change.message.messageId]),
    sent.map((message) => ['new', message.messageId])
  );
  assert.equal(delta.body.limit, 3);
  assert.equal(delta.body.hasMore, false);

  const caughtUp = await getJson(url, deltaPath('delta-n-alice', delta.body.cursor), bobSession);
  assert.deepEqual(caughtUp.body.changes, []);
});

test('GET /messages/delta pages with nextCursor/hasMore', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'delta-p-alice');
  const bobSession = await createSession(url, 'delta-p-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());
  await sendMessage(alice, 'delta-p-bob', 'one');
  await sendMessage(alice, 'delta-p-bob', 'two');

  const first = await getJson(url, deltaPath('delta-p-alice', null, 1), bobSession);
  assert.deepEqual(first.body.changes.map((change: any) => change.message.body), ['one']);
  assert.equal(first.body.hasMore, true);
  assert.equal(first.body.nextCursor, first.body.cursor);

  const second = await getJson(url, deltaPath('delta-p-alice', first.body.nextCursor, 1), bobSession);
  assert.deepEqual(second.body.changes.map((change: any) => change.message.body), ['two']);
  assert.equal(second.body.hasMore, false);
  assert.equal(second.body.nextCursor, null);
});

test('deletions, reactions and read receipts made while offline arrive in the delta', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'delta-d-alice');
  const bobSession = await createSession(url, 'delta-d-bob');
  const alice = await connectSocket(url, aliceSession);
  const bob = await connectSocket(url, bobSession);
  t.after(() => alice.disconnect());
  t.after(() => bob.disconnect());

  const doomed = await sendMessage(alice, 'delta-d-bob', 'secret to delete');
  const kept = await sendMessage(alice, 'delta-d-bob', 'kept');
  const aliceCursor = (await getJson(url, deltaPath('delta-d-bob'), aliceSession)).body.cursor;
  const bobCursor = (await getJson(url, deltaPath('delta-d-alice'), bobSession)).body.cursor;

  // Bob reads and reacts while Alice is offline; Alice deletes while Bob is.
  assert.equal((await postJson(url, API_ROUTES.MESSAGES_READ, { peerId: 'delta-d-alice' }, bobSession)).status, 200);
  const reacted = await emitWithAck(bob, 'message.react', {
    version: VERSION, peerId: 'delta-d-alice', messageId: kept.messageId, emoji: '👍', action: 'add',
  });
  assert.equal(reacted.ok, true);
  const deleted = await emitWithAck(alice, 'message.delete', {
    version: VERSION, peerId: 'delta-d-bob', messageId: doomed.messageId,
  });
  assert.equal(deleted.ok, true);

  const bobDelta = await getJson(url, deltaPath('delta-d-alice', bobCursor), bobSession);
  const bobTombstone = bobDelta.body.changes.find((change: any) => change.message.messageId === doomed.messageId);
  assert.equal(bobTombstone.type, 'deleted');
  assert.notEqual(bobTombstone.message.deletedAt, null);
  assert.equal(bobTombstone.message.body, '');

  // Alice's page holds each message once, at its latest state.
  const aliceDelta = await getJson(url, deltaPath('delta-d-bob', aliceCursor), aliceSession);
  assert.deepEqual(
    aliceDelta.body.changes.map((change: any) => [change.type, change.message.messageId]),
    [['reactions', kept.messageId], ['deleted', doomed.messageId]]
  );
  const keptChange = aliceDelta.body.changes[0];
  assert.notEqual(keptChange.message.readAt, null);
  assert.deepEqual(keptChange.message.reactions, { '👍': ['delta-d-bob'] });

  // A full replay never re-exposes the deleted body.
  const replay = await getJson(url, deltaPath('delta-d-bob'), aliceSession);
  assert.equal(
    replay.body.changes.some((change: any) => change.message.body === 'secret to delete'),
    false
  );
});

test('a read receipt alone is a delta for the sender', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'delta-r-alice');
  const bobSession = await createSession(url, 'delta-r-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());
  const sent = await sendMessage(alice, 'delta-r-bob', 'read me');
  const cursor = (await getJson(url, deltaPath('delta-r-bob'), aliceSession)).body.cursor;

  await postJson(url, API_ROUTES.MESSAGES_READ, { peerId: 'delta-r-alice' }, bobSession);
  const delta = await getJson(url, deltaPath('delta-r-bob', cursor), aliceSession);
  assert.deepEqual(delta.body.changes.map((change: any) => [change.type, change.message.messageId]), [['read', sent.messageId]]);
  assert.notEqual(delta.body.changes[0].message.readAt, null);
});

test('GET /messages/delta hides a blocked conversation', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'delta-b-alice');
  await createSession(url, 'delta-b-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());
  await sendMessage(alice, 'delta-b-bob', 'private');
  assert.equal((await getJson(url, deltaPath('delta-b-bob'), aliceSession)).body.changes.length, 1);
  assert.equal((await postJson(url, '/blocks', { blockeeId: 'delta-b-bob' }, aliceSession)).status, 200);
  const hidden = await getJson(url, deltaPath('delta-b-bob'), aliceSession);
  assert.deepEqual(hidden.body.changes, []);
  assert.equal(hidden.body.cursor, null);
});

test('a write on one instance invalidates a cached delta page on another instance', async (t) => {
  const messageStore = createMemoryMessageStore();
  const messageBus = createMemoryMessageBus();
  t.after(() => messageBus.close());
  const instanceA = await startServer({ messageStore, messageBus });
  const instanceB = await startServer({ messageStore, messageBus });
  t.after(instanceA.teardown);
  t.after(instanceB.teardown);

  const aliceSession = await createSession(instanceA.url, 'delta-xi-alice');
  const bobSessionOnB = await createSession(instanceB.url, 'delta-xi-bob');
  const alice = await connectSocket(instanceA.url, aliceSession);
  t.after(() => alice.disconnect());

  const warm = await getJson(instanceB.url, deltaPath('delta-xi-alice'), bobSessionOnB);
  assert.deepEqual(warm.body.changes, []);

  const sent = await sendMessage(alice, 'delta-xi-bob', 'across instances');
  await new Promise((resolve) => setTimeout(resolve, 50));

  const fresh = await getJson(instanceB.url, deltaPath('delta-xi-alice'), bobSessionOnB);
  assert.deepEqual(fresh.body.changes.map((change: any) => change.message.messageId), [sent.messageId]);
});

test('the in-memory store records read receipts and lists one conversation at its live state', async () => {
  const store = createMemoryMessageStore();
  const saved = await store.saveMessage({
    messageId: 'delta-store-message',
    conversationId: 'delta-store-alice:delta-store-bob',
    senderId: 'delta-store-alice',
    recipientId: 'delta-store-bob',
    body: 'hello',
  });
  await store.saveMessage({
    messageId: 'other-conversation',
    conversationId: 'delta-store-alice:delta-store-carol',
    senderId: 'delta-store-alice',
    recipientId: 'delta-store-carol',
    body: 'elsewhere',
  });
  assert.equal(await store.markRead(saved.conversationId, 'delta-store-bob'), 1);
  await store.deleteMessage(saved.conversationId, saved.messageId, saved.senderId);

  const changes = await store.listConversationChanges?.({ conversationId: saved.conversationId });
  assert.deepEqual(changes?.map((change) => change.type), ['new', 'read', 'deleted']);
  for (const change of changes ?? []) {
    assert.equal(change.message.body, '');
    assert.notEqual(change.message.deletedAt, null);
  }
  const after = await store.listConversationChanges?.({
    conversationId: saved.conversationId,
    afterChangedAt: changes?.[1].changedAt,
    afterChangeId: changes?.[1].changeId,
  });
  assert.deepEqual(after?.map((change) => change.type), ['deleted']);
});
