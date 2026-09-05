/**
 * Integration tests for the text-chat surface: the `message.*` socket events
 * (send, delivered, typing), the `GET /messages` history endpoint, the
 * `GET /conversations` chat-list summary, and the `POST /messages/read`
 * read-receipt endpoint (including its realtime `message.read` broadcast).
 */

import test from 'node:test';
import { pushSenders } from '../src/push.ts';
import assert from 'node:assert/strict';
import { asMessageStore, closeTestServer, getJson, listenOnRandomPort, postJson } from './helpers.ts';
import { createServer } from '../src/index.ts';
import { io as ioClient } from 'socket.io-client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Replace `sendMessagePush` with a spy; mirrors `push-fallback.test.js`. */
function spyOnMessagePush() {
  const mod = pushSenders;
  const original = mod.sendMessagePush;
  const calls: { channel: any; messageData: any; }[] = [];
  mod.sendMessagePush = async (channel: any, messageData: any) => {
    calls.push({ channel, messageData });
    return { ok: true, provider: channel.provider, deviceId: channel.deviceId };
  };
  return {
    calls,
    restore: () => {
      mod.sendMessagePush = original;
    },
  };
}

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

/**
 * Connect a socket.io client and wait for the connection to establish.
 *
 * @param url - Base URL of the server under test.
 * @param sessionId - Omitted for an unauthenticated guest socket.
 */
async function connectSocket(url: string, sessionId?: string): Promise<import('socket.io-client').Socket> {
  const socket = ioClient(url, { auth: { sessionId } });
  await new Promise((resolve) => socket.once('connect', () => resolve(undefined)));
  return socket;
}

/**
 * Emit an event and resolve with its acknowledgement.
 *
 * @returns the server's acknowledgement
 */
function emitWithAck(socket: import('socket.io-client').Socket, event: string, payload: unknown): Promise<any> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

const VERSION = 1;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(assertion: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(await assertion(), 'condition was not met before timeout');
}

// ─── message.send ─────────────────────────────────────────────────────────────

test('message.send delivers to the recipient and acks the sender', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'msg-alice');
  const bobSession = await createSession(url, 'msg-bob');

  const alice = await connectSocket(url, aliceSession);
  const bob = await connectSocket(url, bobSession);
  t.after(() => {
    alice.disconnect();
    bob.disconnect();
  });

  const received = new Promise<any>((resolve) => bob.once('message.received', resolve));
  const delivered = new Promise<any>((resolve) => alice.once('message.delivered', resolve));

  const ack = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'msg-bob',
    body: 'hello bob',
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.version, VERSION);
  assert.equal(ack.event, 'message.send');
  assert.equal(ack.message.body, 'hello bob');
  assert.equal(ack.message.senderId, 'msg-alice');
  assert.equal(ack.message.recipientId, 'msg-bob');
  assert.equal(typeof ack.message.messageId, 'string');

  const envelope = await received;
  assert.equal(envelope.version, VERSION);
  assert.equal(envelope.message.messageId, ack.message.messageId);
  assert.equal(envelope.message.body, 'hello bob');

  const confirmation = await delivered;
  assert.equal(confirmation.messageId, ack.message.messageId);
});

test('message.send acks after fan-out without waiting for persistence', async (t) => {
  const deferred = createDeferred<any>();
  const saved: any[] = [];
  const messageStore = asMessageStore({
    type: 'memory' as const,
    async saveMessage(message: any) {
      const resolved = await deferred.promise;
      saved.push(resolved);
      return resolved;
    },
    async listMessages() {
      return saved;
    },
    async searchMessages() {
      return [];
    },
    markDelivered: async () => null,
    enqueueDeliveryReceipt() {},
    async flushDeliveryReceipts() {},
    async listConversations() {
      return [];
    },
    async markRead() {
      return 0;
    },
    async deleteMessage() {
      return null;
    },
    async reactToMessage() {
      return null;
    },
  });
  const { url, teardown } = await startServer({ messageStore });
  t.after(teardown);

  const aliceSession = await createSession(url, 'ack-alice');
  const bobSession = await createSession(url, 'ack-bob');
  const alice = await connectSocket(url, aliceSession);
  const bob = await connectSocket(url, bobSession);
  t.after(() => {
    alice.disconnect();
    bob.disconnect();
  });

  const received = new Promise<any>((resolve) => bob.once('message.received', resolve));
  const ackPromise = emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'ack-bob',
    body: 'fast ack',
  });

  const envelope = await received;
  const ack = await Promise.race([
    ackPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('ack waited for persistence')), 100)),
  ]);
  assert.equal((ack as any).ok, true);
  assert.equal((ack as any).message.messageId, envelope.message.messageId);
  assert.equal(saved.length, 0, 'saveMessage has not completed when the ack is emitted');

  deferred.resolve(envelope.message);
  await waitForCondition(() => saved.length === 1);
});

