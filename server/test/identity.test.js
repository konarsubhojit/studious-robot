'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/index.js');

const PRESENCE_UPDATE_DELAY_MS = 25;

async function startServer() {
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

async function postJson(url, path, body, options = {}) {
  const payload = options.sessionId ? { ...body, sessionId: options.sessionId } : body;
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

async function getJson(url, path, options = {}) {
  const pathname = options.sessionId
    ? `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(options.sessionId)}`
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

    const offlinePresence = await getJson(url, '/presence/user-bob');
    assert.equal(offlinePresence.status, 200);
    assert.equal(offlinePresence.body.status, 'offline');
    assert.equal(offlinePresence.body.online, false);
    assert.equal(typeof offlinePresence.body.lastSeen, 'string');
  } finally {
    clients.forEach((client) => client.disconnect());
    await teardown();
  }
});

test('a verification code claims a userId; the same code re-uses it but a wrong/missing code is rejected', async () => {
  const { url, teardown } = await startServer();

  try {
    // First session claims the identity with a verification code.
    const claimed = await postJson(url, '/session', {
      userId: 'user-carol',
      deviceId: 'device-1',
      verificationCode: 'example-verification-code',
    });
    assert.equal(claimed.status, 201);
    assert.equal(claimed.body.userId, 'user-carol');

    // A different device presenting the correct code is allowed (e.g. re-login
    // or a second device for the same owner).
    const reuse = await postJson(url, '/session', {
      userId: 'user-carol',
      deviceId: 'device-2',
      verificationCode: 'example-verification-code',
    });
    assert.equal(reuse.status, 201);
    assert.equal(reuse.body.userId, 'user-carol');

    // An impostor without the code is rejected.
    const noCode = await postJson(url, '/session', {
      userId: 'user-carol',
      deviceId: 'device-evil',
    });
    assert.equal(noCode.status, 409);
    assert.equal(noCode.body.code, 'identity_conflict');

    // An impostor with the wrong code is rejected too.
    const wrongCode = await postJson(url, '/session', {
      userId: 'user-carol',
      deviceId: 'device-evil',
      verificationCode: 'guess',
    });
    assert.equal(wrongCode.status, 409);
    assert.equal(wrongCode.body.code, 'identity_conflict');
  } finally {
    await teardown();
  }
});

test('userIds without a verification code remain unclaimed and freely reusable', async () => {
  const { url, teardown } = await startServer();

  try {
    const first = await postJson(url, '/session', {
      userId: 'user-dan',
      deviceId: 'device-a',
    });
    assert.equal(first.status, 201);

    // No code was ever set, so any later session for the same userId is allowed.
    const second = await postJson(url, '/session', {
      userId: 'user-dan',
      deviceId: 'device-b',
    });
    assert.equal(second.status, 201);

    // Once a code is supplied it claims the identity going forward.
    const claim = await postJson(url, '/session', {
      userId: 'user-dan',
      deviceId: 'device-c',
      verificationCode: 'pin-1234',
    });
    assert.equal(claim.status, 201);

    const blocked = await postJson(url, '/session', {
      userId: 'user-dan',
      deviceId: 'device-d',
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'identity_conflict');
  } finally {
    await teardown();
  }
});
