import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../src/index.ts';
import { closeTestServer, getJson, listenOnRandomPort, postJson, readJson } from './helpers.ts';
import { createMemoryStores, createRedisPgStores } from '../src/stores/index.ts';
import { createRedisSecurity, createPgSharedBlocks, RATE_LIMIT_LUA } from '../src/stores/security.ts';
import { createSharedRateLimiter, isBlockedAsync, isDirectoryVisibleAsync } from '../src/security.ts';
import { createTestSharedBlocks as fakeSharedBlocks, asSocketIoAdapter } from './helpers.ts';
import { CLIENT_EVENTS } from '../../shared/index.ts';
import { SIGNALING_VERSION } from '../src/config.ts';
import { deriveConversationId } from '../src/messageStore.ts';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.ts';
import { loadPersistedStateFromDb } from '../src/lib/persistence.ts';

function fakeSecurityClient() {
  const buckets = new Map<string, { count: number; expires: number }>();
  let now = 0;
  const client = {
    isReady: true,
    failure: false,
    calls: 0,
    advance(ms: number) { now += ms; },
    eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
      client.calls += 1;
      assert.equal(script, RATE_LIMIT_LUA);
      if (client.failure) throw new Error('Redis command failed');
      const key = options.keys[0];
      const [max, windowMs] = options.arguments.map(Number);
      let bucket = buckets.get(key);
      if (!bucket || bucket.expires <= now) {
        bucket = { count: 0, expires: now + windowMs };
        buckets.set(key, bucket);
      }
      const allowed = bucket.count < max;
      if (allowed) bucket.count += 1;
      return Promise.resolve([Number(allowed), Math.max(0, max - bucket.count), bucket.expires - now]);
    },
  };
  return client;
}

test('Redis security: combined budget, expiry, namespace and identity isolation, atomic concurrency', async () => {
  const client = fakeSecurityClient();
  const make = (namespace = 'send') => createSharedRateLimiter({
    namespace, maxRequests: 3, windowMs: 1000, security: createRedisSecurity(client),
  });
  const first = make();
  const second = make();
  const results = await Promise.all(Array.from({ length: 256 }, async (_value, index) =>
    (index % 2 ? first : second).check('alice')));
  assert.equal(results.filter(result => result.allowed).length, 3);
  assert.equal((await make('search').check('alice')).allowed, true);
  assert.equal((await first.check('bob')).allowed, true);
  assert.equal((await make('send:alice').check('bob')).remaining, 2);
  assert.equal((await make('send').check('alice:bob')).remaining, 2);
  assert.equal((await first.check('\ud800')).remaining, 2);
  assert.equal((await first.check('\ud801')).remaining, 2);
  client.advance(999);
  assert.equal((await second.check('alice')).allowed, false);
  client.advance(1);
  assert.equal((await second.check('alice')).remaining, 2);
});

test('Redis store security reuses busPub without creating another command connection', async () => {
  const commands = [fakeSecurityClient(), fakeSecurityClient(), fakeSecurityClient(), fakeSecurityClient()];
  let opened = 0;
  const stores = await createRedisPgStores({
    createClient: () => ({
      ...commands[opened++], connect: async () => {}, quit: async () => {}, on: () => {},
    }),
    createAdapter: () => asSocketIoAdapter(() => ({})),
  });
  try {
    assert.equal(opened, 4);
    const limiter = createSharedRateLimiter({ namespace: 'store', maxRequests: 1, windowMs: 1000, security: stores.security });
    assert.equal((await limiter.check('alice')).allowed, true);
    assert.equal((await limiter.check('alice')).allowed, false);
    assert.deepEqual(commands.map(client => client.calls), [2, 0, 0, 0]);
    assert.equal(opened, 4);
  } finally {
    await stores.close();
  }
});