test('message.send surfaces asynchronous persistence failures in telemetry', async (t) => {
  const messageStore = asMessageStore({
    type: 'memory' as const,
    async saveMessage() {
      throw new Error('store down');
    },
    async listMessages() {
      return [];
    },
    async searchMessages() {
      return [];
    },
    markDelivered: async () => null,
    enqueueDeliveryReceipt() {},
    async flushDeliveryReceipts() {},
    async listConversations() {
      return [];
    },
    async markRead() {
      return 0;
    },
    async deleteMessage() {
      return null;
    },
    async reactToMessage() {
      return null;
    },
  });
  const { url, teardown, getMetrics } = await startServer({ messageStore });
  t.after(teardown);

  const aliceSession = await createSession(url, 'persist-alice');
  await createSession(url, 'persist-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  const ack = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'persist-bob',
    body: 'accepted despite store outage',
  });
  assert.equal(ack.ok, true);

  await waitForCondition(() => getMetrics().counters.message_persist_errors === 1);
});

test('message.send records a delivery receipt when the recipient is connected', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'msg-alice');
  const bobSession = await createSession(url, 'msg-bob');

  const alice = await connectSocket(url, aliceSession);
  const bob = await connectSocket(url, bobSession);
  t.after(() => {
    alice.disconnect();
    bob.disconnect();
  });

  const delivered = new Promise<any>((resolve) => alice.once('message.delivered', resolve));
  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'msg-bob',
    body: 'hello bob',
  });

  const confirmation = await delivered;
  assert.deepEqual(confirmation.message.deliveredTo, ['msg-bob']);
});

test('message.send reports no delivery receipt while the recipient is offline', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'msg-alice');
  await createSession(url, 'msg-bob');

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  const delivered = new Promise<any>((resolve) => alice.once('message.delivered', resolve));
  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'msg-bob',
    body: 'hello bob',
  });

  const confirmation = await delivered;
  assert.deepEqual(confirmation.message.deliveredTo, []);
});

test('message.send stores a replayed client messageId exactly once', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'msg-alice');
  await createSession(url, 'msg-bob');

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  const payload = {
    version: VERSION,
    recipientId: 'msg-bob',
    body: 'queued offline',
    messageId: 'client-uuid-1',
  };
  const first = await emitWithAck(alice, 'message.send', payload);
  // The sender's durable outbox replays the same send after a reconnect.
  const replay = await emitWithAck(alice, 'message.send', payload);

  assert.equal(first.ok, true);
  assert.equal(first.message.messageId, 'client-uuid-1');
  assert.equal(replay.ok, true);
  assert.equal(replay.message.messageId, 'client-uuid-1');

  const history = await getJson(url, '/messages?peerId=msg-bob', aliceSession);
  assert.equal(history.body.messages.length, 1, 'the replay must not duplicate the message');
});

test('message.send surfaces a messageId already used by another message after accept', async (t) => {
  const { url, teardown, getMetrics } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'msg-alice');
  const bobSession = await createSession(url, 'msg-bob');

  const alice = await connectSocket(url, aliceSession);
  const bob = await connectSocket(url, bobSession);
  t.after(() => {
    alice.disconnect();
    bob.disconnect();
  });

  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'msg-bob',
    body: 'the original',
    messageId: 'client-uuid-2',
  });
  await waitForCondition(async () => {
    const history = await getJson(url, '/messages?peerId=msg-bob', aliceSession);
    return history.body.messages.length === 1;
  });
  // Bob tries to overwrite Alice's message by reusing its id.
  const ack = await emitWithAck(bob, 'message.send', {
    version: VERSION,
    recipientId: 'msg-alice',
    body: 'forged',
    messageId: 'client-uuid-2',
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.message.messageId, 'client-uuid-2');
  await waitForCondition(() => getMetrics().counters.message_persist_errors === 1);

  const history = await getJson(url, '/messages?peerId=msg-bob', aliceSession);
  assert.equal(history.body.messages.length, 1);
  assert.equal(history.body.messages[0].body, 'the original');
});

