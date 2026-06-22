'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/index.js');

async function startServer() {
  const server = createServer();
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  const url = `http://127.0.0.1:${port}`;

  async function teardown(...clients) {
    clients.forEach((client) => client.disconnect());
    server.httpServer.closeAllConnections?.();
    await new Promise((resolve) => server.io.close(() => server.httpServer.close(resolve)));
  }

  return { ...server, url, teardown };
}

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

async function postJson(url, path, body, sessionId) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(sessionId ? { ...body, sessionId } : body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function getJson(url, path, sessionId) {
  const pathname = sessionId
    ? `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(sessionId)}`
    : path;
  const response = await fetch(`${url}${pathname}`);

  return {
    status: response.status,
    body: await response.json(),
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

    const fetchedSession = await getJson(url, '/session', createdSession.body.sessionId);
    assert.equal(fetchedSession.status, 200);
    assert.deepEqual(fetchedSession.body, createdSession.body);

    const registered = await postJson(
      url,
      '/devices/register',
      { provider: 'apns', pushToken: 'push-token-1' },
      createdSession.body.sessionId,
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

    const presenceWhileOffline = await getJson(url, '/presence/user-alice');
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

    const unregistered = await postJson(url, '/devices/unregister', {}, createdSession.body.sessionId);
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
      session1.body.sessionId,
    );
    await postJson(
      url,
      '/devices/register',
      { provider: 'fcm', pushToken: 'push-fcm-1' },
      session2.body.sessionId,
    );

    clients.push(await connect(url, { sessionId: session1.body.sessionId }));
    clients.push(await connect(url, { sessionId: session2.body.sessionId }));

    const livePresence = await getJson(url, '/presence/user-bob');
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
    assert.deepEqual(
      reachableChannels.filter((channel) => channel.type === 'push'),
      [
        {
          type: 'push',
          deviceId: 'device-ios',
          provider: 'apns',
          pushToken: 'push-apns-1',
        },
        {
          type: 'push',
          deviceId: 'device-android',
          provider: 'fcm',
          pushToken: 'push-fcm-1',
        },
      ],
    );

    clients.forEach((client) => client.disconnect());
    clients.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 25));

    const offlinePresence = await getJson(url, '/presence/user-bob');
    assert.equal(offlinePresence.status, 200);
    assert.equal(offlinePresence.body.status, 'offline');
    assert.equal(offlinePresence.body.online, false);
    assert.equal(typeof offlinePresence.body.lastSeen, 'string');
  } finally {
    await teardown(...clients);
  }
});