test('all twelve server budgets await the injected shared security transport', async (t) => {
  for (const [key, value] of Object.entries({
    R2_ACCOUNT_ID: 'test-account', R2_BUCKET: 'test-private',
    R2_ACCESS_KEY_ID: 'test-key', R2_SECRET_ACCESS_KEY: 'test-secret',
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  let deny = false;
  const observed = new Set<string>();
  const stores = {
    ...createMemoryStores(), stateAffinity: 'shared' as const, blockState: fakeSharedBlocks(),
    security: {
      async check(namespace: string) {
        await new Promise(resolve => setImmediate(resolve));
        if (deny) observed.add(namespace);
        return { allowed: !deny, remaining: 0, resetAt: Date.now() + 1000 };
      },
      getStatus: () => ({ transport: 'redis' as const, degraded: false }),
    },
  };
  const server = await startServer({ stores });
  let socket: import('socket.io-client').Socket | undefined;
  try {
    const session = await createSession(server.url, 'alice');
    await createSession(server.url, 'bob');
    socket = await connect(server.url, { sessionId: session });
    deny = true;
    const requests: [string, string, object?][] = [
      ['POST', '/session', { userId: 'carol', deviceId: 'carol-device' }],
      ['POST', '/calls', { calleeId: 'bob' }],
      ['GET', '/turn-credentials'],
      ['POST', '/attachments/presign', { peerId: 'bob', type: 'image', mimeType: 'image/jpeg', sizeBytes: 100 }],
      ['GET', '/messages/search?q=hello'],
      ['GET', '/messages/sync?since=2000-01-01T00:00:00.000Z'],
      ['GET', '/attachments/download?peerId=bob&key=unused'],
      ['GET', '/account/export'],
      ['POST', '/account/delete', {}],
      ['PATCH', '/profile', { displayName: 'Alice' }],
      ['POST', '/avatar/presign', { mimeType: 'image/jpeg', sizeBytes: 100 }],
      ['GET', '/avatar/download?userId=bob'],
    ];
    for (const [method, path, body] of requests) {
      const response = await fetch(server.url + path, {
        method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(response.status, 429, path);
      await response.arrayBuffer();
    }
    for (const event of [CLIENT_EVENTS.RTC_OFFER, CLIENT_EVENTS.CALL_STATS, CLIENT_EVENTS.MESSAGE_SEND]) {
      const result = await emitWithAck(socket, event, { version: SIGNALING_VERSION });
      assert.equal(result.error.code, 'rate_limited', event);
    }
    assert.deepEqual([...observed].sort(), [
      'account-deletion', 'account-export', 'attachment-download', 'call-init', 'call-stats',
      'message-search', 'message-send', 'message-sync', 'profile-update', 'rtc', 'session', 'turn-credentials',
    ]);
  } finally {
    await server.teardown(socket);
  }
});

test('two independent servers share the profile budget and expose fallback/recovery health', async () => {
  const client = fakeSecurityClient();
  const makeStores = () => ({
    ...createMemoryStores(), stateAffinity: 'shared' as const,
    security: createRedisSecurity(client), blockState: fakeSharedBlocks(),
  });
  const first = await startServer({ stores: makeStores(), profileUpdateRateLimit: 2 });
  const second = await startServer({ stores: makeStores(), profileUpdateRateLimit: 2 });
  try {
    const firstSession = await createSession(first.url, 'alice');
    const secondSession = await createSession(second.url, 'alice');
    const update = async (url: string, session: string) => {
      const response = await fetch(`${url}/profile`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session },
        body: JSON.stringify({ displayName: 'Alice' }),
      });
      return response.status;
    };
    assert.equal(await update(first.url, firstSession), 200);
    assert.equal(await update(second.url, secondSession), 200);
    assert.equal(await update(first.url, firstSession), 429);
    client.failure = true;
    assert.equal(await update(first.url, firstSession), 200);
    assert.equal(await update(first.url, firstSession), 200);
    assert.equal(await update(first.url, firstSession), 429);
    assert.deepEqual((await getJson(first.url, '/health')).body.rateLimit, { transport: 'local', degraded: true });
    client.failure = false;
    assert.equal(await update(first.url, firstSession), 429);
    assert.deepEqual((await getJson(first.url, '/health')).body.rateLimit, { transport: 'redis', degraded: false });
  } finally {
    await first.teardown();
    await second.teardown();
  }
});

test('Redis security: disconnected client never queues, hanging commands are bounded, recovery works', async () => {
  const client = fakeSecurityClient();
  client.isReady = false;
  const security = createRedisSecurity(client, 15);
  const limiter = createSharedRateLimiter({ namespace: 'offline', maxRequests: 1, windowMs: 1000, security });
  assert.equal((await limiter.check('alice')).allowed, true);
  assert.equal((await limiter.check('alice')).allowed, false);
  assert.equal(client.calls, 0);
  client.isReady = true;
  const original = client.eval;
  let finish: (value: unknown) => void = () => {};
  client.eval = () => new Promise(resolve => { finish = resolve; });
  const started = Date.now();
  assert.equal((await limiter.check('bob')).allowed, true);
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(security.getStatus(), { transport: 'local', degraded: true });
  assert.equal((await limiter.check('bob')).allowed, false);
  await new Promise(resolve => setTimeout(resolve, 1020));
  client.eval = original;
  assert.equal((await limiter.check('carol')).allowed, true);
  assert.deepEqual(security.getStatus(), { transport: 'redis', degraded: false });
  finish([1, 0, 1000]);
  await new Promise(resolve => setImmediate(resolve));
});

test('Redis security caps hanging commands and expires queued work with one warning', async (t) => {
  let issued = 0;
  let warnings = 0;
  const original = console.warn;
  console.warn = () => { warnings += 1; };
  t.after(() => { console.warn = original; });
  const security = createRedisSecurity({
    isReady: true,
    eval: () => {
      issued += 1;
      return new Promise<unknown>(() => {});
    },
  }, 20);
  const limiter = createSharedRateLimiter({ namespace: 'hanging', maxRequests: 1, windowMs: 1000, security });
  const results = await Promise.all(Array.from({ length: 128 }, async (_value, index) => limiter.check(String(index))));
  assert.equal(results.filter(result => result.allowed).length, 128);
  assert.equal(issued, 64);
  assert.equal(warnings, 1);
  assert.deepEqual(security.getStatus(), { transport: 'local', degraded: true });
});

test('Postgres shared blocks use authoritative SQL, skip startup snapshots, and propagate failures', async () => {
  const queries: { text: string; params: unknown[] }[] = [];
  let rows: unknown[][] = [['alice', 'bob', '2026-10-03T00:00:00.000Z']];
  let failure = false;
  const db = drizzle({
    async query(config: { text: string }, params: unknown[]) {
      if (failure) throw new Error('database unavailable');
      queries.push({ text: config.text, params });
      return { rows, fields: [], rowCount: rows.length };
    },
  } as never, { schema });
  const blockState = createPgSharedBlocks(db);
  assert.equal(await blockState.isBlocked('alice', 'bob'), true);
  assert.deepEqual(queries[0].params.slice(0, 2), ['alice', 'bob']);
  assert.deepEqual(await blockState.list('bob', true), ['alice']);
  assert.match(queries[1].text, / or /);
  await blockState.add('alice', 'bob');
  assert.match(queries[2].text, /on conflict do nothing/);
  assert.equal(await blockState.remove('alice', 'bob'), true);
  assert.match(queries[3].text, /delete from "blocks".* and .*returning/);
  assert.equal(await blockState.erase('alice'), 1);
  assert.match(queries[4].text, /delete from "blocks".* or .*returning/);
  rows = [];
  const state = { ...createMemoryStores(), stateAffinity: 'shared' as const, blockState };
  state.blocks.set('alice', new Set(['bob']));
  assert.equal(await isBlockedAsync(state, 'alice', 'bob'), false);
  queries.length = 0;
  await loadPersistedStateFromDb(db, state);
  assert.ok(queries.every(query => !query.text.includes('"blocks"')));
  failure = true;
  assert.equal(await isDirectoryVisibleAsync(state, 'alice', 'bob'), false);
  await assert.rejects(blockState.list('alice'));
  await assert.rejects(blockState.add('alice', 'bob'));
  await assert.rejects(blockState.remove('alice', 'bob'));
  await assert.rejects(blockState.erase('alice'));
});

test('shared blocks: cross-instance mutations, enforcement, fail closed and account cleanup', async (t) => {
  for (const [key, value] of Object.entries({
    R2_ACCOUNT_ID: 'test-account', R2_BUCKET: 'test-private',
    R2_ACCESS_KEY_ID: 'test-key', R2_SECRET_ACCESS_KEY: 'test-secret',
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const shared = fakeSharedBlocks();
  const storesA = { ...createMemoryStores(), stateAffinity: 'shared' as const, blockState: shared };
  const storesB = { ...createMemoryStores(), stateAffinity: 'shared' as const, blockState: shared };
  const first = await startServer({ stores: storesA, accountDeletionGraceMs: 0 });
  const second = await startServer({ stores: storesB });
  let socket: import('socket.io-client').Socket | undefined;
  try {
    const aliceA = await createSession(first.url, 'alice');
    const aliceB = await createSession(second.url, 'alice');
    const bob = await createSession(second.url, 'bob');
    socket = await connect(second.url, { sessionId: bob });
    const send = () => emitWithAck(socket!, CLIENT_EVENTS.MESSAGE_SEND, {
      version: SIGNALING_VERSION, recipientId: 'alice', body: 'shared history',
    });
    assert.equal((await send()).ok, true);
    assert.equal((await postJson(first.url, '/blocks', { blockeeId: 'bob' }, aliceA)).status, 200);
    assert.equal(await isBlockedAsync(storesB, 'alice', 'bob'), true);
    assert.equal((await getJson(second.url, '/users', bob)).body.users.length, 0);
    assert.equal((await postJson(second.url, '/calls', { calleeId: 'alice' }, bob)).status, 403);
    assert.equal((await send()).error.code, 'forbidden');
    const group = await emitWithAck(socket, CLIENT_EVENTS.CONVERSATION_CREATE, {
      version: SIGNALING_VERSION, name: 'Blocked group', inviteeIds: ['alice'],
    });
    assert.equal(group.error.code, 'forbidden');
    assert.deepEqual((await getJson(second.url, '/messages/search?q=history', bob)).body.results, []);
    assert.deepEqual((await getJson(second.url, '/messages/sync?since=2000-01-01T00:00:00.000Z', bob)).body.changes, []);
    assert.deepEqual((await getJson(second.url, '/conversations', bob)).body.conversations, []);
    const avatar = () => getJson(second.url, '/avatar/download?userId=alice', bob);
    const presign = () => postJson(second.url, '/attachments/presign', {
      peerId: 'alice', type: 'image', mimeType: 'image/jpeg', sizeBytes: 100,
    }, bob);
    const key = `chatblobs/${deriveConversationId('alice', 'bob')}/00000000-0000-4000-8000-000000000000.jpg`;
    const download = () => getJson(second.url, '/attachments/download?peerId=alice&key=' + encodeURIComponent(key), bob);
    assert.equal((await avatar()).status, 403);
    assert.equal((await presign()).status, 403);
    assert.equal((await download()).status, 403);
    assert.deepEqual((await getJson(second.url, '/blocks', aliceB)).body.blockedUsers, ['bob']);
    assert.equal((await deleteJson(second.url, '/blocks/bob', aliceB)).status, 200);
    // Even a stale local startup snapshot cannot resurrect the unblock.
    storesA.blocks.set('alice', new Set(['bob']));
    assert.equal(await isDirectoryVisibleAsync(storesA, 'alice', 'bob'), true);
    assert.equal((await send()).ok, true);
    assert.equal((await presign()).status, 200);
    shared.failure = true;
    assert.equal(await isBlockedAsync(storesB, 'alice', 'bob'), true);
    assert.equal((await getJson(second.url, '/users', bob)).body.users.length, 0);
    assert.equal((await send()).error.code, 'forbidden');
    assert.equal((await avatar()).status, 403);
    assert.equal((await download()).status, 403);
    assert.equal((await getJson(second.url, '/blocks', aliceB)).status, 503);
    assert.equal((await postJson(first.url, '/blocks', { blockeeId: 'bob' }, aliceA)).status, 503);
    assert.equal((await deleteJson(second.url, '/blocks/bob', aliceB)).status, 503);
    shared.failure = false;
    await shared.add('alice', 'bob');
    await shared.add('bob', 'alice');
    assert.equal((await postJson(first.url, '/account/delete', {}, aliceA)).status, 202);
    assert.equal(await first.runAccountDeletionSweep(Date.now() + 1000), 1);
    assert.deepEqual(await shared.list('bob', true), []);
  } finally {
    await first.teardown();
    await second.teardown(socket);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startServer(opts: import('../src/createServer.ts').CreateServerOptions = {}) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  /** @param clients */
  async function teardown(...clients: (import('socket.io-client').Socket | undefined)[]) {
    clients.forEach((c) => c?.disconnect());
    await closeTestServer(server);
  }

  return { ...server, url, teardown };
}

/**
 * @param url - Base URL of the server under test.
 * @param path - Request path, including the leading slash.
 * @param sessionId - Sent as `Authorization: Bearer <id>` when present.
 */
async function deleteJson(url: string, path: string, sessionId?: string): Promise<{ status: number; body: any; }> {
  const response = await fetch(`${url}${path}`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      ...(sessionId ? { authorization: `Bearer ${sessionId}` } : {}),
    },
  });
  return { status: response.status, body: await readJson(response) };
}

/**
 * @param url - Base URL of the server under test.
 * @returns the created session id
 */
async function createSession(url: string, userId: string, deviceId: string = `device-${userId}`): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

/**
 * @param auth - Socket.IO handshake auth payload.
 */
function connect(url: string, auth?: Record<string, unknown>): Promise<import('socket.io-client').Socket> {
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
 * @returns the server's acknowledgement
 */
function emitWithAck(socket: import('socket.io-client').Socket, event: string, payload: unknown): Promise<any> {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}

function waitFor(socket: import('socket.io-client').Socket, event: string, timeoutMs: number = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

// ─── Block management (HTTP) ──────────────────────────────────────────────────

test('POST /blocks: can block a user; GET /blocks: lists blocked users', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    const block = await postJson(url, '/blocks', { blockeeId: 'user-bob' }, aliceSession);
    assert.equal(block.status, 200);
    assert.equal(block.body.blockerId, 'user-alice');
    assert.equal(block.body.blockeeId, 'user-bob');

    const list = await getJson(url, '/blocks', aliceSession);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.blockedUsers, ['user-bob']);
  } finally {
    await teardown();
  }
});

test('DELETE /blocks/:blockeeId: can unblock a user', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');

    await postJson(url, '/blocks', { blockeeId: 'user-bob' }, aliceSession);

    const unblock = await deleteJson(url, '/blocks/user-bob', aliceSession);
    assert.equal(unblock.status, 200);
    assert.equal(unblock.body.blockerId, 'user-alice');
    assert.equal(unblock.body.blockeeId, 'user-bob');

    const list = await getJson(url, '/blocks', aliceSession);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.blockedUsers, []);
  } finally {
    await teardown();
  }
});

test('DELETE /blocks/:blockeeId: returns 404 when block does not exist', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');

    const res = await deleteJson(url, '/blocks/user-ghost', aliceSession);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'block not found');
  } finally {
    await teardown();
  }
});