test('message.send rejects a messageId that is not url-safe', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'msg-alice');
  await createSession(url, 'msg-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  const ack = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'msg-bob',
    body: 'hello',
    messageId: 'bad id\nwith newline',
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'bad_request');

  const history = await getJson(url, '/messages?peerId=msg-bob', aliceSession);
  assert.equal(history.body.messages.length, 0);
});

test('message.delete tombstones the sender own message for both participants', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'msg-alice');
  const bobSession = await createSession(url, 'msg-bob');

  const alice = await connectSocket(url, aliceSession);
  const bob = await connectSocket(url, bobSession);
  t.after(() => {
    alice.disconnect();
    bob.disconnect();
  });

  const sent = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'msg-bob',
    body: 'sent by mistake',
  });
  const { messageId } = sent.message;

  const peerNotified = new Promise<any>((resolve) => bob.once('message.deleted', resolve));
  const ack = await emitWithAck(alice, 'message.delete', {
    version: VERSION,
    peerId: 'msg-bob',
    messageId,
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.messageId, messageId);

  const notice = await peerNotified;
  assert.equal(notice.messageId, messageId);
  assert.equal(notice.deletedBy, 'msg-alice');
  assert.equal(notice.message.body, '');
  assert.ok(notice.message.deletedAt);

  // The content is gone for both participants, but the tombstone remains so a
  // reply quoting it still resolves.
  const history = await getJson(url, '/messages?peerId=msg-bob', aliceSession);
  assert.equal(history.body.messages.length, 1);
  assert.equal(history.body.messages[0].body, '');
  assert.ok(history.body.messages[0].deletedAt);
  const peerHistory = await getJson(url, '/messages?peerId=msg-alice', bobSession);
  assert.equal(peerHistory.body.messages.length, 1);
  assert.equal(peerHistory.body.messages[0].body, '');
});

test('message.delete refuses to delete the peer message', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'msg-alice');
  const bobSession = await createSession(url, 'msg-bob');

  const alice = await connectSocket(url, aliceSession);
  const bob = await connectSocket(url, bobSession);
  t.after(() => {
    alice.disconnect();
    bob.disconnect();
  });

  const sent = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'msg-bob',
    body: 'you cannot delete this',
  });

  const ack = await emitWithAck(bob, 'message.delete', {
    version: VERSION,
    peerId: 'msg-alice',
    messageId: sent.message.messageId,
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'not_found');

  const history = await getJson(url, '/messages?peerId=msg-bob', aliceSession);
  assert.equal(history.body.messages.length, 1);
});

test('message.delete rejects an unknown message and an unauthenticated caller', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'msg-alice');
  await createSession(url, 'msg-bob');
  const alice = await connectSocket(url, aliceSession);
  const guest = await connectSocket(url);
  t.after(() => {
    alice.disconnect();
    guest.disconnect();
  });

  const unknown = await emitWithAck(alice, 'message.delete', {
    version: VERSION,
    peerId: 'msg-bob',
    messageId: 'does-not-exist',
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'not_found');

  const unauthenticated = await emitWithAck(guest, 'message.delete', {
    version: VERSION,
    peerId: 'msg-bob',
    messageId: 'anything',
  });
  assert.equal(unauthenticated.ok, false);
  assert.equal(unauthenticated.error.code, 'unauthorized');
});

test('message.send rejects an unauthenticated sender', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  // No sessionId in the handshake → guest identity with no session.
  const guest = await connectSocket(url);
  t.after(() => guest.disconnect());

  const ack = await emitWithAck(guest, 'message.send', {
    version: VERSION,
    recipientId: 'msg-bob',
    body: 'hello',
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'unauthorized');
});

test('message.send rejects an unsupported version', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'ver-alice');
  const socket = await connectSocket(url, session);
  t.after(() => socket.disconnect());

  const ack = await emitWithAck(socket, 'message.send', {
    version: 99,
    recipientId: 'ver-bob',
    body: 'hello',
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'unsupported_version');
});

