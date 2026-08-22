// @ts-check
'use strict';

/**
 * Integration tests for rich messaging: attachment presigning against
 * Cloudflare R2, attachment/reply validation on `message.send`, reaction
 * fan-out, delete-for-everyone tombstones, and the backwards-compatibility
 * rule that an unknown message `type` must render as a neutral placeholder
 * rather than crash a client.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { getJson, listenOnRandomPort, postJson } = require('./helpers');

const {
  MESSAGE_TYPES,
  describeMessagePreview,
  messageTypeOf,
  parseEventPayload,
  SERVER_EVENTS,
} = require('../../shared');

const pushModulePath = require.resolve('../src/push.js');

const R2_ENV = {
  R2_ACCOUNT_ID: 'test-account',
  R2_BUCKET: 'wetalk-media',
  R2_ACCESS_KEY_ID: 'test-key-id',
  R2_SECRET_ACCESS_KEY: 'test-secret',
  R2_PUBLIC_BASE_URL: 'https://media.example.test',
};

/**
 * Apply the R2 configuration for the duration of one test.
 *
 * @param {import('node:test').TestContext} t
 */
function withR2Env(t) {
  /** @type {Record<string, string|undefined>} */
  const previous = {};
  for (const [key, value] of Object.entries(R2_ENV)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Replace `sendMessagePush` with a spy; mirrors `messages.test.js`. */
function spyOnMessagePush() {
  const mod = require(pushModulePath);
  const original = mod.sendMessagePush;
  /** @type {{ channel: any, messageData: any }[]} */
  const calls = [];
  mod.sendMessagePush = async (/** @type {any} */ channel, /** @type {any} */ messageData) => {
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
  const { io: ioClient } = require('socket.io-client');
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

const VERSION = 1;

/** A well-formed image attachment pointing at this deployment's blob prefix. */
function imageAttachment(overrides = {}) {
  return {
    url: `${R2_ENV.R2_PUBLIC_BASE_URL}/chatblobs/rich-alice:rich-bob/photo.jpg`,
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    width: 800,
    height: 600,
    ...overrides,
  };
}

// ─── POST /attachments/presign ────────────────────────────────────────────────

test('presign rejects an unauthenticated caller', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const res = await postJson(url, '/attachments/presign', {
    peerId: 'rich-bob',
    type: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
  });
  assert.equal(res.status, 401);
});

test('presign returns a chatblobs URL and binds the size and MIME type', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'rich-alice');
  await createSession(url, 'rich-bob');

  const res = await postJson(
    url,
    '/attachments/presign',
    { peerId: 'rich-bob', type: 'image', mimeType: 'image/jpeg', sizeBytes: 2048 },
    session
  );

  assert.equal(res.status, 200);
  // All chat media is served from one shared prefix on the public base URL.
  assert.ok(
    res.body.publicUrl.startsWith(`${R2_ENV.R2_PUBLIC_BASE_URL}/chatblobs/`),
    res.body.publicUrl
  );
  assert.match(res.body.publicUrl, /\.jpg$/);
  assert.ok(res.body.key.startsWith('chatblobs/'));

  const uploadUrl = new URL(res.body.uploadUrl);
  assert.equal(uploadUrl.host, 'test-account.r2.cloudflarestorage.com');
  assert.ok(uploadUrl.pathname.startsWith('/wetalk-media/chatblobs/'));
  assert.equal(uploadUrl.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  // Size and MIME type are part of the signature, so object storage — not just
  // this server or the client — rejects an upload that changes either.
  assert.equal(
    uploadUrl.searchParams.get('X-Amz-SignedHeaders'),
    'content-length;content-type;host'
  );
  assert.ok(uploadUrl.searchParams.get('X-Amz-Signature'));
  assert.deepEqual(res.body.headers, { 'Content-Type': 'image/jpeg', 'Content-Length': '2048' });
  assert.ok(Date.parse(res.body.expiresAt) > Date.now());
});

test('presign rejects a disallowed MIME type and an oversized upload', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'rich-alice');
  await createSession(url, 'rich-bob');

  const badMime = await postJson(
    url,
    '/attachments/presign',
    { peerId: 'rich-bob', type: 'image', mimeType: 'application/x-msdownload', sizeBytes: 1024 },
    session
  );
  assert.equal(badMime.status, 400);
  assert.match(badMime.body.error, /not allowed/);

  const tooBig = await postJson(
    url,
    '/attachments/presign',
    { peerId: 'rich-bob', type: 'image', mimeType: 'image/png', sizeBytes: 50 * 1024 * 1024 },
    session
  );
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.body.error, /at most/);
});

