/**
 * Integration tests for the unified conversation timeline: `GET /messages`
 * with `include=calls`, the server-computed `durationSeconds` on call records,
 * and the call-side half of a conversation's unread state (`lastActivity`,
 * `unreadCount`, and clearing them via `POST /messages/read`).
 *
 * Mirrors the helper style of `messages.test.js` / `calls.test.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { getJson, listenOnRandomPort, postJson } from './helpers.ts';
import { createServer } from '../src/index.ts';
import { mergeTimeline } from '../src/domain/callTimeline.ts';

const VERSION = 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function startServer(opts = {}) {
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
async function createSession(url: string, userId: string, deviceId: string = `device-${userId}`): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

async function connectSocket(/** @type {any} */ url: any, /** @type {any} */ sessionId: any) {
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
function emitWithAck(socket: import('socket.io-client').Socket, event: string, payload: unknown): Promise<any> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

/**
 * Send `body` from `socket` to `recipientId`, returning the stored message.
 *
 * @param {import('socket.io-client').Socket} socket
 * @param {string} recipientId
 * @param {string} body
 * @returns {Promise<any>} the stored message
 */
async function sendMessage(socket: import('socket.io-client').Socket, recipientId: string, body: string): Promise<any> {
  const ack = await emitWithAck(socket, 'message.send', {
    version: VERSION,
    recipientId,
    body,
  });
  assert.equal(ack.ok, true);
  return ack.message;
}

/**
 * Place a call and return its record.
 *
 * @param {string} url - Base URL of the server under test.
 * @param {string} callerSession
 * @param {string} calleeId
 * @returns {Promise<any>} the created call record
 */
async function placeCall(url: string, callerSession: string, calleeId: string): Promise<any> {
  const res = await postJson(url, '/calls', { calleeId }, callerSession);
  assert.equal(res.status, 201);
  return res.body;
}

// ─── GET /messages?include=calls ──────────────────────────────────────────────

test('GET /messages leaves the payload untouched unless include=calls is asked for', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'tl-plain-alice');
  await createSession(url, 'tl-plain-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await sendMessage(alice, 'tl-plain-bob', 'hello');
  const call = await placeCall(url, aliceSession, 'tl-plain-bob');
  await postJson(url, `/calls/${call.callId}/cancel`, {}, aliceSession);

  const plain = await getJson(url, '/messages?peerId=tl-plain-bob', aliceSession);
  assert.equal(plain.status, 200);
  assert.equal(plain.body.messages.length, 1);
  assert.equal(plain.body.messages[0].body, 'hello');
  // `type` is the message's own kind (rich messaging), not the call-timeline
  // discriminator: a plain page still contains messages only.
  assert.equal(plain.body.messages[0].type, 'text');
});

test('GET /messages?include=calls interleaves calls and messages newest-first', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'tl-mix-alice');
  const bobSession = await createSession(url, 'tl-mix-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await sendMessage(alice, 'tl-mix-bob', 'before the call');
  const declined = await placeCall(url, aliceSession, 'tl-mix-bob');
  await postJson(url, `/calls/${declined.callId}/decline`, {}, bobSession);
  await sendMessage(alice, 'tl-mix-bob', 'after the call');

  const res = await getJson(url, '/messages?peerId=tl-mix-bob&include=calls', aliceSession);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.messages.map((/** @type {any} */ entry: any) => entry.type),
    ['text', 'call', 'text']
  );

  const callEntry = res.body.messages[1];
  assert.equal(callEntry.callId, declined.callId);
  assert.equal(callEntry.conversationId, res.body.conversationId);
  assert.equal(callEntry.direction, 'outgoing');
  assert.equal(callEntry.status, 'declined');
  assert.equal(callEntry.durationSeconds, 0);

  // Both participants see the same call, from their own point of view.
  const fromBob = await getJson(url, '/messages?peerId=tl-mix-alice&include=calls', bobSession);
  const bobCall = fromBob.body.messages.find((/** @type {any} */ entry: any) => entry.type === 'call');
  assert.equal(bobCall.callId, declined.callId);
  assert.equal(bobCall.direction, 'incoming');
  assert.equal(bobCall.status, 'declined');
});

