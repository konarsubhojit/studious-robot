/**
 * Server ↔ client push payload contract.
 *
 * A push is only useful if the keys the server puts in the FCM `data` block are
 * the keys the mobile client reads back out of `remoteMessage.data`. When they
 * drift, delivery still succeeds (FCM/Notification Hubs happily accept any data
 * map) but the callee's handset never rings, which is invisible server-side.
 *
 * These tests pin both halves of that contract:
 *  - the two transports (direct FCM v1 and Notification Hubs `FcmV1`) must send
 *    the *same*, strictly data-only block, and
 *  - every field `mobile/src/pushNotifications.js` reads must be one the server
 *    actually sends.
 */

import test from 'node:test';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as push from '../src/push.ts';


const CALL = { callId: 'call-abc', callerId: 'alice' };
const MESSAGE = {
  messageId: 'message-abc',
  conversationId: 'alice:bob',
  senderId: 'alice',
  preview: 'hey there',
};

/** Keys the incoming-call push carries; renaming one is a breaking change. */
const CALL_DATA_KEYS = ['callId', 'callerId', 'type', 'deepLink', 'title', 'body'];

/** Keys the message push carries; the client renders the notification itself. */
const MESSAGE_DATA_KEYS = [
  'messageId',
  'conversationId',
  'senderId',
  'type',
  'deepLink',
  'title',
  'body',
];

const CLIENT_SOURCE = path.join(thisDir, '..', '..', 'mobile', 'src', 'pushNotifications.ts');

function directDataBlock() {
  return JSON.parse(push._buildFcmPayload('device-token-123', CALL)).message.data;
}

function hubDataBlock() {
  return push._buildNotificationHubAndroidPayload(CALL).message.android.data;
}

function directMessageDataBlock() {
  return JSON.parse(push._buildFcmMessagePayload('device-token-123', MESSAGE)).message.data;
}

function hubMessageDataBlock() {
  return push._buildNotificationHubAndroidMessagePayload(MESSAGE).message.android.data;
}

/**
 * Return the source of the function declared at `start`, from its opening brace
 * to the matching closing brace, so nested blocks inside the body are included.
 *
 * @param start index of the `function` keyword
 */