test('presign refuses to mint an upload URL for a blocked peer', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'rich-alice');
  const bobSession = await createSession(url, 'rich-bob');
  assert.equal(
    (await postJson(url, '/blocks', { blockeeId: 'rich-alice' }, bobSession)).status,
    200
  );

  const res = await postJson(
    url,
    '/attachments/presign',
    { peerId: 'rich-bob', type: 'image', mimeType: 'image/jpeg', sizeBytes: 1024 },
    aliceSession
  );
  assert.equal(res.status, 403);
});

test('presign reports unavailable when R2 is not configured', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'rich-alice');
  await createSession(url, 'rich-bob');

  const res = await postJson(
    url,
    '/attachments/presign',
    { peerId: 'rich-bob', type: 'image', mimeType: 'image/jpeg', sizeBytes: 1024 },
    session
  );
  assert.equal(res.status, 503);
});

// ─── message.send with attachments ────────────────────────────────────────────

test('message.send stores an image attachment and previews it in push', async (t) => {
  withR2Env(t);
  const pushSpy = spyOnMessagePush();
  t.after(pushSpy.restore);

  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'rich-alice');
  const bobSession = await createSession(url, 'rich-bob');
  // Bob registers a device but never connects a socket, so the push fallback
  // path — the one that carries the preview — runs.
  await postJson(
    url,
    '/devices/register',
    { deviceId: 'device-rich-bob', platform: 'android', pushToken: 'token-bob', provider: 'fcm' },
    bobSession
  );

  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  const ack = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'rich-bob',
    body: '',
    type: 'image',
    attachment: imageAttachment(),
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.message.type, MESSAGE_TYPES.IMAGE);
  assert.equal(ack.message.attachment.mimeType, 'image/jpeg');
  assert.equal(ack.message.attachment.width, 800);
  assert.equal(ack.message.body, '');

  const history = await getJson(url, '/messages?peerId=rich-bob', aliceSession);
  assert.equal(history.body.messages[0].type, 'image');

  assert.equal(pushSpy.calls.length, 1);
  assert.equal(pushSpy.calls[0].messageData.preview, '📷 Photo');
});

test('message.send rejects an attachment that is not a managed upload', async (t) => {
  withR2Env(t);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'rich-alice');
  await createSession(url, 'rich-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  const foreign = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'rich-bob',
    body: '',
    type: 'image',
    attachment: imageAttachment({ url: 'https://attacker.example/tracker.jpg' }),
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.code, 'bad_request');

  const oversized = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'rich-bob',
    body: '',
    type: 'image',
    attachment: imageAttachment({ sizeBytes: 40 * 1024 * 1024 }),
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, 'bad_request');

  // A URL that starts with the blob prefix but climbs back out of it once a
  // proxy normalises the path is not a managed upload either.
  const traversal = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'rich-bob',
    body: '',
    type: 'image',
    attachment: imageAttachment({
      url: `${R2_ENV.R2_PUBLIC_BASE_URL}/chatblobs/../private/secret.jpg`,
    }),
  });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error.code, 'bad_request');

  const badMime = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'rich-bob',
    body: '',
    type: 'voice',
    attachment: imageAttachment(),
  });
  assert.equal(badMime.ok, false);
  assert.equal(badMime.error.code, 'bad_request');

  const missing = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'rich-bob',
    body: 'no attachment here',
    type: 'image',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'bad_request');
});

test('message.send still refuses an empty text message', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'rich-alice');
  await createSession(url, 'rich-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  const ack = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'rich-bob',
    body: '   ',
  });
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'bad_request');
});

// ─── Replies ──────────────────────────────────────────────────────────────────

test('a reply survives the deletion of the message it quotes', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'rich-alice');
  await createSession(url, 'rich-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  const original = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'rich-bob',
    body: 'the original',
  });
  const reply = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'rich-bob',
    body: 'quoting you',
    replyTo: original.message.messageId,
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.message.replyTo, original.message.messageId);

  const deleted = await emitWithAck(alice, 'message.delete', {
    version: VERSION,
    peerId: 'rich-bob',
    messageId: original.message.messageId,
  });
  assert.equal(deleted.ok, true);

  const history = await getJson(url, '/messages?peerId=rich-bob', aliceSession);
  const byId = new Map(history.body.messages.map((/** @type {any} */ message) => [message.messageId, message]));
  // The quoted message is still addressable — as a tombstone, so the reply
  // renders "Message deleted" instead of a dangling reference.
  const quoted = byId.get(original.message.messageId);
  assert.ok(quoted);
  assert.equal(quoted.body, '');
  assert.ok(quoted.deletedAt);
  assert.equal(describeMessagePreview(quoted), 'Message deleted');
  assert.equal(byId.get(reply.message.messageId).replyTo, original.message.messageId);
});

