import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from '../src/index.ts';
import { listenOnRandomPort, readJson } from './helpers.ts';

/**
 * The TURN stubs below return only the slice of `Response` the route reads, so
 * `turnFetch` is loosened here instead of at every call site.
 *
 * @param [opts]
 */
async function startServer(opts: Omit<import('../src/createServer.ts').CreateServerOptions, 'turnFetch'> & {
    turnFetch?: (url: any, options?: any) => Promise<any>;
} = {}) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  return {
    ...server,
    url: `http://127.0.0.1:${port}`,
    async teardown() {
      server.httpServer.closeAllConnections?.();
      await new Promise((resolve) =>
        server.io.close(() => server.httpServer.close(() => resolve(undefined)))
      );
    },
  };
}

/**
 * @param url - Base URL of the server under test.
 * @returns the created session id
 */
async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'turn-user', deviceId: 'turn-device' }),
  });
  return (await readJson(response)).sessionId;
}

/**
 * @param url - Base URL of the server under test.
 */
async function getCredentials(url: string, sessionId: string): Promise<{ response: Response; body: any; }> {
  const response = await fetch(`${url}/turn-credentials?sessionId=${encodeURIComponent(sessionId)}`);
  return { response, body: await readJson(response) };
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
      return {
        ok: true,
        text: async () => JSON.stringify({ iceServers: [{ urls: ['turn:cf.example'] }] }),
      };
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
    const expiresAt = first.response.headers.get('x-turn-credential-expires-at');
    assert.ok(expiresAt, 'the expiry header is present');
    assert.match(expiresAt, /^\d{4}-/);
    assert.deepEqual(second.body, first.body);
    assert.equal(calls, 1);
  } finally {
    await server.teardown();
  }
});

test('GET /turn-credentials accepts object-shaped iceServers from Cloudflare', async () => {
  const server = await startServer({
    turnEnv: {
      CLOUDFLARE_TURN_KEY_ID: 'key-id',
      CLOUDFLARE_TURN_API_TOKEN: 'api-token',
      CLOUDFLARE_TURN_TTL_SECONDS: '3600',
    },
    turnFetch: async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          iceServers: {
            urls: ['turn:cf.example', 'turns:cf.example?transport=tcp'],
            username: 'user',
            credential: 'secret',
          },
        }),
    }),
  });
  try {
    const sessionId = await createSession(server.url);
    const result = await getCredentials(server.url, sessionId);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, [
      { urls: ['stun:stun.l.google.com:19302'] },
      {
        urls: ['turn:cf.example', 'turns:cf.example?transport=tcp'],
        username: 'user',
        credential: 'secret',
      },
    ]);
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

test('GET /turn-credentials mints HMAC credentials for coturn use-auth-secret', async () => {
  const server = await startServer({
    turnEnv: {
      TURN_STATIC_AUTH_SECRET: 'super-secret',
      TURN_URL: 'turn:turn.example.com:3478, turns:turn.example.com:5349',
      TURN_TTL_SECONDS: '600',
    },
  });
  try {
    const sessionId = await createSession(server.url);
    const before = Math.floor(Date.now() / 1000);
    const { response, body } = await getCredentials(server.url, sessionId);
    const after = Math.floor(Date.now() / 1000);

    assert.equal(response.status, 200);
    assert.deepEqual(body[0], { urls: ['stun:stun.l.google.com:19302'] });
    assert.deepEqual(body[1].urls, ['turn:turn.example.com:3478', 'turns:turn.example.com:5349']);

    const [expiry, userId] = body[1].username.split(':');
    assert.equal(userId, 'turn-user');
    assert.ok(Number(expiry) >= before + 600 && Number(expiry) <= after + 600);
    assert.equal(
      body[1].credential,
      createHmac('sha1', 'super-secret').update(body[1].username).digest('base64'),
    );

    const expiresAtHeader = response.headers.get('x-turn-credential-expires-at');
    assert.ok(expiresAtHeader, 'the expiry header is present');
    assert.equal(Math.floor(Date.parse(expiresAtHeader) / 1000), Number(expiry));
  } finally {
    await server.teardown();
  }
});

