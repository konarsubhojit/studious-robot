'use strict';

/**
 * Tests for the DB persistence layer for user identity and device registration.
 *
 * These tests inject a mock Drizzle `db` into `createServer()` so they run
 * entirely in-memory (no DATABASE_URL needed).  Each test verifies that the
 * server writes to (and reads from) the database at the right moments.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/index.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Build a minimal mock Drizzle db that records every `.insert()` call.
 * The `.select().from()` chain returns the given `selectRows`.
 */
function buildMockDb({ selectRows = [] } = {}) {
  const inserts = [];

  const db = {
    inserts,

    select() {
      return {
        from(_table) {
          return Promise.resolve(selectRows);
        },
      };
    },

    insert(_table) {
      const entry = { table: _table, values: null, conflictSet: null };
      inserts.push(entry);
      return {
        values(v) {
          entry.values = v;
          return {
            onConflictDoUpdate({ set }) {
              entry.conflictSet = set;
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return db;
}

// ─── POST /session – claimed identity persisted to DB ─────────────────────────

test('POST /session persists a newly claimed identity to the DB', async () => {
  const db = buildMockDb();
  const { url, teardown } = await startServer({ db });

  try {
    const res = await postJson(url, '/session', {
      userId: 'user-persist-1',
      deviceId: 'device-p1',
      verificationCode: 'secret-code',
    });
    assert.equal(res.status, 201);

    // Exactly one insert (for the user record).
    assert.equal(db.inserts.length, 1);
    const insert = db.inserts[0];
    assert.equal(insert.values.userId, 'user-persist-1');
    assert.ok(typeof insert.values.verificationHash === 'string', 'verificationHash should be a string');
    assert.ok(typeof insert.values.verificationSalt === 'string', 'verificationSalt should be a string');
    assert.ok(insert.conflictSet, 'onConflictDoUpdate set should be present');
  } finally {
    await teardown();
  }
});

test('POST /session without a verificationCode does NOT write to DB', async () => {
  const db = buildMockDb();
  const { url, teardown } = await startServer({ db });

  try {
    const res = await postJson(url, '/session', {
      userId: 'user-persist-2',
      deviceId: 'device-p2',
    });
    assert.equal(res.status, 201);
    assert.equal(db.inserts.length, 0, 'no DB write for unclaimed userId');
  } finally {
    await teardown();
  }
});

// ─── POST /devices/register – device push token persisted to DB ──────────────

test('POST /devices/register persists the device push token to the DB', async () => {
  const db = buildMockDb();
  const { url, teardown } = await startServer({ db });

  try {
    const session = await postJson(url, '/session', {
      userId: 'user-reg-1',
      deviceId: 'device-reg-1',
      platform: 'ios',
    });
    assert.equal(session.status, 201);

    // Clear inserts from session creation (none expected for unclaimed userId).
    db.inserts.length = 0;

    const reg = await postJson(
      url,
      '/devices/register',
      { provider: 'apns', pushToken: 'apns-token-xyz' },
      session.body.sessionId,
    );
    assert.equal(reg.status, 200);

    assert.equal(db.inserts.length, 1);
    const insert = db.inserts[0];
    assert.equal(insert.values.deviceId, 'device-reg-1');
    assert.equal(insert.values.userId, 'user-reg-1');
    assert.equal(insert.values.pushProvider, 'apns');
    assert.equal(insert.values.pushToken, 'apns-token-xyz');
    assert.ok(insert.conflictSet, 'onConflictDoUpdate set should be present');
  } finally {
    await teardown();
  }
});

// ─── POST /devices/unregister – cleared push token persisted to DB ────────────

test('POST /devices/unregister persists the cleared push token to the DB', async () => {
  const db = buildMockDb();
  const { url, teardown } = await startServer({ db });

  try {
    const session = await postJson(url, '/session', {
      userId: 'user-unreg-1',
      deviceId: 'device-unreg-1',
    });
    assert.equal(session.status, 201);

    await postJson(
      url,
      '/devices/register',
      { provider: 'fcm', pushToken: 'fcm-token-abc' },
      session.body.sessionId,
    );
    db.inserts.length = 0;

    const unreg = await postJson(url, '/devices/unregister', {}, session.body.sessionId);
    assert.equal(unreg.status, 200);

    assert.equal(db.inserts.length, 1);
    const insert = db.inserts[0];
    assert.equal(insert.values.deviceId, 'device-unreg-1');
    assert.equal(insert.values.pushProvider, null);
    assert.equal(insert.values.pushToken, null);
    assert.ok(insert.values.lastUnregisteredAt instanceof Date, 'lastUnregisteredAt should be a Date');
    assert.ok(insert.conflictSet, 'onConflictDoUpdate set should be present');
  } finally {
    await teardown();
  }
});

// ─── loadPersistedState() – hydrates users and devices from DB ───────────────

test('loadPersistedState() populates state.users from DB rows', async () => {
  const userRows = [
    {
      userId: 'user-hydrate-1',
      verificationHash: 'hash-abc',
      verificationSalt: 'salt-abc',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      verifiedAt: new Date('2024-01-01T00:00:01Z'),
    },
  ];
  const db = buildMockDb({ selectRows: userRows });
  const server = createServer({ db });

  await server.loadPersistedState();

  // Verify the claimed identity is now protected: a request without the code is rejected.
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  const url = `http://127.0.0.1:${port}`;

  try {
    const noCode = await postJson(url, '/session', {
      userId: 'user-hydrate-1',
      deviceId: 'device-x',
    });
    assert.equal(noCode.status, 409, 'hydrated identity should reject missing code');
    assert.equal(noCode.body.code, 'identity_conflict');
  } finally {
    server.httpServer.closeAllConnections?.();
    await new Promise((resolve) => server.io.close(() => server.httpServer.close(resolve)));
  }
});

test('loadPersistedState() populates state.devices and state.userDevices from DB rows', async () => {
  const deviceRows = [
    {
      deviceId: 'device-hydrate-1',
      userId: 'user-hydrate-2',
      platform: 'android',
      pushProvider: 'fcm',
      pushToken: 'fcm-hydrate-token',
      lastRegisteredAt: new Date('2024-06-01T00:00:00Z'),
      lastUnregisteredAt: null,
    },
  ];
  const db = buildMockDb({ selectRows: deviceRows });
  const server = createServer({ db });

  await server.loadPersistedState();

  // resolveReachableChannels should include the hydrated push channel.
  const channels = server.resolveReachableChannels('user-hydrate-2');
  assert.equal(channels.length, 1);
  assert.equal(channels[0].type, 'push');
  assert.equal(channels[0].deviceId, 'device-hydrate-1');
  assert.equal(channels[0].provider, 'fcm');
  assert.equal(channels[0].pushToken, 'fcm-hydrate-token');

  server.httpServer.closeAllConnections?.();
  await new Promise((resolve) => server.io.close(() => server.httpServer.close(resolve)));
});

test('loadPersistedState() is a no-op when no db is provided', async () => {
  // No db → should not throw.
  const server = createServer();
  await assert.doesNotReject(() => server.loadPersistedState());

  server.httpServer.closeAllConnections?.();
  await new Promise((resolve) => server.io.close(() => server.httpServer.close(resolve)));
});
