'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, createStores } = require('../src/index.js');
const { createMemoryStores, STORE_NAMES } = require('../src/stores');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startServer(opts) {
  const server = createServer(opts);
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

// ─── createStores() / createMemoryStores() contract ──────────────────────────

test('createMemoryStores provides every store as a Map', () => {
  const stores = createMemoryStores();
  for (const name of STORE_NAMES) {
    assert.ok(stores[name] instanceof Map, `${name} should be a Map`);
    assert.equal(stores[name].size, 0);
  }
});

test('createStores defaults to fresh in-memory stores', () => {
  const a = createStores();
  const b = createStores();
  for (const name of STORE_NAMES) {
    assert.ok(a[name] instanceof Map);
    assert.notEqual(a[name], b[name], `${name} should be a distinct instance per bundle`);
  }
});

test('createStores returns an injected bundle that satisfies the contract', () => {
  const injected = createMemoryStores();
  assert.equal(createStores({ stores: injected }), injected);
});

test('createStores rejects a bundle missing a store', () => {
  const incomplete = createMemoryStores();
  delete incomplete.calls;
  assert.throws(() => createStores({ stores: incomplete }), /missing store "calls"/);
});

// ─── createServer uses injected stores ────────────────────────────────────────

test('createServer persists state into injected stores', async () => {
  const stores = createMemoryStores();
  const { url, teardown } = await startServer({ stores });
  try {
    const callerSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    const res = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    assert.equal(res.status, 201);
    const { callId } = res.body;

    // The call lives in the injected store, proving the server reads/writes it.
    assert.ok(stores.calls.has(callId));
    assert.equal(stores.calls.get(callId).status, 'ringing');
    assert.ok(stores.callEvents.has(callId));
    assert.ok(stores.sessions.size >= 2);
  } finally {
    await teardown();
  }
});

test('two servers with separate stores do not share call state', async () => {
  const a = await startServer({ stores: createMemoryStores() });
  const b = await startServer({ stores: createMemoryStores() });
  try {
    const callerSession = await createSession(a.url, 'user-alice');
    await createSession(a.url, 'user-bob');
    const res = await postJson(a.url, '/calls', { calleeId: 'user-bob' }, callerSession);
    assert.equal(res.status, 201);

    // Server B has its own stores and knows nothing about server A's call.
    assert.equal(b.getCall(res.body.callId), null);
  } finally {
    await a.teardown();
    await b.teardown();
  }
});