test('POST /blocks: requires authentication', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await postJson(url, '/blocks', { blockeeId: 'user-bob' }, 'bad-session');
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

test('POST /blocks: rejects missing blockeeId', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const res = await postJson(url, '/blocks', {}, aliceSession);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'blockeeId is required');
  } finally {
    await teardown();
  }
});

test('POST /blocks: rejects blocking yourself', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const res = await postJson(url, '/blocks', { blockeeId: 'user-alice' }, aliceSession);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'cannot block yourself');
  } finally {
    await teardown();
  }
});

test('POST /blocks: blocking is idempotent', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');

    await postJson(url, '/blocks', { blockeeId: 'user-bob' }, aliceSession);
    const second = await postJson(url, '/blocks', { blockeeId: 'user-bob' }, aliceSession);
    assert.equal(second.status, 200);

    const list = await getJson(url, '/blocks', aliceSession);
    assert.deepEqual(list.body.blockedUsers, ['user-bob']);
  } finally {
    await teardown();
  }
});

test('GET /blocks: requires authentication', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await getJson(url, '/blocks', 'bad-session');
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

// ─── Blocklist enforcement – HTTP ─────────────────────────────────────────────

test('POST /calls: blocked caller receives 403', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const bobSession = await createSession(url, 'user-bob');

    // Bob blocks Alice.
    const block = await postJson(url, '/blocks', { blockeeId: 'user-alice' }, bobSession);
    assert.equal(block.status, 200);

    // Alice tries to call Bob → should be rejected.
    const res = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'blocked');
  } finally {
    await teardown();
  }
});

