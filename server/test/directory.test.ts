import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/index.ts';
import { createMemoryStores } from '../src/stores/index.ts';
import { closeTestServer, createTestSharedBlocks, getJson, listenOnRandomPort, postJson } from './helpers.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startServer(opts = {}) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  async function teardown() {
    await closeTestServer(server);
  }

  return { ...server, url, teardown };
}

/**
 * @param url - Base URL of the server under test.
 * @returns the created session id
 */
async function createSession(url: string, userId: string): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId: `device-${userId}` });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('GET /users requires a valid session', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await getJson(url, '/users');
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

test('GET /users lists other known users and excludes self', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'alice');
    await createSession(url, 'bob');
    await createSession(url, 'carol');

    const res = await getJson(url, '/users', aliceSession);
    assert.equal(res.status, 200);
    const ids = res.body.users.map((u: { userId: string; }) => u.userId);
    assert.deepEqual(ids, ['bob', 'carol']);
    assert.equal(res.body.total, 2);
    // Each entry carries a lightweight presence snapshot.
    for (const user of res.body.users) {
      assert.equal(typeof user.status, 'string');
      assert.equal(typeof user.online, 'boolean');
      assert.ok('lastSeen' in user);
    }
  } finally {
    await teardown();
  }
});

test('GET /users filters by case-insensitive search substring', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'alice');
    await createSession(url, 'bob');
    await createSession(url, 'bobby');
    await createSession(url, 'carol');

    const res = await getJson(url, '/users?search=BOB', aliceSession);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.users.map((u: { userId: string; }) => u.userId),
      ['bob', 'bobby']
    );
  } finally {
    await teardown();
  }
});

test('GET /users honours limit and caps total separately', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'alice');
    await createSession(url, 'bob');
    await createSession(url, 'carol');
    await createSession(url, 'dave');

    const res = await getJson(url, '/users?limit=2', aliceSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.users.length, 2);
    assert.deepEqual(
      res.body.users.map((u: { userId: string; }) => u.userId),
      ['bob', 'carol']
    );
    // total reflects the full match count, not the paginated slice.
    assert.equal(res.body.total, 3);
  } finally {
    await teardown();
  }
});

test('GET /users resolves an exact peer independently of substring matches and pagination', async () => {
  const { url, teardown } = await startServer();
  try {
    const session = await createSession(url, 'alice');
    await createSession(url, 'bob');
    const peerSession = await createSession(url, 'bobby');
    const update = await fetch(`${url}/profile`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + peerSession },
      body: JSON.stringify({ displayName: 'Robert' }),
    });
    assert.equal(update.status, 200);

    const result = await getJson(url, '/users?userId=bobby&limit=1', session);
    assert.equal(result.status, 200);
    assert.equal(result.body.total, 1);
    assert.deepEqual(result.body.users.map((user: any) => ({
      userId: user.userId, displayName: user.displayName, avatarKey: user.avatarKey,
    })), [{ userId: 'bobby', displayName: 'Robert', avatarKey: null }]);
    assert.deepEqual((await getJson(url, '/users?userId=unknown', session)).body.users, []);
    assert.deepEqual((await getJson(url, '/users?userId=alice', session)).body.users, []);
    assert.equal((await getJson(url, '/users?userId=', session)).status, 400);
  } finally {
    await teardown();
  }
});

test('GET /users hides users in either direction of a block', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'alice');
    await createSession(url, 'bob');
    const carolSession = await createSession(url, 'carol');

    // Alice blocks bob → bob hidden from alice's directory.
    assert.equal((await postJson(url, '/blocks', { blockeeId: 'bob' }, aliceSession)).status, 200);
    // Carol blocks alice → carol hidden from alice's directory (reverse block).
    assert.equal(
      (await postJson(url, '/blocks', { blockeeId: 'alice' }, carolSession)).status,
      200
    );

    const res = await getJson(url, '/users', aliceSession);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.users.map((u: { userId: string; }) => u.userId),
      []
    );
    for (const peer of ['bob', 'carol']) {
      const exact = await getJson(url, `/users?userId=${peer}`, aliceSession);
      assert.equal(exact.status, 200);
      assert.deepEqual(exact.body.users, []);
    }
  } finally {
    await teardown();
  }
});

test('GET /users reads shared blocks once for many candidates and fails closed', async (t) => {
  const blockState = createTestSharedBlocks();
  const stores = Object.assign(createMemoryStores(), {
    stateAffinity: 'shared' as const,
    blockState,
  });
  const { url, teardown } = await startServer({ stores });
  t.after(teardown);
  const session = await createSession(url, 'alice');
  const peers = Array.from({ length: 150 }, (_, index) => `peer-${String(index).padStart(3, '0')}`);
  for (const peer of peers.toReversed()) stores.userPresence.set(peer, { lastSeen: null });
  await blockState.add('alice', peers[0]);
  await blockState.add(peers[1], 'alice');
  // Local state is deliberately stale in both directions.
  stores.blocks.set('alice', new Set([peers[2]]));
  const list = t.mock.method(blockState, 'list');
  const isBlocked = t.mock.method(blockState, 'isBlocked');

  const result = await getJson(url, '/users?limit=2', session);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.users.map((user: { userId: string }) => user.userId), peers.slice(2, 4));
  assert.equal(result.body.total, 148);
  assert.equal(list.mock.callCount(), 1);
  assert.deepEqual(list.mock.calls[0].arguments, ['alice', true]);
  assert.equal(isBlocked.mock.callCount(), 0);

  for (const peer of peers.slice(0, 2)) {
    const exact = await getJson(url, `/users?userId=${peer}`, session);
    assert.equal(exact.status, 200);
    assert.deepEqual(exact.body, { users: [], total: 0 });
  }
  assert.equal(list.mock.callCount(), 3);

  blockState.failure = true;
  const unavailable = await getJson(url, '/users', session);
  assert.equal(unavailable.status, 200);
  assert.deepEqual(unavailable.body, { users: [], total: 0 });
  assert.equal(list.mock.callCount(), 4);
  assert.equal(isBlocked.mock.callCount(), 0);
});

test('GET /users fails closed when shared block store is missing', async (t) => {
  const stores = Object.assign(createMemoryStores(), { stateAffinity: 'shared' as const });
  const { url, teardown } = await startServer({ stores });
  t.after(teardown);
  const session = await createSession(url, 'alice');
  stores.userPresence.set('bob', { lastSeen: null });

  const result = await getJson(url, '/users', session);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { users: [], total: 0 });
});
