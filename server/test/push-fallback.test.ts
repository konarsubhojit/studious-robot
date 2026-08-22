/**
 * Tests for the push-notification fallback triggered when an incoming call is
 * created for a callee who has no active WebSocket connection.
 *
 * Strategy: We do not want tests to make real APNs/FCM network calls.  Instead
 * we mock `sendIncomingCallPush` at the module level by requiring the push
 * module's internal exports indirectly through the server factory, and by
 * overriding it with a Node.js module-mock approach.
 *
 * Because Node.js CJS `require` caches modules by resolved path, we
 * monkey-patch `module.exports` on the push module *before* `createServer` is
 * called in each test.  A helper restores the original exports afterwards.
 */

import test from 'node:test';
import { pushSenders } from '../src/push.ts';
import assert from 'node:assert/strict';
import { captureConsoleLog } from './helpers.ts';
import { listenOnRandomPort, postJson } from './helpers.ts';
import { createServer } from '../src/index.ts';
import { io as ioClient } from 'socket.io-client';

// Resolve the push module's path so we can swap its exports.

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Temporarily replace `sendIncomingCallPush` with a spy.
 * Returns `{ calls, restore }`.
 *
 * Because `index.js` accesses `push.sendIncomingCallPush` through the module
 * exports object at call time (not via a destructured local), replacing the
 * property on the cached module is sufficient to intercept calls.
 */
function spyOnPush() {
  const mod = pushSenders;
  const original = mod.sendIncomingCallPush;
  /** @type {{ channel: any, callData: any }[]} */
  const calls: { channel: any; callData: any; }[] = [];
  mod.sendIncomingCallPush = async (/** @type {any} */ channel: any, /** @type {any} */ callData: any) => {
    calls.push({ channel, callData });
    return { ok: true, provider: channel.provider, deviceId: channel.deviceId };
  };
  return {
    calls,
    restore: () => {
      mod.sendIncomingCallPush = original;
    },
  };
}

/**
 * Temporarily replace `sendCallCancelledPush` with a spy.
 * Returns `{ calls, restore }`.
 */
function spyOnCancelPush() {
  const mod = pushSenders;
  const original = mod.sendCallCancelledPush;
  /** @type {{ channel: any, callData: any }[]} */
  const calls: { channel: any; callData: any; }[] = [];
  mod.sendCallCancelledPush = async (/** @type {any} */ channel: any, /** @type {any} */ callData: any) => {
    calls.push({ channel, callData });
    return { ok: true, provider: channel.provider, deviceId: channel.deviceId };
  };
  return {
    calls,
    restore: () => {
      mod.sendCallCancelledPush = original;
    },
  };
}

/** @param {import('../src/createServer.ts').CreateServerOptions} [opts] */
async function startServer(opts: import('../src/createServer.ts').CreateServerOptions = {}) {
  // Require *after* the spy is installed so `createServer` picks up the mock.
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

// ─── Tests ────────────────────────────────────────────────────────────────────

test('push fallback: no push sent when callee is online via WebSocket', async (t) => {
  const spy = spyOnPush();
  t.after(() => spy.restore());
  const logs = captureConsoleLog();
  t.after(() => logs.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');

  // Register a push token for the callee
  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'test-fcm-token' },
    calleeSession
  );

  // Connect callee via WebSocket (callee is now "online")
  const callee = ioClient(url, { auth: { sessionId: calleeSession } });
  await new Promise((resolve) => callee.once('connect', () => resolve(undefined)));

  try {
    const res = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'ringing');

    // Give the async push code a chance to fire (it should not)
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(spy.calls.length, 0, 'push should not be sent when callee is online');
    assert.ok(
      logs.lines.some(
        (line) =>
          line.includes('[push] Skipped call.incoming') &&
          line.includes('user=user-bob') &&
          line.includes('device=device-user-bob') &&
          line.includes('reason=callee_online')
      ),
      'callee-online push skip should be logged'
    );
  } finally {
    callee.disconnect();
  }
});

test('push fallback: push sent to all registered devices when callee is offline', async (t) => {
  const spy = spyOnPush();
  t.after(() => spy.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-carol');
  const calleeSession = await createSession(url, 'user-dave');

  // Register two push tokens for the callee
  await postJson(
    url,
    '/devices/register',
    { provider: 'apns', pushToken: 'apns-token-1' },
    calleeSession
  );

  // Register a second device / session
  const calleeSession2 = (
    await postJson(url, '/session', { userId: 'user-dave', deviceId: 'device-dave-2' })
  ).body.sessionId;
  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'fcm-token-2' },
    calleeSession2
  );

  // Callee is offline (no WebSocket connection)
  const res = await postJson(url, '/calls', { calleeId: 'user-dave' }, callerSession);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'ringing');

  // Wait for the async push deliveries to complete
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(spy.calls.length, 2, 'one push per registered device');

  const providers = spy.calls.map((c) => c.channel.provider).sort();
  assert.deepEqual(providers, ['apns', 'fcm']);

  for (const { channel, callData } of spy.calls) {
    assert.equal(callData.callId, res.body.callId);
    assert.equal(callData.callerId, 'user-carol');
    assert.ok(channel.pushToken);
  }
});