function extractFunctionBody(source: string, start: number): string {
  // Skip the parameter list first: TypeScript signatures carry object type
  // literals (`{ data?: ... }`) whose braces would otherwise be mistaken for
  // the function body.
  let cursor = source.indexOf('(', start);
  assert.notEqual(cursor, -1, 'function parameter list not found');
  let parens = 0;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === '(') parens += 1;
    else if (source[cursor] === ')') {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  // The body is the first brace that opens a new line; return type annotations
  // (`): { callId: string; ... } | null {`) stay on the signature line.
  const bodyMatch = /\{[ \t]*\r?\n/.exec(source.slice(cursor));
  const open = bodyMatch ? cursor + bodyMatch.index : -1;
  assert.notEqual(open, -1, 'function body not found');
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new assert.AssertionError({ message: 'unbalanced braces in client extractor' });
}

test('both transports send the same data block for an incoming call', () => {
  const expected = {
    callId: 'call-abc',
    callerId: 'alice',
    type: 'call.incoming',
    deepLink: 'wetalk://call/call-abc',
    title: 'Incoming call',
    body: 'Call from alice',
  };
  assert.deepEqual(directDataBlock(), expected);
  assert.deepEqual(hubDataBlock(), expected);
  assert.deepEqual(Object.keys(directDataBlock()).sort(), [...CALL_DATA_KEYS].sort());
});

test('every data value is a string, as FCM v1 requires', () => {
  for (const block of [directDataBlock(), hubDataBlock()]) {
    for (const [key, value] of Object.entries(block)) {
      assert.equal(typeof value, 'string', `${key} must be a string`);
    }
  }
});

test('neither transport adds a notification block', () => {
  // A `notification` block makes Android route the push to the system tray and
  // skips the app's background handler, so CallKeep never rings the call
  // (AZURE_SETUP.md §1.7).
  const direct = JSON.parse(push._buildFcmPayload('device-token-123', CALL)).message;
  const hub = (push._buildNotificationHubAndroidPayload(CALL).message as any);
  assert.equal(direct.notification, undefined);
  assert.equal(direct.android?.notification, undefined);
  assert.equal(hub.notification, undefined);
  assert.equal(hub.android.notification, undefined);
});

test('both transports request FCM v1 high priority so the handset wakes', () => {
  const direct = JSON.parse(push._buildFcmPayload('device-token-123', CALL)).message;
  assert.equal(direct.android.priority, 'HIGH');
  assert.equal(direct.android.ttl, '120s');
  assert.equal(push._buildNotificationHubAndroidPayload(CALL).message.android.priority, 'HIGH');
  assert.equal(push._buildNotificationHubAndroidPayload(CALL).message.android.ttl, '120s');
});

test('the mobile client only reads fields the server sends', (t) => {
  if (!fs.existsSync(CLIENT_SOURCE)) {
    t.skip('mobile client source not present in this checkout');
    return;
  }

  const source = fs.readFileSync(CLIENT_SOURCE, 'utf8');
  const start = source.indexOf('function _extractIncomingCallFromMessage');
  assert.notEqual(start, -1, 'client push extractor not found — was it renamed?');
  const body = extractFunctionBody(source, start);

  const readKeys = [...body.matchAll(/\bdata\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  assert.ok(readKeys.length > 0, 'client reads no data fields — extractor shape changed');

  const sent = new Set(CALL_DATA_KEYS);
  for (const key of readKeys) {
    assert.ok(sent.has(key), `client reads data.${key} but the server never sends it`);
  }
  // The fields the incoming-call UI cannot ring without.
  for (const key of ['callId', 'callerId']) {
    assert.ok(readKeys.includes(key), `client no longer reads data.${key}`);
  }
});

test('both transports send the same data block for a received message', () => {
  const expected = {
    messageId: 'message-abc',
    conversationId: 'alice:bob',
    senderId: 'alice',
    type: 'message.received',
    deepLink: 'wetalk://chat/alice:bob',
    title: 'alice',
    body: 'hey there',
  };
  assert.deepEqual(directMessageDataBlock(), expected);
  assert.deepEqual(hubMessageDataBlock(), expected);
  assert.deepEqual(Object.keys(directMessageDataBlock()).sort(), [...MESSAGE_DATA_KEYS].sort());
});

test('a message push carries a preview the client can display, truncated', () => {
  const short = directMessageDataBlock();
  assert.equal(short.title, 'alice', 'the sender is the notification title');
  assert.equal(short.body, 'hey there');

  const long = JSON.parse(
    push._buildFcmMessagePayload('device-token-123', { ...MESSAGE, preview: 'x'.repeat(400) })
  ).message.data;
  assert.ok(long.body.length <= 120, 'preview is truncated');
  assert.ok(long.body.endsWith('…'));

  const empty = JSON.parse(
    push._buildFcmMessagePayload('device-token-123', { ...MESSAGE, preview: '' })
  ).message.data;
  assert.equal(empty.body, 'Sent you a message');
});

test('a message push stays data-only and unexpired', () => {
  // Data-only for the same reason calls are: a `notification` block would skip
  // the app's background handler, and the app is what renders chat
  // notifications (mobile/src/messageNotification.js). Unlike a call, a message
  // must not expire after 30s — an offline handset should still get it later.
  const direct = JSON.parse(push._buildFcmMessagePayload('device-token-123', MESSAGE)).message;
  assert.equal(direct.notification, undefined);
  assert.equal(direct.android?.notification, undefined);
  assert.equal(direct.android.ttl, undefined);
  const hub = (push._buildNotificationHubAndroidMessagePayload(MESSAGE).message as any);
  assert.equal(hub.notification, undefined);
  assert.equal(hub.android.notification, undefined);
  assert.equal(hub.android.ttl, undefined);
});

test('the mobile client only reads message fields the server sends', (t) => {
  if (!fs.existsSync(CLIENT_SOURCE)) {
    t.skip('mobile client source not present in this checkout');
    return;
  }

  const source = fs.readFileSync(CLIENT_SOURCE, 'utf8');
  const start = source.indexOf('function _extractMessageFromMessage');
  assert.notEqual(start, -1, 'client message extractor not found — was it renamed?');
  const body = extractFunctionBody(source, start);

  const readKeys = [...body.matchAll(/\bdata\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  assert.ok(readKeys.length > 0, 'client reads no data fields — extractor shape changed');

  const sent = new Set(MESSAGE_DATA_KEYS);
  for (const key of readKeys) {
    assert.ok(sent.has(key), `client reads data.${key} but the server never sends it`);
  }
  // Without these the notification cannot be rendered or routed to a chat.
  for (const key of ['messageId', 'conversationId', 'senderId']) {
    assert.ok(readKeys.includes(key), `client no longer reads data.${key}`);
  }
});

test('call push TTL follows the time left in the ring window', () => {
  const ringTimeoutAt = new Date(Date.now() + 45_000).toISOString();
  const direct = JSON.parse(
    push._buildFcmPayload('device-token-123', { ...CALL, ringTimeoutAt })
  ).message;
  const ttlSeconds = Number(String(direct.android.ttl).replace('s', ''));
  // A push delivered late in the window must expire with the call, not 120s
  // after it was handed to the provider.
  assert.ok(ttlSeconds > 40 && ttlSeconds <= 45, `unexpected ttl ${direct.android.ttl}`);

  const hub = push._buildNotificationHubAndroidPayload({ ...CALL, ringTimeoutAt }).message;
  assert.equal(hub.android.ttl, direct.android.ttl);
});

test('an elapsed ring deadline still yields a positive TTL', () => {
  // Providers reject ttl=0/negative; the dispatcher already refuses to send a
  // push for an elapsed ring window, so this is only belt and braces.
  assert.equal(push._resolveCallTtlSeconds(new Date(Date.now() - 10_000).toISOString()), 1);
  assert.equal(push._resolveCallTtlSeconds(null), 120);
  assert.equal(push._resolveCallTtlSeconds('not-a-date'), 120);
});

test('a call-cancelled push is data-only and identifies the call it dismisses', () => {
  const envelope = push._buildCallCancelledEnvelope({ callId: 'call-abc', reason: 'cancelled' });
  assert.equal(envelope.type, 'call.cancelled');
  assert.equal(envelope.data.callId, 'call-abc');
  assert.equal(envelope.data.reason, 'cancelled');
  assert.equal(envelope.deepLink, 'wetalk://call/call-abc');
  assert.ok((envelope.ttlSeconds ?? 0) > 0);
  assert.equal(push._buildCallCancelledEnvelope({ callId: 'call-abc' }).data.reason, 'ended');
});