test('message.send rate limits each authenticated sender', async (t) => {
  const { url, teardown } = await startServer({ messageRateLimit: 1 });
  t.after(teardown);

  const session = await createSession(url, 'limited-alice');
  await createSession(url, 'limited-bob');
  const socket = await connectSocket(url, session);
  t.after(() => socket.disconnect());

  const first = await emitWithAck(socket, 'message.send', {
    version: VERSION,
    recipientId: 'limited-bob',
    body: 'first',
  });
  const second = await emitWithAck(socket, 'message.send', {
    version: VERSION,
    recipientId: 'limited-bob',
    body: 'second',
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'rate_limited');
});

test('message.send rejects empty and oversized bodies', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'body-alice');
  await createSession(url, 'body-bob');
  const socket = await connectSocket(url, session);
  t.after(() => socket.disconnect());

  const empty = await emitWithAck(socket, 'message.send', {
    version: VERSION,
    recipientId: 'body-bob',
    body: '   ',
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'bad_request');

  const oversized = await emitWithAck(socket, 'message.send', {
    version: VERSION,
    recipientId: 'body-bob',
    body: 'x'.repeat(4001),
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, 'bad_request');

  const notAString = await emitWithAck(socket, 'message.send', {
    version: VERSION,
    recipientId: 'body-bob',
    body: { text: 'nope' },
  });
  assert.equal(notAString.ok, false);
  assert.equal(notAString.error.code, 'bad_request');
});

test('message.send requires a recipient other than yourself', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'solo-alice');
  const socket = await connectSocket(url, session);
  t.after(() => socket.disconnect());

  const missing = await emitWithAck(socket, 'message.send', { version: VERSION, body: 'hi' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'bad_request');

  const self = await emitWithAck(socket, 'message.send', {
    version: VERSION,
    recipientId: 'solo-alice',
    body: 'hi',
  });
  assert.equal(self.ok, false);
  assert.equal(self.error.code, 'bad_request');
});

test('message.send is refused when the recipient blocked the sender', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'blk-alice');
  const bobSession = await createSession(url, 'blk-bob');

  const blocked = await postJson(url, '/blocks', { blockeeId: 'blk-alice' }, bobSession);
  assert.equal(blocked.status, 200);

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  const ack = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'blk-bob',
    body: 'let me in',
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'forbidden');
});

// ─── Push fallback ────────────────────────────────────────────────────────────

test('message.send pushes to an offline recipient', async (t) => {
  const spy = spyOnMessagePush();
  t.after(() => spy.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'off-alice');
  const bobSession = await createSession(url, 'off-bob');

  await postJson(url, '/devices/register', { provider: 'fcm', pushToken: 'bob-token' }, bobSession);

  // Bob never connects a socket, so he is offline.
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  const ack = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'off-bob',
    body: 'are you there?',
  });
  assert.equal(ack.ok, true);

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].channel.deviceId, 'device-off-bob');
  assert.equal(spy.calls[0].messageData.messageId, ack.message.messageId);
  assert.equal(spy.calls[0].messageData.senderId, 'off-alice');
  assert.equal(spy.calls[0].messageData.conversationId, ack.message.conversationId);
});

test('message.send does not push to a recipient who is connected', async (t) => {
  const spy = spyOnMessagePush();
  t.after(() => spy.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'on-alice');
  const bobSession = await createSession(url, 'on-bob');
  await postJson(url, '/devices/register', { provider: 'fcm', pushToken: 'bob-token' }, bobSession);

  const alice = await connectSocket(url, aliceSession);
  const bob = await connectSocket(url, bobSession);
  t.after(() => {
    alice.disconnect();
    bob.disconnect();
  });

  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'on-bob',
    body: 'hi',
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(spy.calls.length, 0);
});

// ─── GET /messages ────────────────────────────────────────────────────────────

test('GET /messages requires a valid session', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const res = await getJson(url, '/messages?peerId=someone', 'bad-session');
  assert.equal(res.status, 401);
});

test('GET /messages validates peerId', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'hist-alice');

  const missing = await getJson(url, '/messages', session);
  assert.equal(missing.status, 400);

  const self = await getJson(url, '/messages?peerId=hist-alice', session);
  assert.equal(self.status, 400);
});