test('POST /calls: unblocked caller can call again after block is removed', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const bobSession = await createSession(url, 'user-bob');

    await postJson(url, '/blocks', { blockeeId: 'user-alice' }, bobSession);
    await deleteJson(url, '/blocks/user-alice', bobSession);

    const res = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(res.status, 201);
  } finally {
    await teardown();
  }
});

// ─── Blocklist enforcement – Socket.IO ───────────────────────────────────────

test('call.initiate via socket: blocked caller receives blocked error', async () => {
  const { url, teardown } = await startServer();
  const aliceSession = await createSession(url, 'user-alice');
  const bobSession = await createSession(url, 'user-bob');
  await postJson(url, '/blocks', { blockeeId: 'user-alice' }, bobSession);
  const [caller, callee] = await Promise.all([
    connect(url, { sessionId: aliceSession }),
    connect(url, { sessionId: bobSession }),
  ]);
  try {
    const ack = await emitWithAck(caller, 'call.initiate', {
      version: 2,
      calleeId: 'user-bob',
    });
    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, 'blocked');
  } finally {
    await teardown(caller, callee);
  }
});

test('call.initiate via socket: callee does NOT receive incoming call when caller is blocked', async () => {
  const { url, teardown } = await startServer();
  const aliceSession = await createSession(url, 'user-alice');
  const bobSession = await createSession(url, 'user-bob');
  await postJson(url, '/blocks', { blockeeId: 'user-alice' }, bobSession);
  const [caller, callee] = await Promise.all([
    connect(url, { sessionId: aliceSession }),
    connect(url, { sessionId: bobSession }),
  ]);
  try {
    let calleeReceivedIncoming = false;
    callee.on('call.incoming', () => {
      calleeReceivedIncoming = true;
    });

    await emitWithAck(caller, 'call.initiate', { version: 2, calleeId: 'user-bob' });

    // Give the server a moment to deliver any spurious event.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      calleeReceivedIncoming,
      false,
      'callee should not receive incoming call from blocked caller'
    );
  } finally {
    await teardown(caller, callee);
  }
});

