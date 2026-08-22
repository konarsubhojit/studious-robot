// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/index.js');
const { listenOnRandomPort, readJson } = require('./helpers');

const PRESENCE_UPDATE_DELAY_MS = 25;

async function startServer() {
  const server = createServer({
    verifyIdToken: async (idToken) => {
      if (!idToken) throw new Error('missing token');
      return { authUid: idToken, email: `${idToken}@example.com`, authProvider: 'password' };
    },
  });
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
 * @param {string} url
 * @param {Record<string, unknown>} [auth] - Socket.IO handshake auth payload.
 * @returns {Promise<import('socket.io-client').Socket>}
 */
function connect(url, auth) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      auth,
      forceNew: true,
      transports: ['websocket'],
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

/**
 * @param {string} url - Base URL of the server under test.
 * @param {string} path - Request path, including the leading slash.
 * @param {Record<string, any>} body
 * @param {{ sessionId?: string }} [options]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function postJson(url, path, body, options = {}) {
  let payload = options.sessionId ? { ...body, sessionId: options.sessionId } : body;
  if (path === '/session' && !payload.idToken) {
    payload = { ...payload, idToken: `account-${payload.userId}` };
  }
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return {
    status: response.status,
    body: await readJson(response),
  };
}

/**
 * @param {string} url - Base URL of the server under test.
 * @param {string} path - Request path, including the leading slash.
 * @param {{ sessionId?: string }} [options]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function getJson(url, path, options = {}) {
  const pathname = options.sessionId
    ? `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(options.sessionId)}`
    : path;
  const response = await fetch(`${url}${pathname}`);

  return {
    status: response.status,
    body: await readJson(response),
  };
}

test('session identity remains stable and device push tokens can be registered/unregistered', async () => {
  const { url, resolveReachableChannels, teardown } = await startServer();

  try {
    const createdSession = await postJson(url, '/session', {
      userId: 'user-alice',
      deviceId: 'device-iphone',
      platform: 'ios',
    });
    assert.equal(createdSession.status, 201);
    assert.equal(createdSession.body.userId, 'user-alice');
    assert.equal(createdSession.body.deviceId, 'device-iphone');
    assert.equal(typeof createdSession.body.sessionId, 'string');

    const fetchedSession = await getJson(url, '/session', {
      sessionId: createdSession.body.sessionId,
    });
    assert.equal(fetchedSession.status, 200);
    assert.deepEqual(fetchedSession.body, createdSession.body);

    const registered = await postJson(
      url,
      '/devices/register',
      { provider: 'apns', pushToken: 'push-token-1' },
      { sessionId: createdSession.body.sessionId }
    );
    assert.equal(registered.status, 200);
    assert.deepEqual(registered.body, {
      status: 'registered',
      userId: 'user-alice',
      deviceId: 'device-iphone',
      provider: 'apns',
    });

    assert.deepEqual(resolveReachableChannels('user-alice'), [
      {
        type: 'push',
        deviceId: 'device-iphone',
        provider: 'apns',
        pushToken: 'push-token-1',
      },
    ]);

    const presenceWhileOffline = await getJson(url, '/presence/user-alice', {
      sessionId: createdSession.body.sessionId,
    });
    assert.equal(presenceWhileOffline.status, 200);
    assert.equal(presenceWhileOffline.body.status, 'offline');
    assert.equal(presenceWhileOffline.body.online, false);
    assert.equal(presenceWhileOffline.body.lastSeen, null);
    assert.deepEqual(presenceWhileOffline.body.devices, [
      {
        deviceId: 'device-iphone',
        platform: 'ios',
        pushRegistered: true,
        connected: false,
      },
    ]);

    const unregistered = await postJson(
      url,
      '/devices/unregister',
      {},
      {
        sessionId: createdSession.body.sessionId,
      }
    );
    assert.equal(unregistered.status, 200);
    assert.deepEqual(unregistered.body, {
      status: 'unregistered',
      userId: 'user-alice',
      deviceId: 'device-iphone',
    });
    assert.deepEqual(resolveReachableChannels('user-alice'), []);
  } finally {
    await teardown();
  }
});

test('presence and reachable channels support multiple devices for the same user', async () => {
  const { url, resolveReachableChannels, teardown } = await startServer();

  const session1 = await postJson(url, '/session', {
    userId: 'user-bob',
    deviceId: 'device-ios',
    platform: 'ios',
  });
  const session2 = await postJson(url, '/session', {
    userId: 'user-bob',
    deviceId: 'device-android',
    platform: 'android',
  });

  const clients = [];
  try {
    assert.equal(session1.status, 201);
    assert.equal(session2.status, 201);

    await postJson(
      url,
      '/devices/register',
      { provider: 'apns', pushToken: 'push-apns-1' },
      { sessionId: session1.body.sessionId }
    );
    await postJson(
      url,
      '/devices/register',
      { provider: 'fcm', pushToken: 'push-fcm-1' },
      { sessionId: session2.body.sessionId }
    );

    clients.push(await connect(url, { sessionId: session1.body.sessionId }));
    clients.push(await connect(url, { sessionId: session2.body.sessionId }));

    const livePresence = await getJson(url, '/presence/user-bob', {
      sessionId: session1.body.sessionId,
    });
    assert.equal(livePresence.status, 200);
    assert.equal(livePresence.body.status, 'online');
    assert.equal(livePresence.body.online, true);
    assert.equal(livePresence.body.lastSeen, null);
    assert.equal(livePresence.body.activeConnections, 2);
    assert.deepEqual(livePresence.body.devices, [
      {
        deviceId: 'device-ios',
        platform: 'ios',
        pushRegistered: true,
        connected: true,
      },
      {
        deviceId: 'device-android',
        platform: 'android',
        pushRegistered: true,
        connected: true,
      },
    ]);

    const reachableChannels = resolveReachableChannels('user-bob');
    assert.equal(reachableChannels.filter((channel) => channel.type === 'websocket').length, 2);
    // Push channels are ordered freshest-first (most recently registered/updated
    // device first) — a safety net so that if multiple stale device rows still
    // exist for a user, the newest registration is preferred. Here android was
    // registered after ios, so it sorts first.
    assert.deepEqual(
      reachableChannels.filter((channel) => channel.type === 'push'),
      [
        {
          type: 'push',
          deviceId: 'device-android',
          provider: 'fcm',
          pushToken: 'push-fcm-1',
        },
        {
          type: 'push',
          deviceId: 'device-ios',
          provider: 'apns',
          pushToken: 'push-apns-1',
        },
      ]
    );

    clients.forEach((client) => client.disconnect());
    clients.length = 0;
    // Wait briefly for the socket disconnect handlers to stamp lastSeen.
    await new Promise((resolve) => setTimeout(resolve, PRESENCE_UPDATE_DELAY_MS));

    const offlinePresence = await getJson(url, '/presence/user-bob', {
      sessionId: session1.body.sessionId,
    });
    assert.equal(offlinePresence.status, 200);
    assert.equal(offlinePresence.body.status, 'offline');
    assert.equal(offlinePresence.body.online, false);
    assert.equal(typeof offlinePresence.body.lastSeen, 'string');
  } finally {
    clients.forEach((client) => client.disconnect());
    await teardown();
  }
});

test('an authenticated account claims a userId and another account cannot impersonate it', async () => {
  const { url, teardown } = await startServer();

  try {
    const claimed = await postJson(url, '/session', {
      userId: 'user-carol',
      deviceId: 'device-1',
      idToken: 'account-carol',
    });
    assert.equal(claimed.status, 201);
    assert.equal(claimed.body.userId, 'user-carol');

    const reuse = await postJson(url, '/session', {
      userId: 'user-carol',
      deviceId: 'device-2',
      idToken: 'account-carol',
    });
    assert.equal(reuse.status, 201);
    assert.equal(reuse.body.userId, 'user-carol');

    const impostor = await postJson(url, '/session', {
      userId: 'user-carol',
      deviceId: 'device-evil',
      idToken: 'account-evil',
    });
    assert.equal(impostor.status, 409);
    assert.equal(impostor.body.code, 'identity_claimed');
  } finally {
    await teardown();
  }
});

test('an account cannot bind itself to a second username', async () => {
  const { url, teardown } = await startServer();

  try {
    const first = await postJson(url, '/session', {
      userId: 'user-dan',
      deviceId: 'device-a',
      idToken: 'account-dan',
    });
    assert.equal(first.status, 201);

    const second = await postJson(url, '/session', {
      userId: 'user-dan-impersonated',
      deviceId: 'device-b',
      idToken: 'account-dan',
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'account_already_bound');
    assert.equal(second.body.userId, 'user-dan');
  } finally {
    await teardown();
  }
});

test('presence requires an authenticated session', async () => {
  const { url, teardown } = await startServer();
  try {
    const response = await getJson(url, '/presence/user-alice');
    assert.equal(response.status, 401);
  } finally {
    await teardown();
  }
});