test('push fallback: no push when callee is unknown (unreachable)', async (t) => {
  const spy = spyOnPush();
  t.after(() => spy.restore());
  const logs = captureConsoleLog();
  t.after(() => logs.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-erin');
  // 'user-frank' is completely unknown to the server

  const res = await postJson(url, '/calls', { calleeId: 'user-frank' }, callerSession);
  assert.equal(res.status, 201);
  // unreachable because user-frank has no presence record
  assert.equal(res.body.status, 'unreachable');

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(spy.calls.length, 0, 'push must not be attempted for unreachable calls');
  assert.ok(
    logs.lines.some(
      (line) =>
        line.includes('[push] Skipped call.incoming') &&
        line.includes('user=user-frank') &&
        line.includes('reason=call_status_unreachable')
    ),
    'missing-device push skip should be logged'
  );
});

test('push fallback: push payload contains callId and callerId', async (t) => {
  const spy = spyOnPush();
  t.after(() => spy.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-grace');
  const calleeSession = await createSession(url, 'user-henry');

  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'fcm-henry-token' },
    calleeSession
  );

  const res = await postJson(url, '/calls', { calleeId: 'user-henry' }, callerSession);
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(spy.calls.length, 1);
  const { callData, channel } = spy.calls[0];
  assert.equal(callData.callId, res.body.callId);
  assert.equal(callData.callerId, 'user-grace');
  assert.equal(channel.provider, 'fcm');
  assert.equal(channel.pushToken, 'fcm-henry-token');
});

test('push fallback: offline devices still get a push while another device is online', async (t) => {
  const spy = spyOnPush();
  t.after(() => spy.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-ivan');
  // The callee has two devices: a phone that stays connected and a tablet that
  // is only reachable via push.
  const phoneSession = await createSession(url, 'user-judy', 'device-judy-phone');
  const tabletSession = await createSession(url, 'user-judy', 'device-judy-tablet');

  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'phone-token' },
    phoneSession
  );
  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'tablet-token' },
    tabletSession
  );

  const phone = ioClient(url, { auth: { sessionId: phoneSession } });
  await new Promise((resolve) => phone.once('connect', () => resolve(undefined)));

  try {
    const res = await postJson(url, '/calls', { calleeId: 'user-judy' }, callerSession);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'ringing');

    await new Promise((r) => setTimeout(r, 100));

    // The connected phone is reached over its socket, so it must not be pushed;
    // the tablet has no socket of its own and must be.
    assert.equal(spy.calls.length, 1, 'exactly one push, for the disconnected device');
    assert.equal(spy.calls[0].channel.deviceId, 'device-judy-tablet');
    assert.equal(spy.calls[0].channel.pushToken, 'tablet-token');
  } finally {
    phone.disconnect();
  }
});

test('push fallback: disconnected ringing device gets a push before timeout', async (t) => {
  const spy = spyOnPush();
  t.after(() => spy.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-kate');
  const calleeSession = await createSession(url, 'user-louis');

  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'louis-token' },
    calleeSession
  );

  const callee = ioClient(url, { auth: { sessionId: calleeSession } });
  await new Promise((resolve) => callee.once('connect', () => resolve(undefined)));

  const res = await postJson(url, '/calls', { calleeId: 'user-louis' }, callerSession);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'ringing');

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(spy.calls.length, 0, 'connected callee device is not pushed at call creation');

  callee.disconnect();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(spy.calls.length, 1, 'disconnect during ringing triggers a push to that device');
  assert.equal(spy.calls[0].channel.deviceId, 'device-user-louis');
  assert.equal(spy.calls[0].callData.callId, res.body.callId);
});

test('push fallback: connected device with no call.incoming ack receives push on ack timeout', async (t) => {
  process.env.INCOMING_CALL_ACK_TIMEOUT_MS = '60';
  t.after(() => {
    delete process.env.INCOMING_CALL_ACK_TIMEOUT_MS;
  });
  const spy = spyOnPush();
  t.after(() => spy.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-ack-a');
  const calleeSession = await createSession(url, 'user-ack-b', 'device-ack-b');

  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'ack-b-token' },
    calleeSession
  );

  const callee = ioClient(url, { auth: { sessionId: calleeSession } });
  await new Promise((resolve) => callee.once('connect', () => resolve(undefined)));

  try {
    const res = await postJson(url, '/calls', { calleeId: 'user-ack-b' }, callerSession);
    assert.equal(res.status, 201);
    await new Promise((r) => setTimeout(r, 160));

    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].channel.deviceId, 'device-ack-b');
    assert.equal(spy.calls[0].callData.callId, res.body.callId);
  } finally {
    callee.disconnect();
  }
});

