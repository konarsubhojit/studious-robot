'use strict';

/**
 * Integration tests for the text-chat surface: the `message.*` socket events
 * and the `GET /messages` history endpoint.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const pushModulePath = require.resolve('../src/push.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Replace `sendMessagePush` with a spy; mirrors `push-fallback.test.js`. */
function spyOnMessagePush() {
  const mod = require(pushModulePath);
  const original = mod.sendMessagePush;
  const calls = [];
  mod.sendMessagePush = async (channel, messageData) => {
    calls.push({ channel, messageData });
    return { ok: true, provider: channel.provider, deviceId: channel.deviceId };
  };
  return { calls, restore: () => { mod.sendMessagePush = original; } };
}

async function startServer() {
  const { createServer } = require('../src/index.js');
  const server = createServer();
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

/** Connect a socket.io client and wait for the connection to establish. */
async function connectSocket(url, sessionId) {
  const { io: ioClient } = require('socket.io-client');
  const socket = ioClient(url, { auth: { sessionId } });
  await new Promise((resolve) => socket.once('connect', resolve));
  return socket;
}

/** Emit an event and resolve with its acknowledgement. */
function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

const VERSION = 1;

// ─── message.send ─────────────────────────────────────────────────────────────

test('message.send delivers to the recipient and acks the sender', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'msg-alice');
  const bobSession = await createSession(url, 'msg-bob');

  const alice = await connectSocket(url, aliceSession);
  const bob = await connectSocket(url, bobSession);
  t.after(() => { alice.disconnect(); bob.disconnect(); });

  const received = new Promise((resolve) => bob.once('message.received', resolve));
  const delivered = new Promise((resolve) => alice.once('message.delivered', resolve));

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

test('message.send rejects an unauthenticated sender', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  // No sessionId in the handshake → guest identity with no session.
  const guest = await connectSocket(url, undefined);
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
  t.after(() => { alice.disconnect(); bob.disconnect(); });

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
  assert.deepEqual(first.body.messages.map((m) => m.body), ['msg-4', 'msg-3']);

  const cursor = first.body.messages[first.body.messages.length - 1].createdAt;
  const second = await getJson(
    url,
    `/messages?peerId=page-bob&limit=2&before=${encodeURIComponent(cursor)}`,
    aliceSession,
  );
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.messages.map((m) => m.body), ['msg-2', 'msg-1']);

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