test('GET /messages returns the conversation newest-first with pagination', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'page-alice');
  const bobSession = await createSession(url, 'page-bob');

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  for (let i = 0; i < 5; i++) {
    const ack = await emitWithAck(alice, 'message.send', {
      version: VERSION,
      recipientId: 'page-bob',
      body: `msg-${i}`,
    });
    assert.equal(ack.ok, true);
  }

  const first = await getJson(url, '/messages?peerId=page-bob&limit=2', aliceSession);
  assert.equal(first.status, 200);
  assert.equal(first.body.messages.length, 2);
  assert.deepEqual(
    first.body.messages.map((m: any) => m.body),
    ['msg-4', 'msg-3']
  );

  const cursor = first.body.messages[first.body.messages.length - 1].createdAt;
  const second = await getJson(
    url,
    `/messages?peerId=page-bob&limit=2&before=${encodeURIComponent(cursor)}`,
    aliceSession
  );
  assert.equal(second.status, 200);
  assert.deepEqual(
    second.body.messages.map((m: any) => m.body),
    ['msg-2', 'msg-1']
  );

  // Both participants resolve the same conversation.
  const fromBob = await getJson(url, '/messages?peerId=page-alice', bobSession);
  assert.equal(fromBob.status, 200);
  assert.equal(fromBob.body.conversationId, first.body.conversationId);
  assert.equal(fromBob.body.messages.length, 5);
});

test('GET /messages does not leak another pair conversation', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'leak-alice');
  await createSession(url, 'leak-bob');
  const carolSession = await createSession(url, 'leak-carol');

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'leak-bob',
    body: 'private',
  });

  // Carol asks for her (empty) conversation with Bob.
  const res = await getJson(url, '/messages?peerId=leak-bob', carolSession);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.messages, []);
});

// ─── GET /conversations ───────────────────────────────────────────────────────

test('GET /conversations requires a valid session', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const res = await getJson(url, '/conversations', 'bad-session');
  assert.equal(res.status, 401);
});

test('GET /conversations summarises each conversation, most recent first, with unread counts', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'conv-alice');
  await createSession(url, 'conv-bob');
  await createSession(url, 'conv-carol');

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  // Alice ↔ Bob: two messages, most recent overall.
  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'conv-bob',
    body: 'hi bob',
  });

  // Alice ↔ Carol: one older message.
  const carolAck = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'conv-carol',
    body: 'hi carol',
  });

  const bobAck = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'conv-bob',
    body: 'you there?',
  });

  const res = await getJson(url, '/conversations', aliceSession);
  assert.equal(res.status, 200);
  assert.equal(res.body.conversations.length, 2);

  const [first, second] = res.body.conversations;
  assert.equal(first.peerId, 'conv-bob');
  assert.equal(first.lastMessage.messageId, bobAck.message.messageId);
  assert.equal(first.unreadCount, 0, 'alice sent both messages, so nothing is unread for her');
  assert.equal(second.peerId, 'conv-carol');
  assert.equal(second.lastMessage.messageId, carolAck.message.messageId);

  // From Bob's perspective the two alice→bob messages are unread.
  const bobSessionId = (
    await postJson(url, '/session', { userId: 'conv-bob', deviceId: 'device-conv-bob' })
  ).body.sessionId;
  const bobRes = await getJson(url, '/conversations', bobSessionId);
  assert.equal(bobRes.status, 200);
  assert.equal(bobRes.body.conversations.length, 1);
  assert.equal(bobRes.body.conversations[0].peerId, 'conv-alice');
  assert.equal(bobRes.body.conversations[0].unreadCount, 2);
});

test("GET /conversations reports each peer's live online status", async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'convonline-alice');
  const bobSession = await createSession(url, 'convonline-bob');
  await createSession(url, 'convonline-carol');

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());
  const bob = await connectSocket(url, bobSession);
  t.after(() => bob.disconnect());

  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'convonline-bob',
    body: 'hi bob',
  });
  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'convonline-carol',
    body: 'hi carol',
  });

  const res = await getJson(url, '/conversations', aliceSession);
  assert.equal(res.status, 200);
  const byPeer = Object.fromEntries(res.body.conversations.map((c: any) => [c.peerId, c]));
  assert.equal(byPeer['convonline-bob'].online, true, 'bob has a live socket');
  assert.equal(byPeer['convonline-carol'].online, false, 'carol never connected a socket');
});

test('GET /conversations excludes conversations with a blocked user', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'convblk-alice');
  const bobSession = await createSession(url, 'convblk-bob');

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'convblk-bob',
    body: 'hi',
  });

  // Alice blocks Bob after the fact: the conversation must no longer appear.
  const blockRes = await postJson(url, '/blocks', { blockeeId: 'convblk-bob' }, aliceSession);
  assert.equal(blockRes.status, 200);

  const res = await getJson(url, '/conversations', aliceSession);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.conversations, []);

  // The reverse direction is also hidden from Bob's list.
  const bobRes = await getJson(url, '/conversations', bobSession);
  assert.equal(bobRes.status, 200);
  assert.deepEqual(bobRes.body.conversations, []);
});