test('GET /messages?include=calls paginates the merged stream without gaps or duplicates', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'tl-page-alice');
  const bobSession = await createSession(url, 'tl-page-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  // Alternate messages and calls so every page boundary crosses entry types.
  const expected = [];
  for (let i = 0; i < 3; i++) {
    const message = await sendMessage(alice, 'tl-page-bob', `msg-${i}`);
    expected.push(message.messageId);
    const call = await placeCall(url, aliceSession, 'tl-page-bob');
    await postJson(url, `/calls/${call.callId}/decline`, {}, bobSession);
    expected.push(call.callId);
  }
  expected.reverse();

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 3; page++) {
    const query = `/messages?peerId=tl-page-bob&include=calls&limit=2${
      cursor ? `&before=${encodeURIComponent(cursor)}` : ''
    }`;
    const res = await getJson(url, query, aliceSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.messages.length, 2);
    for (const entry of res.body.messages) {
      seen.push(entry.messageId ?? entry.callId);
    }
    cursor = res.body.messages[res.body.messages.length - 1].createdAt;
  }

  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, seen.length);

  const exhausted = await getJson(
    url,
    `/messages?peerId=tl-page-bob&include=calls&limit=2&before=${encodeURIComponent(cursor)}`,
    aliceSession
  );
  assert.deepEqual(exhausted.body.messages, []);
});

test('GET /messages?include=calls hides a blocked peer\'s calls', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'tl-block-alice');
  const bobSession = await createSession(url, 'tl-block-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await sendMessage(alice, 'tl-block-bob', 'still here');
  const call = await placeCall(url, aliceSession, 'tl-block-bob');
  await postJson(url, `/calls/${call.callId}/decline`, {}, bobSession);

  const blocked = await postJson(url, '/blocks', { blockeeId: 'tl-block-bob' }, aliceSession);
  assert.equal(blocked.status, 200);

  const res = await getJson(url, '/messages?peerId=tl-block-bob&include=calls', aliceSession);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.messages.map((/** @type {any} */ entry: any) => entry.type),
    ['text']
  );
});

// ─── Merge ordering ───────────────────────────────────────────────────────────

test('a message and a call sharing a millisecond keep a deterministic order', () => {
  const createdAt = '2026-08-18T12:00:00.000Z';
  const message = { messageId: 'aaa', createdAt };
  const call = { type: 'call', callId: 'zzz', createdAt };

  const merged = mergeTimeline([message], [call], 10);
  assert.deepEqual(
    merged.map((entry) => entry.messageId ?? entry.callId),
    ['zzz', 'aaa']
  );
  // Same page whichever order the two sources are read in.
  assert.deepEqual(mergeTimeline([message], [call], 10), merged);
  assert.equal(merged[0].type, 'call');
  assert.equal(merged[1].type, 'text');

  // The page is capped by `limit`, newest kept.
  assert.deepEqual(
    mergeTimeline([message], [call], 1).map((entry) => entry.callId),
    ['zzz']
  );
});

// ─── durationSeconds ──────────────────────────────────────────────────────────

test('durationSeconds is 0 for calls that never connected', async (t) => {
  const { url, teardown, tickRingingTimeouts, getCall } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'tl-dur-alice');
  const bobSession = await createSession(url, 'tl-dur-bob');

  const declined = await placeCall(url, aliceSession, 'tl-dur-bob');
  await postJson(url, `/calls/${declined.callId}/decline`, {}, bobSession);
  assert.equal(getCall(declined.callId)?.durationSeconds, 0);

  const cancelled = await placeCall(url, aliceSession, 'tl-dur-bob');
  await postJson(url, `/calls/${cancelled.callId}/cancel`, {}, aliceSession);
  assert.equal(getCall(cancelled.callId)?.durationSeconds, 0);

  const missed = await placeCall(url, aliceSession, 'tl-dur-bob');
  tickRingingTimeouts(Date.now() + 10 * 60 * 1000);
  assert.equal(getCall(missed.callId)?.status, 'missed');
  assert.equal(getCall(missed.callId)?.durationSeconds, 0);
});

test('durationSeconds measures the connected time of an answered call', async (t) => {
  const { url, teardown, getCall } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'tl-answered-alice');
  const bobSession = await createSession(url, 'tl-answered-bob');

  const call = await placeCall(url, aliceSession, 'tl-answered-bob');
  await postJson(url, `/calls/${call.callId}/accept`, {}, bobSession);

  // Backdate the answer so the elapsed time is deterministic.
  const record = getCall(call.callId);
  assert.ok(record, 'the answered call is tracked in memory');
  record.answeredAt = new Date(Date.now() - 128_000).toISOString();

  await postJson(url, `/calls/${call.callId}/end`, {}, aliceSession);
  assert.equal(getCall(call.callId)?.durationSeconds, 128);

  const res = await getJson(
    url,
    '/messages?peerId=tl-answered-bob&include=calls',
    aliceSession
  );
  const entry = res.body.messages.find((/** @type {any} */ item: any) => item.type === 'call');
  assert.equal(entry.status, 'ended');
  assert.equal(entry.durationSeconds, 128);
});

