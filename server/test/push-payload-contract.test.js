'use strict';

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

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const push = require('../src/push.js');

const CALL = { callId: 'call-abc', callerId: 'alice' };

/** Keys the incoming-call push carries; renaming one is a breaking change. */
const CALL_DATA_KEYS = ['callId', 'callerId', 'type', 'deepLink', 'title', 'body'];

const CLIENT_SOURCE = path.join(__dirname, '..', '..', 'mobile', 'src', 'pushNotifications.js');

function directDataBlock() {
  return JSON.parse(push._buildFcmPayload('device-token-123', CALL)).message.data;
}

function hubDataBlock() {
  return push._buildNotificationHubAndroidPayload(CALL).message.android.data;
}

/**
 * Return the source of the function declared at `start`, from its opening brace
 * to the matching closing brace, so nested blocks inside the body are included.
 *
 * @param {string} source
 * @param {number} start index of the `function` keyword
 * @returns {string}
 */
function extractFunctionBody(source, start) {
  const open = source.indexOf('{', start);
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
  const hub = push._buildNotificationHubAndroidPayload(CALL).message;
  assert.equal(direct.notification, undefined);
  assert.equal(direct.android?.notification, undefined);
  assert.equal(hub.notification, undefined);
  assert.equal(hub.android.notification, undefined);
});

test('both transports request FCM v1 high priority so the handset wakes', () => {
  const direct = JSON.parse(push._buildFcmPayload('device-token-123', CALL)).message;
  assert.equal(direct.android.priority, 'HIGH');
  assert.equal(push._buildNotificationHubAndroidPayload(CALL).message.android.priority, 'HIGH');
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