test('GET /turn-credentials mints per-user HMAC credentials without sharing a cache', async () => {
  const server = await startServer({
    turnEnv: {
      TURN_STATIC_AUTH_SECRET: 'super-secret',
      TURN_URL: 'turn:turn.example.com:3478',
    },
  });
  try {
    const first = await getCredentials(server.url, await createSession(server.url));
    const secondSession = await readJson(
      await fetch(`${server.url}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'other-user', deviceId: 'turn-device-2' }),
      })
    );
    const second = await getCredentials(server.url, secondSession.sessionId);

    assert.match(first.body[1].username, /:turn-user$/);
    assert.match(second.body[1].username, /:other-user$/);
    assert.notEqual(first.body[1].credential, second.body[1].credential);
  } finally {
    await server.teardown();
  }
});

test('GET /turn-credentials prefers Cloudflare over HMAC credentials', async () => {
  const server = await startServer({
    turnEnv: {
      CLOUDFLARE_TURN_KEY_ID: 'key-id',
      CLOUDFLARE_TURN_API_TOKEN: 'api-token',
      TURN_STATIC_AUTH_SECRET: 'super-secret',
      TURN_URL: 'turn:turn.example.com:3478',
    },
    turnFetch: async () => ({
      ok: true,
      text: async () => JSON.stringify({ iceServers: [{ urls: ['turn:cf.example'] }] }),
    }),
  });
  try {
    const { body } = await getCredentials(server.url, await createSession(server.url));
    assert.deepEqual(body[1], { urls: ['turn:cf.example'] });
  } finally {
    await server.teardown();
  }
});

test('GET /turn-credentials falls through to static credentials when TURN_URL is missing', async () => {
  const originalWarn = console.warn;
  const warns: string[] = [];
  console.warn = (...args) => {
    warns.push(args.join(' '));
  };
  const server = await startServer({
    turnEnv: {
      TURN_STATIC_AUTH_SECRET: 'super-secret',
      TURN_USERNAME: 'static-user',
      TURN_CREDENTIAL: 'static-password',
    },
  });
  try {
    const { body } = await getCredentials(server.url, await createSession(server.url));
    assert.equal(body[1].username, 'static-user');
    assert.equal(body[1].credential, 'static-password');
    assert.ok(warns.some((line) => line.includes('TURN_STATIC_AUTH_SECRET is set but TURN_URL is missing')));
  } finally {
    console.warn = originalWarn;
    await server.teardown();
  }
});

test('GET /turn-credentials requires a valid session and is rate limited', async () => {  const server = await startServer({ turnEnv: {}, turnRateLimit: 1 });
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

test('GET /turn-credentials logs minting failures at error level when no static TURN exists', async () => {
  const originalError = console.error;
  const originalWarn = console.warn;
  const errors: string[] = [];
  const warns: string[] = [];
  console.error = (...args) => {
    errors.push(args.join(' '));
  };
  console.warn = (...args) => {
    warns.push(args.join(' '));
  };

  const server = await startServer({
    turnEnv: {
      CLOUDFLARE_TURN_KEY_ID: 'key-id',
      CLOUDFLARE_TURN_API_TOKEN: 'api-token',
    },
    turnFetch: async () => ({
      ok: false,
      status: 500,
      text: async () => '{"error":"boom"}',
    }),
  });
  try {
    const sessionId = await createSession(server.url);
    const result = await getCredentials(server.url, sessionId);
    assert.equal(result.response.status, 200);
    assert.ok(
      errors.some((line) => line.includes('[turn] credential minting failed: Cloudflare TURN API returned 500')),
    );
    assert.ok(errors.some((line) => line.includes('body={"error":"boom"}')));
    assert.equal(warns.length, 0);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    await server.teardown();
  }
});