// ─── Unread semantics ─────────────────────────────────────────────────────────

test('a missed call raises the conversation unread count and clears when read', async (t) => {
  const { url, teardown, tickRingingTimeouts } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'tl-unread-alice');
  const bobSession = await createSession(url, 'tl-unread-bob');

  await placeCall(url, aliceSession, 'tl-unread-bob');
  tickRingingTimeouts(Date.now() + 10 * 60 * 1000);

  const before = await getJson(url, '/conversations', bobSession);
  assert.equal(before.status, 200);
  const conversation = before.body.conversations.find((/** @type {any} */ c: any) => c.peerId === 'tl-unread-alice');
  assert.equal(conversation.unreadCount, 1);
  assert.equal(conversation.lastActivity.type, 'call');
  assert.equal(conversation.lastActivity.status, 'missed');

  const read = await postJson(url, '/messages/read', { peerId: 'tl-unread-alice' }, bobSession);
  assert.equal(read.status, 200);
  assert.equal(read.body.missedCallsRead, 1);

  const after = await getJson(url, '/conversations', bobSession);
  const cleared = after.body.conversations.find((/** @type {any} */ c: any) => c.peerId === 'tl-unread-alice');
  assert.equal(cleared.unreadCount, 0);

  // Idempotent: nothing left to acknowledge on a replay.
  const replay = await postJson(url, '/messages/read', { peerId: 'tl-unread-alice' }, bobSession);
  assert.equal(replay.body.missedCallsRead, 0);

  // The caller's own outgoing call never counts as unread for them.
  const callerView = await getJson(url, '/conversations', aliceSession);
  const callerConversation = callerView.body.conversations.find(
    (/** @type {any} */ c: any) => c.peerId === 'tl-unread-bob'
  );
  assert.equal(callerConversation.unreadCount, 0);
});

test('lastActivity prefers the newest of the last message and the last call', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'tl-last-alice');
  const bobSession = await createSession(url, 'tl-last-bob');
  const alice = await connectSocket(url, aliceSession);
  t.after(() => alice.disconnect());

  await sendMessage(alice, 'tl-last-bob', 'older message');
  const call = await placeCall(url, aliceSession, 'tl-last-bob');
  await postJson(url, `/calls/${call.callId}/decline`, {}, bobSession);

  const withCall = await getJson(url, '/conversations', aliceSession);
  const conversation = withCall.body.conversations.find((/** @type {any} */ c: any) => c.peerId === 'tl-last-bob');
  assert.equal(conversation.lastActivity.type, 'call');
  assert.equal(conversation.lastMessage.body, 'older message');

  await sendMessage(alice, 'tl-last-bob', 'newer message');
  const withMessage = await getJson(url, '/conversations', aliceSession);
  const updated = withMessage.body.conversations.find((/** @type {any} */ c: any) => c.peerId === 'tl-last-bob');
  assert.equal(updated.lastActivity.type, 'text');
  assert.equal(updated.lastActivity.body, 'newer message');
});

test('a blocked peer\'s call-only conversation stays out of the chat list', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const aliceSession = await createSession(url, 'tl-cblock-alice');
  const bobSession = await createSession(url, 'tl-cblock-bob');

  const call = await placeCall(url, aliceSession, 'tl-cblock-bob');
  await postJson(url, `/calls/${call.callId}/decline`, {}, bobSession);

  const visible = await getJson(url, '/conversations', aliceSession);
  assert.ok(visible.body.conversations.some((/** @type {any} */ c: any) => c.peerId === 'tl-cblock-bob'));

  const blocked = await postJson(url, '/blocks', { blockeeId: 'tl-cblock-alice' }, bobSession);
  assert.equal(blocked.status, 200);

  const hidden = await getJson(url, '/conversations', aliceSession);
  assert.ok(!hidden.body.conversations.some((/** @type {any} */ c: any) => c.peerId === 'tl-cblock-bob'));
});
