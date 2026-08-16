'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/index.js');

async function startServer(opts = {}) {
  const server = createServer(opts);
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  return {
    ...server,
    url: `http://127.0.0.1:${port}`,
    async teardown() {
      server.httpServer.closeAllConnections?.();
      await new Promise((resolve) => server.io.close(() => server.httpServer.close(resolve)));
    },
  };
}

async function createSession(url) {
  const response = await fetch(`${url}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'turn-user', deviceId: 'turn-device' }),
  });
  return (await response.json()).sessionId;
}

async function getCredentials(url, sessionId) {
  const response = await fetch(`${url}/turn-credentials?sessionId=${encodeURIComponent(sessionId)}`);
  return { response, body: await response.json() };
}

test('GET /turn-credentials mints and caches Cloudflare credentials', async () => {
  let calls = 0;
  const server = await startServer({
    turnEnv: {
      CLOUDFLARE_TURN_KEY_ID: 'key-id',
      CLOUDFLARE_TURN_API_TOKEN: 'api-token',
      CLOUDFLARE_TURN_TTL_SECONDS: '3600',
    },
    turnFetch: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer ' + 'api-token');
      assert.deepEqual(JSON.parse(options.body), { ttl: 3600 });
      return { ok: true, json: async () => ({ iceServers: [{ urls: ['turn:cf.example'] }] }) };
    },
  });
  try {
    const sessionId = await createSession(server.url);
    const first = await getCredentials(server.url, sessionId);
    const second = await getCredentials(server.url, sessionId);
    assert.equal(first.response.status, 200);
    assert.deepEqual(first.body, [
      { urls: ['stun:stun.l.google.com:19302'] },
      { urls: ['turn:cf.example'] },
    ]);
    assert.match(first.response.headers.get('x-turn-credential-expires-at'), /^\d{4}-/);
    assert.deepEqual(second.body, first.body);
    assert.equal(calls, 1);
  } finally {
    await server.teardown();
  }
});

test('GET /turn-credentials falls back to static TURN or STUN only', async () => {
  const staticServer = await startServer({
    turnEnv: { TURN_USERNAME: 'static-user', TURN_CREDENTIAL: 'static-password' },
  });
  const stunServer = await startServer({ turnEnv: {} });
  try {
    const staticResult = await getCredentials(staticServer.url, await createSession(staticServer.url));
    assert.equal(staticResult.response.status, 200);
    assert.deepEqual(staticResult.body[1], {
      urls: [
        'turn:global.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80?transport=tcp',
        'turn:global.relay.metered.ca:443',
        'turns:global.relay.metered.ca:443?transport=tcp',
      ],
      username: 'static-user',
      credential: 'static-password',
    });

    const stunResult = await getCredentials(stunServer.url, await createSession(stunServer.url));
    assert.deepEqual(stunResult.body, [{ urls: ['stun:stun.l.google.com:19302'] }]);
  } finally {
    await staticServer.teardown();
    await stunServer.teardown();
  }
});

test('GET /turn-credentials requires a valid session and is rate limited', async () => {
  const server = await startServer({ turnEnv: {}, turnRateLimit: 1 });
  try {
    const unauthenticated = await fetch(`${server.url}/turn-credentials`);
    assert.equal(unauthenticated.status, 401);

    const sessionId = await createSession(server.url);
    assert.equal((await getCredentials(server.url, sessionId)).response.status, 200);
    assert.equal((await getCredentials(server.url, sessionId)).response.status, 429);
  } finally {
    await server.teardown();
  }
});
