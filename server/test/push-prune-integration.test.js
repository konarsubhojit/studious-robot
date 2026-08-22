// @ts-check
'use strict';

/**
 * End-to-end test for dead-token pruning: a call-incoming push delivery that
 * comes back with a dead-token outcome (404/UNREGISTERED, 400/INVALID_ARGUMENT)
 * must result in the offending device row being pruned from both the DB and
 * in-memory state — so the next call attempt no longer wastes a delivery
 * attempt (or worse, logs a false "Delivered") against a token that can never
 * succeed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/index.js');
const push = require('../src/push.js');
const { listenOnRandomPort, postJson } = require('./helpers');

/** @param {import('../src/createServer').CreateServerOptions} [opts] */
async function startServer(opts) {
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

function buildMockDb() {
  /** @type {any[]} */
  const deletes = [];
  return {
    deletes,
    select() {
      return { from: () => Promise.resolve([]) };
    },
    insert() {
      return {
        values: () => ({
          onConflictDoUpdate: () => Promise.resolve(),
          onConflictDoNothing: () => Promise.resolve(),
          then: (/** @type {any} */ resolve) => Promise.resolve().then(resolve),
          catch: () => Promise.resolve(),
        }),
      };
    },
    update() {
      return { set: () => ({ where: () => Promise.resolve() }) };
    },
    delete(/** @type {any} */ table) {
      return {
        where(/** @type {any} */ condition) {
          deletes.push({ table, condition });
          return Promise.resolve();
        },
      };
    },
  };
}

test('a dead-token outcome from an incoming-call push prunes the device row', async () => {
  const db = buildMockDb();
  const { url, teardown, resolveReachableChannels } = await startServer({ db });

  const originalSend = push.sendIncomingCallPush;
  push.sendIncomingCallPush = async (channel) => ({
    ok: false,
    provider: channel.provider,
    deviceId: channel.deviceId,
    transport: 'direct',
    statusCode: 404,
    reason: 'UNREGISTERED',
    deadToken: true,
  });

  try {
    const caller = await postJson(url, '/session', {
      userId: 'user-prune-caller',
      deviceId: 'device-prune-caller',
    });
    assert.equal(caller.status, 201);

    const callee = await postJson(url, '/session', {
      userId: 'user-prune-callee',
      deviceId: 'device-prune-callee',
    });
    assert.equal(callee.status, 201);

    await postJson(
      url,
      '/devices/register',
      { provider: 'fcm', pushToken: 'now-dead-token' },
      callee.body.sessionId
    );

    // Sanity check: the push channel exists before the call is attempted.
    assert.equal(
      resolveReachableChannels('user-prune-callee').filter((c) => c.type === 'push').length,
      1
    );

    const created = await postJson(
      url,
      '/calls',
      { calleeId: 'user-prune-callee' },
      caller.body.sessionId
    );
    assert.equal(created.status, 201);

    // The push dispatch is fire-and-forget; wait for its promise chain
    // (send → handleDeadTokenOutcome → pruneDeadDevice) to settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      resolveReachableChannels('user-prune-callee').filter((c) => c.type === 'push').length,
      0,
      'the dead-token device must no longer be a reachable push channel'
    );
    assert.equal(db.deletes.length, 1, 'the device row must be deleted from the DB');
  } finally {
    push.sendIncomingCallPush = originalSend;
    await teardown();
  }
});

test('a transient failure outcome does not prune the device row', async () => {
  const db = buildMockDb();
  const { url, teardown, resolveReachableChannels } = await startServer({ db });

  const originalSend = push.sendIncomingCallPush;
  push.sendIncomingCallPush = async (channel) => ({
    ok: false,
    provider: channel.provider,
    deviceId: channel.deviceId,
    transport: 'direct',
    statusCode: 503,
    reason: 'UNAVAILABLE',
    deadToken: false,
  });

  try {
    const caller = await postJson(url, '/session', {
      userId: 'user-transient-caller',
      deviceId: 'device-transient-caller',
    });
    const callee = await postJson(url, '/session', {
      userId: 'user-transient-callee',
      deviceId: 'device-transient-callee',
    });

    await postJson(
      url,
      '/devices/register',
      { provider: 'fcm', pushToken: 'still-alive-token' },
      callee.body.sessionId
    );

    await postJson(url, '/calls', { calleeId: 'user-transient-callee' }, caller.body.sessionId);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      resolveReachableChannels('user-transient-callee').filter((c) => c.type === 'push').length,
      1,
      'a transient failure must not prune the device row'
    );
    assert.equal(db.deletes.length, 0);
  } finally {
    push.sendIncomingCallPush = originalSend;
    await teardown();
  }
});