// ─── Rate limiting – call initiation ─────────────────────────────────────────

test('POST /calls: rate limit is enforced after exceeding the window', async () => {
  // Allow only 2 calls per window so the test is quick.
  const { url, teardown } = await startServer({ callRateLimit: 2, callRateWindowMs: 60_000 });
  try {
    const aliceSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    const first = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(first.status, 201);

    const second = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(second.status, 201);

    const third = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(third.status, 429);
    assert.equal(third.body.error, 'too many requests');
    assert.equal(typeof third.body.retryAfter, 'number');
  } finally {
    await teardown();
  }
});

test('POST /calls: rate limit is per-user – other users are not affected', async () => {
  const { url, teardown } = await startServer({ callRateLimit: 1, callRateWindowMs: 60_000 });
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const carolSession = await createSession(url, 'user-carol');
    await createSession(url, 'user-bob');

    // Alice exhausts her quota.
    await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    const aliceBlocked = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(aliceBlocked.status, 429);

    // Carol still has her own quota.
    const carolOk = await postJson(url, '/calls', { calleeId: 'user-bob' }, carolSession);
    assert.equal(carolOk.status, 201);
  } finally {
    await teardown();
  }
});

test('call.initiate via socket: rate limit is enforced', async () => {
  const { url, teardown } = await startServer({ callRateLimit: 2, callRateWindowMs: 60_000 });
  const aliceSession = await createSession(url, 'user-alice');
  const bobSession = await createSession(url, 'user-bob');
  const [caller, callee] = await Promise.all([
    connect(url, { sessionId: aliceSession }),
    connect(url, { sessionId: bobSession }),
  ]);
  try {
    const first = await emitWithAck(caller, 'call.initiate', { version: 2, calleeId: 'user-bob' });
    assert.equal(first.ok, true);

    const second = await emitWithAck(caller, 'call.initiate', { version: 2, calleeId: 'user-bob' });
    assert.equal(second.ok, true);

    const third = await emitWithAck(caller, 'call.initiate', { version: 2, calleeId: 'user-bob' });
    assert.equal(third.ok, false);
    assert.equal(third.error.code, 'rate_limited');
  } finally {
    await teardown(caller, callee);
  }
});

