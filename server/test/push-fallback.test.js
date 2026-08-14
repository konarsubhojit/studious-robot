'use strict';

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

const test = require('node:test');
const assert = require('node:assert/strict');

// Resolve the push module's path so we can swap its exports.
const pushModulePath = require.resolve('../src/push.js');

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
  const mod = require(pushModulePath);
  const original = mod.sendIncomingCallPush;
  const calls = [];
  mod.sendIncomingCallPush = async (channel, callData) => {
    calls.push({ channel, callData });
    return { ok: true, provider: channel.provider, deviceId: channel.deviceId };
  };
  return {
    calls,
    restore: () => { mod.sendIncomingCallPush = original; },
  };
}

function captureConsoleLog() {
  const original = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  return {
    lines,
    restore: () => { console.log = original; },
  };
}

async function startServer() {
  // Require *after* the spy is installed so `createServer` picks up the mock.
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

async function createSession(url, userId, deviceId = `device-${userId}`) {
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

  const { io: ioClient } = require('socket.io-client');
  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');

  // Register a push token for the callee
  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'test-fcm-token' },
    calleeSession,
  );

  // Connect callee via WebSocket (callee is now "online")
  const callee = ioClient(url, { auth: { sessionId: calleeSession } });
  await new Promise((resolve) => callee.once('connect', resolve));

  try {
    const res = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'ringing');

    // Give the async push code a chance to fire (it should not)
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(spy.calls.length, 0, 'push should not be sent when callee is online');
    assert.ok(
      logs.lines.some((line) =>
        line.includes('[push] Skipped call.incoming') &&
        line.includes('user=user-bob') &&
        line.includes('device=device-user-bob') &&
        line.includes('reason=callee_online')),
      'callee-online push skip should be logged',
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
    calleeSession,
  );

  // Register a second device / session
  const calleeSession2 = (
    await postJson(url, '/session', { userId: 'user-dave', deviceId: 'device-dave-2' })
  ).body.sessionId;
  await postJson(
    url,
    '/devices/register',
    { provider: 'fcm', pushToken: 'fcm-token-2' },
    calleeSession2,
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
    logs.lines.some((line) =>
      line.includes('[push] Skipped call.incoming') &&
      line.includes('user=user-frank') &&
      line.includes('reason=no_device_row')),
    'missing-device push skip should be logged',
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
    calleeSession,
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

  const { io: ioClient } = require('socket.io-client');
  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-ivan');
  // The callee has two devices: a phone that stays connected and a tablet that
  // is only reachable via push.
  const phoneSession = await createSession(url, 'user-judy', 'device-judy-phone');
  const tabletSession = await createSession(url, 'user-judy', 'device-judy-tablet');

  await postJson(url, '/devices/register', { provider: 'fcm', pushToken: 'phone-token' }, phoneSession);
  await postJson(url, '/devices/register', { provider: 'fcm', pushToken: 'tablet-token' }, tabletSession);

  const phone = ioClient(url, { auth: { sessionId: phoneSession } });
  await new Promise((resolve) => phone.once('connect', resolve));

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