test('push fallback: call.incoming ack suppresses ack-timeout push', async (t) => {
  process.env.INCOMING_CALL_ACK_TIMEOUT_MS = '60';
  t.after(() => {
    delete process.env.INCOMING_CALL_ACK_TIMEOUT_MS;
  });
  const spy = spyOnPush();
  t.after(() => spy.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-ack-c');
  const calleeSession = await createSession(url, 'user-ack-d', 'device-ack-d');

  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'ack-d-token' },
    calleeSession
  );

  const callee = ioClient(url, { auth: { sessionId: calleeSession } });
  await new Promise((resolve) => callee.once('connect', () => resolve(undefined)));
  callee.on('call.incoming', ({ call }) => {
    callee.emit(
      'call.incoming.ack',
      { version: 1, callId: call.callId, deviceId: 'device-ack-d' },
      () => {}
    );
  });

  try {
    const res = await postJson(url, '/calls', { calleeId: 'user-ack-d' }, callerSession);
    assert.equal(res.status, 201);
    await new Promise((r) => setTimeout(r, 160));
    assert.equal(spy.calls.length, 0, 'acked device must not be pushed');
  } finally {
    callee.disconnect();
  }
});

test('push fallback: no duplicate push after socket_disconnected when ack-timeout push already sent', async (t) => {
  process.env.INCOMING_CALL_ACK_TIMEOUT_MS = '60';
  t.after(() => {
    delete process.env.INCOMING_CALL_ACK_TIMEOUT_MS;
  });
  const spy = spyOnPush();
  t.after(() => spy.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-ack-e');
  const calleeSession = await createSession(url, 'user-ack-f', 'device-ack-f');

  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'ack-f-token' },
    calleeSession
  );

  const callee = ioClient(url, { auth: { sessionId: calleeSession } });
  await new Promise((resolve) => callee.once('connect', () => resolve(undefined)));

  try {
    const res = await postJson(url, '/calls', { calleeId: 'user-ack-f' }, callerSession);
    assert.equal(res.status, 201);
    await new Promise((r) => setTimeout(r, 160));
    assert.equal(spy.calls.length, 1, 'ack-timeout should send one push');
    callee.disconnect();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(spy.calls.length, 1, 'socket_disconnected should not duplicate push');
    assert.equal(spy.calls[0].callData.callId, res.body.callId);
  } finally {
    callee.disconnect();
  }
});

test('push fallback: call push carries the ring deadline so its TTL tracks the ring window', async (t) => {
  const spy = spyOnPush();
  t.after(() => spy.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-ttl-caller');
  const calleeSession = await createSession(url, 'user-ttl-callee');
  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'fcm-ttl-token' },
    calleeSession
  );

  const res = await postJson(url, '/calls', { calleeId: 'user-ttl-callee' }, callerSession);
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(spy.calls.length, 1);
  // Without the deadline the push would carry a fixed TTL and could outlive
  // (or, worse, undercut) the ring window it belongs to.
  assert.equal(spy.calls[0].callData.ringTimeoutAt, res.body.ringTimeoutAt);
});

test('push fallback: a cancelled call pushes a dismissal to every device that was rung', async (t) => {
  const spy = spyOnPush();
  t.after(() => spy.restore());
  const cancelSpy = spyOnCancelPush();
  t.after(() => cancelSpy.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-cancel-caller');
  const calleeSession = await createSession(url, 'user-cancel-callee');
  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'fcm-cancel-token' },
    calleeSession
  );

  const res = await postJson(url, '/calls', { calleeId: 'user-cancel-callee' }, callerSession);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(spy.calls.length, 1, 'the incoming-call push must have been sent first');

  const cancelled = await postJson(url, `/calls/${res.body.callId}/cancel`, {}, callerSession);
  assert.equal(cancelled.status, 200);
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(cancelSpy.calls.length, 1, 'the rung device must be told the call is over');
  assert.equal(cancelSpy.calls[0].callData.callId, res.body.callId);
  assert.equal(cancelSpy.calls[0].callData.reason, 'cancelled');
  assert.equal(cancelSpy.calls[0].channel.pushToken, 'fcm-cancel-token');
});

test('push fallback: an accepted call does not push a dismissal', async (t) => {
  const spy = spyOnPush();
  t.after(() => spy.restore());
  const cancelSpy = spyOnCancelPush();
  t.after(() => cancelSpy.restore());

  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-accept-caller');
  const calleeSession = await createSession(url, 'user-accept-callee');
  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'fcm-accept-token' },
    calleeSession
  );

  const res = await postJson(url, '/calls', { calleeId: 'user-accept-callee' }, callerSession);
  await new Promise((r) => setTimeout(r, 100));
  const accepted = await postJson(url, `/calls/${res.body.callId}/accept`, {}, calleeSession);
  assert.equal(accepted.status, 200);
  await new Promise((r) => setTimeout(r, 100));

  // Dismissing the UI of the device that just answered would end the call it
  // is about to join.
  assert.equal(cancelSpy.calls.length, 0);
});
