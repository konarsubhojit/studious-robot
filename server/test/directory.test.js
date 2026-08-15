'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/index.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function postJson(url, path, body, sessionId) {
  const payload = sessionId ? { ...body, sessionId } : body;
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(url, path, sessionId) {
  const pathname = sessionId
    ? `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(sessionId)}`
    : path;
  const response = await fetch(`${url}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function createSession(url, userId) {
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
    const ids = res.body.users.map((u) => u.userId);
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
      res.body.users.map((u) => u.userId),
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
      res.body.users.map((u) => u.userId),
      ['bob', 'carol']
    );
    // total reflects the full match count, not the paginated slice.
    assert.equal(res.body.total, 3);
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
      res.body.users.map((u) => u.userId),
      []
    );
  } finally {
    await teardown();
  }
});