// ─── Rate limiting – RTC signaling ───────────────────────────────────────────

test('rtc.offer via socket: rate limit is enforced', async () => {
  // Allow only 1 RTC event per large window to reliably trigger the limit.
  const { url, teardown } = await startServer({ rtcRateLimit: 1, rtcRateWindowMs: 60_000 });
  const aliceSession = await createSession(url, 'user-alice');
  const bobSession = await createSession(url, 'user-bob');
  const [caller, callee] = await Promise.all([
    connect(url, { sessionId: aliceSession }),
    connect(url, { sessionId: bobSession }),
  ]);
  try {
    // Set up a ringing call.
    const incomingP = waitFor(callee, 'call.incoming');
    const ringingP = waitFor(caller, 'call.ringing');
    const callerStateP = waitFor(caller, 'call.state_changed');
    const calleeStateP = waitFor(callee, 'call.state_changed');
    const initiated = await emitWithAck(caller, 'call.initiate', {
      version: 2,
      calleeId: 'user-bob',
    });
    const callId = initiated.call.callId;
    await Promise.all([incomingP, ringingP, callerStateP, calleeStateP]);

    // Accept the call.
    const acceptCallerP = waitFor(caller, 'call.accept');
    const acceptCallerStateP = waitFor(caller, 'call.state_changed');
    const acceptCalleeStateP = waitFor(callee, 'call.state_changed');
    await emitWithAck(callee, 'call.accept', { version: 2, callId });
    await Promise.all([acceptCallerP, acceptCallerStateP, acceptCalleeStateP]);

    // First RTC offer is within quota.
    const firstOffer = await emitWithAck(caller, 'rtc.offer', {
      version: 2,
      callId,
      sdp: { type: 'offer', sdp: 'mock' },
    });
    assert.equal(firstOffer.ok, true);

    // Second RTC offer exceeds quota.
    const secondOffer = await emitWithAck(caller, 'rtc.offer', {
      version: 2,
      callId,
      sdp: { type: 'offer', sdp: 'mock2' },
    });
    assert.equal(secondOffer.ok, false);
    assert.equal(secondOffer.error.code, 'rate_limited');
  } finally {
    await teardown(caller, callee);
  }
});

// ─── Session expiry ───────────────────────────────────────────────────────────

test('GET /session: returns 401 after session expires', async () => {
  const { url, teardown } = await startServer({ sessionTtlMs: 100 });
  try {
    const res = await postJson(url, '/session', { userId: 'user-alice', deviceId: 'dev-1' });
    assert.equal(res.status, 201);
    assert.equal(typeof res.body.expiresAt, 'string');

    const sessionId = res.body.sessionId;

    // Immediately the session is valid.
    const valid = await getJson(url, '/session', sessionId);
    assert.equal(valid.status, 200);

    // Wait for TTL to elapse.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const expired = await getJson(url, '/session', sessionId);
    assert.equal(expired.status, 401);
  } finally {
    await teardown();
  }
});

