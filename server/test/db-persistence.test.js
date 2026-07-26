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
const schema = require('../db/schema');

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
function buildMockDb({ selectRows = [], selectRowsByTable = new Map() } = {}) {
  const inserts = [];
  const deletes = [];

  const db = {
    inserts,
    deletes,

    select() {
      return {
        from(table) {
          if (selectRowsByTable.has(table)) {
            return Promise.resolve(selectRowsByTable.get(table));
          }
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
            then(resolve, reject) {
              return Promise.resolve().then(resolve, reject);
            },
            catch(reject) {
              return Promise.resolve().catch(reject);
            },
            onConflictDoUpdate({ set }) {
              entry.conflictSet = set;
              return Promise.resolve();
            },
            onConflictDoNothing() {
              return Promise.resolve();
            },
          };
        },
      };
    },

    delete(table) {
      return {
        where(condition) {
          deletes.push({ table, condition });
          return Promise.resolve();
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

    // Two inserts: the claimed user record and the device record.
    assert.equal(db.inserts.length, 2);
    const insert = db.inserts.find((i) => i.table === schema.users);
    assert.ok(insert, 'a users insert should be present');
    assert.equal(insert.values.userId, 'user-persist-1');
    assert.ok(
      typeof insert.values.verificationHash === 'string',
      'verificationHash should be a string',
    );
    assert.ok(
      typeof insert.values.verificationSalt === 'string',
      'verificationSalt should be a string',
    );
    assert.ok(insert.conflictSet, 'onConflictDoUpdate set should be present');
  } finally {
    await teardown();
  }
});

test('POST /session persists the device even without a push token', async () => {
  const db = buildMockDb();
  const { url, teardown } = await startServer({ db });

  try {
    const res = await postJson(url, '/session', {
      userId: 'user-persist-2',
      deviceId: 'device-p2',
      platform: 'android',
    });
    assert.equal(res.status, 201);

    // No user insert (identity is unclaimed) but the device must be recorded so
    // the `devices` table reflects every device a user has signed in from.
    const deviceInserts = db.inserts.filter((i) => i.table === schema.devices);
    assert.equal(deviceInserts.length, 1);
    assert.equal(deviceInserts[0].values.deviceId, 'device-p2');
    assert.equal(deviceInserts[0].values.userId, 'user-persist-2');
    assert.equal(deviceInserts[0].values.platform, 'android');
    assert.equal(deviceInserts[0].values.pushToken, null);
    // A session must never clobber an already-registered push token.
    assert.ok(
      !('pushToken' in deviceInserts[0].conflictSet),
      'session persistence must leave push columns untouched on conflict',
    );
    assert.equal(
      db.inserts.filter((i) => i.table === schema.users).length,
      0,
      'no user write for an unclaimed userId',
    );
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
    assert.ok(
      insert.values.lastUnregisteredAt instanceof Date,
      'lastUnregisteredAt should be a Date',
    );
    assert.ok(insert.conflictSet, 'onConflictDoUpdate set should be present');
  } finally {
    await teardown();
  }
});

test('POST /calls persists call records and call events to the DB', async () => {
  const db = buildMockDb();
  const { url, teardown } = await startServer({ db });

  try {
    const caller = await postJson(url, '/session', {
      userId: 'user-call-persist-caller',
      deviceId: 'device-call-persist-caller',
    });
    assert.equal(caller.status, 201);

    const created = await postJson(
      url,
      '/calls',
      { calleeId: 'user-call-persist-callee' },
      caller.body.sessionId,
    );
    assert.equal(created.status, 201);

    const insertsIntoCalls = db.inserts.filter((entry) => entry.table === schema.calls);
    const insertsIntoCallEvents = db.inserts.filter((entry) => entry.table === schema.callEvents);
    assert.ok(insertsIntoCalls.length >= 1, 'expected at least one calls table upsert');
    assert.ok(insertsIntoCallEvents.length >= 1, 'expected at least one call_events insert');
    assert.equal(insertsIntoCalls[0].values.callerId, 'user-call-persist-caller');
    assert.equal(insertsIntoCalls[0].values.calleeId, 'user-call-persist-callee');
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

test('loadPersistedState() hydrates calls and call events from DB rows', async () => {
  const callRows = [
    {
      callId: '00000000-0000-4000-8000-000000000111',
      callerId: 'user-calls-hydrate-a',
      calleeId: 'user-calls-hydrate-b',
      status: 'declined',
      endReason: 'declined',
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:01:00Z'),
      ringTimeoutAt: null,
    },
  ];
  const eventRows = [
    {
      eventId: '00000000-0000-4000-8000-000000000112',
      callId: '00000000-0000-4000-8000-000000000111',
      event: 'created',
      actor: 'user-calls-hydrate-a',
      reason: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    },
  ];
  const blockRows = [{ blockerId: 'user-calls-hydrate-a', blockeeId: 'user-calls-hydrate-b' }];
  const db = buildMockDb({
    selectRowsByTable: new Map([
      [schema.users, []],
      [schema.devices, []],
      [schema.calls, callRows],
      [schema.callEvents, eventRows],
      [schema.blocks, blockRows],
    ]),
  });
  const server = createServer({ db });

  await server.loadPersistedState();

  const hydratedCall = server.getCall('00000000-0000-4000-8000-000000000111');
  assert.ok(hydratedCall, 'call should be available after hydration');
  assert.equal(hydratedCall.status, 'declined');

  const hydratedEvents = server.getCallEvents('00000000-0000-4000-8000-000000000111');
  assert.equal(hydratedEvents.length, 1);
  assert.equal(hydratedEvents[0].event, 'created');

  server.httpServer.closeAllConnections?.();
  await new Promise((resolve) => server.io.close(() => server.httpServer.close(resolve)));
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