// ─── POST /messages/read ──────────────────────────────────────────────────────

test('POST /messages/read requires a valid session', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const res = await postJson(url, '/messages/read', { peerId: 'someone' }, 'bad-session');
  assert.equal(res.status, 401);
});

test('POST /messages/read validates peerId', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'read-validate-alice');

  const missing = await postJson(url, '/messages/read', {}, session);
  assert.equal(missing.status, 400);

  const self = await postJson(url, '/messages/read', { peerId: 'read-validate-alice' }, session);
  assert.equal(self.status, 400);
});

test('POST /messages/read marks messages read; unread count drops to 0; idempotent', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'read-alice');
  const bobSession = await createSession(url, 'read-bob');

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'read-bob',
    body: 'one',
  });
  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'read-bob',
    body: 'two',
  });

  const before = await getJson(url, '/conversations', bobSession);
  assert.equal(before.body.conversations[0].unreadCount, 2);

  const readRes = await postJson(url, '/messages/read', { peerId: 'read-alice' }, bobSession);
  assert.equal(readRes.status, 200);
  assert.equal(readRes.body.updated, 2);
  assert.equal(typeof readRes.body.conversationId, 'string');

  const after = await getJson(url, '/conversations', bobSession);
  assert.equal(after.body.conversations[0].unreadCount, 0);

  const second = await postJson(url, '/messages/read', { peerId: 'read-alice' }, bobSession);
  assert.equal(second.status, 200);
  assert.equal(second.body.updated, 0, 'idempotent: nothing left to mark read');
});

test('POST /messages/read notifies the original sender over their live socket with message.read', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'readnotify-alice');
  const bobSession = await createSession(url, 'readnotify-bob');

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'readnotify-bob',
    body: 'hi',
  });

  const readEvent = new Promise<any>((resolve) => alice.once('message.read', resolve));

  const readRes = await postJson(url, '/messages/read', { peerId: 'readnotify-alice' }, bobSession);
  assert.equal(readRes.status, 200);
  assert.equal(readRes.body.updated, 1);

  const envelope = await readEvent;
  assert.equal(envelope.version, VERSION);
  assert.equal(envelope.conversationId, readRes.body.conversationId);
  assert.equal(envelope.readerId, 'readnotify-bob');
  assert.equal(typeof envelope.readAt, 'string');
});

test('POST /messages/read does not emit message.read when nothing was updated', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'readquiet-alice');
  const bobSession = await createSession(url, 'readquiet-bob');
  void aliceSession;

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  let received = false;
  alice.on('message.read', () => {
    received = true;
  });

  const readRes = await postJson(url, '/messages/read', { peerId: 'readquiet-alice' }, bobSession);
  assert.equal(readRes.status, 200);
  assert.equal(readRes.body.updated, 0);

  // Give any (unwanted) emit a moment to arrive before asserting it did not.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received, false);
});

// ─── message.typing ───────────────────────────────────────────────────────────

test('message.typing relays an ephemeral typing indicator to the recipient', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'typing-alice');
  const bobSession = await createSession(url, 'typing-bob');

  const alice = await connectSocket(url, aliceSession);
  const bob = await connectSocket(url, bobSession);
  t.after(() => {
    alice.disconnect();
    bob.disconnect();
  });

  const typingEvent = new Promise<any>((resolve) => bob.once('message.typing', resolve));

  alice.emit('message.typing', {
    version: VERSION,
    recipientId: 'typing-bob',
    isTyping: true,
  });

  const envelope = await typingEvent;
  assert.equal(envelope.version, VERSION);
  assert.equal(envelope.senderId, 'typing-alice');
  assert.equal(envelope.isTyping, true);
  assert.equal(typeof envelope.conversationId, 'string');
});

test('message.typing is ignored for an unauthenticated socket, an unsupported version, or a self-recipient', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'typingguard-alice');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  const guest = await connectSocket(url);
  t.after(() => guest.disconnect());

  let received = false;
  alice.on('message.typing', () => {
    received = true;
  });

  guest.emit('message.typing', {
    version: VERSION,
    recipientId: 'typingguard-alice',
    isTyping: true,
  });
  alice.emit('message.typing', { version: 99, recipientId: 'typingguard-alice', isTyping: true });
  alice.emit('message.typing', {
    version: VERSION,
    recipientId: 'typingguard-alice',
    isTyping: true,
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received, false);
});