// ─── Reactions ────────────────────────────────────────────────────────────────

test('message.react converges across every device of both participants', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'rich-alice');
  const aliceTabletSession = await createSession(url, 'rich-alice', 'device-rich-alice-tablet');
  const bobSession = await createSession(url, 'rich-bob');

  const alice = await connectSocket(url, aliceSession);
  const aliceTablet = await connectSocket(url, aliceTabletSession);
  const bob = await connectSocket(url, bobSession);
  t.after(() => {
    alice.disconnect();
    aliceTablet.disconnect();
    bob.disconnect();
  });

  const sent = await emitWithAck(alice, 'message.send', {
    version: VERSION,
    recipientId: 'rich-bob',
    body: 'react to me',
  });
  const { messageId } = sent.message;

  const onTablet = new Promise((resolve) => aliceTablet.once('message.reaction', resolve));
  const onSender = new Promise((resolve) => alice.once('message.reaction', resolve));

  const ack = await emitWithAck(bob, 'message.react', {
    version: VERSION,
    peerId: 'rich-alice',
    messageId,
    emoji: '👍',
    action: 'add',
  });
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.reactions, { '👍': ['rich-bob'] });

  // Fan-out reaches the second device of the *same* user, not just the peer.
  for (const received of await Promise.all([onTablet, onSender])) {
    assert.equal(received.messageId, messageId);
    assert.deepEqual(received.reactions, { '👍': ['rich-bob'] });
    assert.equal(received.actorId, 'rich-bob');
  }

  // Idempotent: a replayed add does not toggle the reaction off.
  const replay = await emitWithAck(bob, 'message.react', {
    version: VERSION,
    peerId: 'rich-alice',
    messageId,
    emoji: '👍',
    action: 'add',
  });
  assert.deepEqual(replay.reactions, { '👍': ['rich-bob'] });

  const removed = await emitWithAck(bob, 'message.react', {
    version: VERSION,
    peerId: 'rich-alice',
    messageId,
    emoji: '👍',
    action: 'remove',
  });
  assert.deepEqual(removed.reactions, {});

  const history = await getJson(url, '/messages?peerId=rich-bob', aliceSession);
  assert.deepEqual(history.body.messages[0].reactions, {});
});

test('message.react rejects a non-emoji reaction and an unknown message', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'rich-alice');
  await createSession(url, 'rich-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  const notEmoji = await emitWithAck(alice, 'message.react', {
    version: VERSION,
    peerId: 'rich-bob',
    messageId: 'does-not-exist',
    emoji: 'lgtm',
    action: 'add',
  });
  assert.equal(notEmoji.ok, false);
  assert.equal(notEmoji.error.code, 'bad_request');

  const unknown = await emitWithAck(alice, 'message.react', {
    version: VERSION,
    peerId: 'rich-bob',
    messageId: 'does-not-exist',
    emoji: '👍',
    action: 'add',
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'not_found');
});

// ─── Backwards compatibility ──────────────────────────────────────────────────

test('a message with an unknown type stays renderable by an older client', () => {
  const fromTheFuture = {
    messageId: 'm1',
    conversationId: 'a:b',
    senderId: 'a',
    recipientId: 'b',
    body: '',
    type: 'poll',
    poll: { question: 'lunch?' },
  };

  // The envelope still validates, so a client that does not know `poll`
  // receives the event rather than dropping it…
  const parsed = parseEventPayload(
    SERVER_EVENTS.MESSAGE_RECEIVED,
    { version: 1, conversationId: 'a:b', message: fromTheFuture },
    'server'
  );
  assert.equal(parsed.success, true);
  // …and renders a neutral placeholder instead of an empty (or crashing) bubble.
  assert.equal(describeMessagePreview(parsed.data.message), 'Unsupported message');

  // A row written before rich messaging carries no type at all: it is text.
  assert.equal(messageTypeOf(/** @type {any} */ ({ body: 'legacy' })), 'text');
  assert.equal(describeMessagePreview(/** @type {any} */ ({ body: 'legacy' })), 'legacy');
  assert.equal(describeMessagePreview({ type: 'voice' }), '🎤 Voice message');
});