test('socket connect: a stale sessionId downgrades to guest and emits session.invalid', async () => {
  const { url, teardown } = await startServer({ sessionTtlMs: 100 });
  let socket: import('socket.io-client').Socket | undefined;
  try {
    const sessionId = await createSession(url, 'user-alice');

    // Wait for the session to expire (simulates a server restart wiping the
    // in-memory session table just as well as a natural TTL expiry).
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Build the client manually (rather than via `connect()`) and register
    // the `session.invalid` listener before `connect` fires: the server may
    // emit it immediately after the handshake, arriving in the same read as
    // the CONNECT packet, so waiting for `connect` to resolve first can lose
    // the race and miss a `once`-registered listener.
    const client = ioClient(url, {
      auth: { sessionId },
      forceNew: true,
      transports: ['websocket'],
    });
    socket = client;
    const invalidPromise = waitFor(client, 'session.invalid');
    await new Promise((resolve, reject) => {
      client.once('connect', () => resolve(undefined));
      client.once('connect_error', reject);
    });

    const invalidPayload = await invalidPromise;
    assert.equal(invalidPayload.sessionId, sessionId);

    // The socket authenticated as a guest, so an authenticated action like
    // call.initiate is rejected instead of silently using the stale identity.
    const ack = await emitWithAck(client, 'call.initiate', { version: 2, calleeId: 'user-bob' });
    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, 'unauthorized');
  } finally {
    await teardown(socket);
  }
});

test('socket connect: a fresh guest (no sessionId presented) does not emit session.invalid', async () => {
  const { url, teardown } = await startServer();
  let socket: import('socket.io-client').Socket | undefined;
  try {
    socket = await connect(url, { userId: 'user-guest' });

    let receivedInvalid = false;
    socket.on('session.invalid', () => {
      receivedInvalid = true;
    });

    // Give any (incorrect) emission a moment to arrive.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(receivedInvalid, false);
  } finally {
    await teardown(socket);
  }
});

test('POST /calls: rejects an expired session', async () => {
  const { url, teardown } = await startServer({ sessionTtlMs: 100 });
  try {
    const aliceSession = (await postJson(url, '/session', { userId: 'user-alice' })).body.sessionId;
    await createSession(url, 'user-bob');

    await new Promise((resolve) => setTimeout(resolve, 200));

    const res = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

// A session id is a bearer token, so the default is a finite lifetime: the
// previous default of `SESSION_TTL_MS=0` meant a leaked token stayed valid for
// ever and `state.sessions` only ever grew.
//
// The TTL is asserted *exactly* rather than as a bound.  `createdAt` and
// `expiresAt` are derived from one clock read, so the difference between them
// is the configured lifetime and nothing else; a range check here previously
// let a second clock read drift the pair by a millisecond and turned that
// defect into an intermittent failure instead of a reproducible one.
test('sessions expire by default', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await postJson(url, '/session', { userId: 'user-alice' });
    assert.equal(res.status, 201);
    assert.ok(res.body.expiresAt, 'a default session carries an expiry');
    const ttlMs = Date.parse(res.body.expiresAt) - Date.parse(res.body.createdAt);
    assert.equal(ttlMs, 7 * 24 * 60 * 60 * 1000, `unexpected default TTL: ${ttlMs}ms`);
  } finally {
    await teardown();
  }
});

// `0` is still honoured for the deployments (and tests) that want it, but it
// now has to be asked for explicitly.
test('an explicit SESSION_TTL_MS of 0 restores non-expiring sessions', async () => {
  const { url, teardown } = await startServer({ sessionTtlMs: 0 });
  try {
    const res = await postJson(url, '/session', { userId: 'user-alice' });
    assert.equal(res.status, 201);
    assert.equal(res.body.expiresAt, null);
  } finally {
    await teardown();
  }
});

// ─── Session refresh ──────────────────────────────────────────────────────────

test('POST /session/refresh: returns a new session and invalidates the old one', async () => {
  const { url, teardown } = await startServer();
  try {
    const created = await postJson(url, '/session', { userId: 'user-alice' });
    assert.equal(created.status, 201);
    const oldSessionId = created.body.sessionId;

    const refresh = await postJson(url, '/session/refresh', {}, oldSessionId);
    assert.equal(refresh.status, 200);
    const newSessionId = refresh.body.sessionId;
    assert.notEqual(newSessionId, oldSessionId);
    assert.equal(refresh.body.userId, 'user-alice');

    // Old session is now invalid.
    const oldCheck = await getJson(url, '/session', oldSessionId);
    assert.equal(oldCheck.status, 401);

    // New session is valid.
    const newCheck = await getJson(url, '/session', newSessionId);
    assert.equal(newCheck.status, 200);
    assert.equal(newCheck.body.userId, 'user-alice');
  } finally {
    await teardown();
  }
});

test('POST /session/refresh: returns 401 for an invalid session', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await postJson(url, '/session/refresh', {}, 'bad-session');
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

test('POST /session/refresh: refreshed session extends TTL', async () => {
  const { url, teardown } = await startServer({ sessionTtlMs: 300 });
  try {
    const created = await postJson(url, '/session', { userId: 'user-alice' });
    const oldSessionId = created.body.sessionId;

    // Wait 150 ms – old session still valid but halfway through TTL.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const refresh = await postJson(url, '/session/refresh', {}, oldSessionId);
    assert.equal(refresh.status, 200);
    const newSessionId = refresh.body.sessionId;

    // New session has a future expiresAt.
    const newExpiresAt = new Date(refresh.body.expiresAt).getTime();
    assert.ok(newExpiresAt > Date.now(), 'new session should not be expired');

    // Wait another 200 ms – old session would be expired but new one isn't yet.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const check = await getJson(url, '/session', newSessionId);
    assert.equal(check.status, 200);
  } finally {
    await teardown();
  }
});

// ─── Audit log ────────────────────────────────────────────────────────────────

test('GET /audit-log: returns 401 without a valid session', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await getJson(url, '/audit-log', 'bad-session');
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

test("GET /audit-log: blocked call attempt appears in the caller's audit log", async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const bobSession = await createSession(url, 'user-bob');

    // Bob blocks Alice.
    await postJson(url, '/blocks', { blockeeId: 'user-alice' }, bobSession);

    // Alice attempts to call Bob.
    await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);

    const log = await getJson(url, '/audit-log', aliceSession);
    assert.equal(log.status, 200);
    const blockedEntry = log.body.entries.find((e: { event: string; }) => e.event === 'call.blocked');
    assert.ok(blockedEntry, 'audit log should contain a call.blocked entry');
    assert.equal(blockedEntry.actor, 'user-alice');
    assert.equal(blockedEntry.target, 'user-bob');
    assert.equal(blockedEntry.outcome, 'rejected');
  } finally {
    await teardown();
  }
});

test("GET /audit-log: rate-limited call attempt appears in the caller's audit log", async () => {
  const { url, teardown } = await startServer({ callRateLimit: 1, callRateWindowMs: 60_000 });
  try {
    const aliceSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession); // rate-limited

    const log = await getJson(url, '/audit-log', aliceSession);
    assert.equal(log.status, 200);
    const rateLimitEntry = log.body.entries.find((e: { event: string; }) => e.event === 'call.rate_limited');
    assert.ok(rateLimitEntry, 'audit log should contain a call.rate_limited entry');
    assert.equal(rateLimitEntry.actor, 'user-alice');
    assert.equal(rateLimitEntry.outcome, 'rejected');
  } finally {
    await teardown();
  }
});

test("GET /audit-log: block management events appear in the blocker's audit log", async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');

    await postJson(url, '/blocks', { blockeeId: 'user-bob' }, aliceSession);
    await deleteJson(url, '/blocks/user-bob', aliceSession);

    const log = await getJson(url, '/audit-log', aliceSession);
    assert.equal(log.status, 200);

    const addedEntry = log.body.entries.find((e: { event: string; }) => e.event === 'block.added');
    assert.ok(addedEntry, 'audit log should contain block.added');
    assert.equal(addedEntry.actor, 'user-alice');
    assert.equal(addedEntry.target, 'user-bob');

    const removedEntry = log.body.entries.find((e: { event: string; }) => e.event === 'block.removed');
    assert.ok(removedEntry, 'audit log should contain block.removed');
    assert.equal(removedEntry.actor, 'user-alice');
    assert.equal(removedEntry.target, 'user-bob');
  } finally {
    await teardown();
  }
});

test("GET /audit-log: session refresh appears in the user's audit log", async () => {
  const { url, teardown } = await startServer();
  try {
    const created = await postJson(url, '/session', { userId: 'user-alice' });
    const oldSessionId = created.body.sessionId;

    const refresh = await postJson(url, '/session/refresh', {}, oldSessionId);
    const newSessionId = refresh.body.sessionId;

    const log = await getJson(url, '/audit-log', newSessionId);
    assert.equal(log.status, 200);
    const refreshEntry = log.body.entries.find((e: { event: string; }) => e.event === 'session.refreshed');
    assert.ok(refreshEntry, 'audit log should contain session.refreshed');
    assert.equal(refreshEntry.actor, 'user-alice');
    assert.equal(refreshEntry.outcome, 'success');
  } finally {
    await teardown();
  }
});

test('GET /audit-log: user only sees their own events', async () => {
  const { url, teardown } = await startServer({ callRateLimit: 1, callRateWindowMs: 60_000 });
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const bobSession = await createSession(url, 'user-bob');
    await createSession(url, 'user-carol');

    // Alice exhausts her rate limit.
    await postJson(url, '/calls', { calleeId: 'user-carol' }, aliceSession);
    await postJson(url, '/calls', { calleeId: 'user-carol' }, aliceSession);

    // Bob's audit log should be empty (no events involving Bob yet).
    const bobLog = await getJson(url, '/audit-log', bobSession);
    assert.equal(bobLog.status, 200);
    const rateLimitEvents = bobLog.body.entries.filter((e: { event: string; }) => e.event === 'call.rate_limited');
    assert.equal(rateLimitEvents.length, 0, "Bob should not see Alice's rate-limit events");
  } finally {
    await teardown();
  }
});
