/**
 * Tests for the DB persistence layer for user identity and device registration.
 *
 * These tests inject a mock Drizzle `db` into `createServer()` so they run
 * entirely in-memory (no DATABASE_URL needed).  Each test verifies that the
 * server writes to (and reads from) the database at the right moments.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/index.ts';
import { createCallRecord, appendCallEvent } from '../src/domain/calls.ts';
import { pruneDeadDevice, pruneStaleDevices } from '../src/lib/persistence.ts';
import { upsertDevice, resolveReachableChannels, summarizeDeviceFanout } from '../src/lib/state.ts';
import { createStores } from '../src/stores/index.ts';
import { createMemoryCache } from '../src/cache.ts';
import * as schema from '../db/schema.ts';
import { asDatabase, closeTestServer, listenOnRandomPort, postJson } from './helpers.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** @param [opts] */
async function startServer(opts?: import('../src/createServer.ts').CreateServerOptions) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;
  async function teardown() {
    await closeTestServer(server);
  }
  return { ...server, url, teardown };
}

/**
 * Build a minimal mock Drizzle db that records every `.insert()` call.
 * The `.select().from()` chain returns the given `selectRows`.
 */
function buildMockDb({ selectRows = ([] as any[]), selectRowsByTable = new Map() } = {}) {
  const inserts: any[] = [];
  const deletes: any[] = [];
  const updates: any[] = [];

  const db = {
    inserts,
    deletes,
    updates,

    select() {
      return {
        from(table: any) {
          if (selectRowsByTable.has(table)) {
            return Promise.resolve(selectRowsByTable.get(table));
          }
          return Promise.resolve(selectRows);
        },
      };
    },

    insert(_table: any) {
      const entry: { table: any; values: any; conflictSet: any; } = { table: _table, values: null, conflictSet: null };
      inserts.push(entry);
      return {
        values(v: any) {
          entry.values = v;
          return {
            then(resolve: any, reject: any) {
              return Promise.resolve().then(resolve, reject);
            },
            catch(reject: any) {
              return Promise.resolve().catch(reject);
            },
            onConflictDoUpdate({ set }: { set: any; }) {
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

    delete(table: any) {
      return {
        where(condition: any) {
          deletes.push({ table, condition });
          return Promise.resolve();
        },
      };
    },

    update(table: any) {
      const entry: { table: any; set: any; condition: any; } = { table, set: null, condition: null };
      updates.push(entry);
      return {
        set(values: any) {
          entry.set = values;
          return {
            where(condition: any) {
              entry.condition = condition;
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  // The double implements only the slice of the Drizzle surface these tests
  // exercise; assert it once here rather than at every injection point.
  return asDatabase(db);
}

function buildCallEventOrderingDb() {
  let callPersisted = false;
  const operations: any[] = [];

  return asDatabase({
    operations,
    insert(table: any) {
      return {
        values() {
          if (table === schema.calls) {
            return {
              onConflictDoUpdate() {
                operations.push('call-start');
                return new Promise((resolve) => {
                  setImmediate(() => {
                    callPersisted = true;
                    operations.push('call-finish');
                    resolve(undefined);
                  });
                });
              },
            };
          }
          if (table === schema.callEvents) {
            return {
              catch(reject: any) {
                operations.push(callPersisted ? 'event-after-call' : 'event-before-call');
                return Promise.resolve().catch(reject);
              },
            };
          }
          return {
            onConflictDoUpdate() {
              return Promise.resolve();
            },
          };
        },
      };
    },
  });
}

function buildCallState(db: import('../db/client.ts').Database | null): import('../src/stores/contracts.ts').ServerState {
  return ({
    calls: new Map(),
    callEvents: new Map(),
    cache: createMemoryCache(),
    userConnections: new Map(),
    userDevices: new Map(),
    userSessions: new Map([['callee', new Set(['session-callee'])]]),
    userPresence: new Map(),
    devices: new Map(),
    db,
  } as any);
}

// ─── POST /session – claimed identity persisted to DB ─────────────────────────

test('POST /session persists a newly authenticated identity to the DB', async () => {
  const db = buildMockDb();
  const { url, teardown } = await startServer({ db });

  try {
    const res = await postJson(url, '/session', {
      userId: 'user-persist-1',
      deviceId: 'device-p1',
    });
    assert.equal(res.status, 201);

    // Two inserts: the claimed user record and the device record.
    assert.equal(db.inserts.length, 2);
    const insert = db.inserts.find((i) => i.table === schema.users);
    assert.ok(insert, 'a users insert should be present');
    assert.equal(insert.values.userId, 'user-persist-1');
    assert.equal(insert.values.authUid, 'test-user-persist-1');
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

    // The device must be recorded so the `devices` table reflects every device.
    const deviceInserts = db.inserts.filter((i) => i.table === schema.devices);
    assert.equal(deviceInserts.length, 1);
    assert.equal(deviceInserts[0].values.deviceId, 'device-p2');
    assert.equal(deviceInserts[0].values.userId, 'user-persist-2');
    assert.equal(deviceInserts[0].values.platform, 'android');
    assert.equal(deviceInserts[0].values.pushToken, null);
    // A session must never clobber an already-registered push token.
    assert.ok(
      !('pushToken' in deviceInserts[0].conflictSet),
      'session persistence must leave push columns untouched on conflict'
    );
    assert.equal(db.inserts.filter((i) => i.table === schema.users).length, 1);
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

    // Clear identity/device inserts from session creation.
    db.inserts.length = 0;

    const reg = await postJson(
      url,
      '/devices/register',
      { provider: 'apns', pushToken: 'apns-token-xyz' },
      session.body.sessionId
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
      session.body.sessionId
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
      'lastUnregisteredAt should be a Date'
    );
    assert.ok(insert.conflictSet, 'onConflictDoUpdate set should be present');
  } finally {
    await teardown();
  }
});

// ─── Re-registration replaces stale token rows, never appends ─────────────────

test('re-registering the same device_id with a new token replaces the row, not appends', async () => {
  const db = buildMockDb();
  const { url, teardown } = await startServer({ db });

  try {
    const session = await postJson(url, '/session', {
      userId: 'user-replace-1',
      deviceId: 'device-replace-1',
    });
    assert.equal(session.status, 201);

    await postJson(
      url,
      '/devices/register',
      { provider: 'fcm', pushToken: 'token-A' },
      session.body.sessionId
    );
    db.inserts.length = 0;
    db.updates.length = 0;

    const reg2 = await postJson(
      url,
      '/devices/register',
      { provider: 'fcm', pushToken: 'token-B' },
      session.body.sessionId
    );
    assert.equal(reg2.status, 200);

    // Same device_id → same primary key row is upserted, not duplicated.
    assert.equal(db.inserts.length, 1);
    const insert = db.inserts[0];
    assert.equal(insert.values.deviceId, 'device-replace-1');
    assert.equal(insert.values.pushToken, 'token-B');
    assert.ok(insert.conflictSet, 'onConflictDoUpdate set should be present');
  } finally {
    await teardown();
  }
});

test('registering a token already held by another device_id evicts the prior holder', async () => {
  const db = buildMockDb();
  const { url, teardown } = await startServer({ db });

  try {
    const sessionOld = await postJson(url, '/session', {
      userId: 'user-old',
      deviceId: 'device-old',
    });
    const sessionNew = await postJson(url, '/session', {
      userId: 'user-new',
      deviceId: 'device-new',
    });
    assert.equal(sessionOld.status, 201);
    assert.equal(sessionNew.status, 201);

    await postJson(
      url,
      '/devices/register',
      { provider: 'fcm', pushToken: 'shared-token' },
      sessionOld.body.sessionId
    );
    db.updates.length = 0;

    const reg = await postJson(
      url,
      '/devices/register',
      { provider: 'fcm', pushToken: 'shared-token' },
      sessionNew.body.sessionId
    );
    assert.equal(reg.status, 200);

    // The prior holder's row must be evicted (token/provider nulled) at the DB
    // level so the global unique index on push_token is never violated, and so
    // the stale row can no longer receive pushes meant for the new device.
    assert.equal(db.updates.length, 1);
    const update = db.updates[0];
    assert.equal(update.set.pushToken, null);
    assert.equal(update.set.pushProvider, null);
  } finally {
    await teardown();
  }
});

// ─── Dead-token pruning ────────────────────────────────────────────────────────

function buildMinimalState(db: import('../db/client.ts').Database | null): import('../src/stores/contracts.ts').ServerState {
  return ({ ...createStores(), db } as any);
}

test('pruneDeadDevice deletes the device row from the DB and in-memory state', async () => {
  const db = buildMockDb();
  const state = buildMinimalState(db);
  upsertDevice(state, {
    deviceId: 'device-prune-1',
    userId: 'user-prune-1',
    pushProvider: 'fcm',
    pushToken: 'dead-token',
  });
  assert.ok(state.devices.has('device-prune-1'));

  await pruneDeadDevice(db, state, 'device-prune-1', 'UNREGISTERED');

  assert.equal(state.devices.has('device-prune-1'), false, 'in-memory row removed');
  assert.equal(db.deletes.length, 1);
  assert.equal(db.deletes[0].table, schema.devices);
});

test('pruneDeadDevice is a safe no-op on the DB (in-memory only) when db is null', async () => {
  const state = buildMinimalState(null);
  upsertDevice(state, {
    deviceId: 'device-prune-2',
    userId: 'user-prune-2',
    pushProvider: 'fcm',
    pushToken: 'dead-token-2',
  });
  assert.ok(state.devices.has('device-prune-2'));

  await assert.doesNotReject(pruneDeadDevice(null, state, 'device-prune-2', 'UNREGISTERED'));

  assert.equal(state.devices.has('device-prune-2'), false);
});

test('pruneDeadDevice is a no-op when the device is already absent', async () => {
  const db = buildMockDb();
  const state = buildMinimalState(db);

  await assert.doesNotReject(pruneDeadDevice(db, state, 'device-never-existed', 'UNREGISTERED'));

  assert.equal(db.deletes.length, 0, 'no DB delete for a device that was never registered');
});

// ─── Age-based device pruning ─────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Register a device row whose last push registration is `ageDays` old.
 */
function registerDeviceAged(state: any, deviceId: string, userId: string, ageDays: number, pushToken: string | null = `token-${deviceId}`): void {
  const timestamp = new Date(Date.now() - ageDays * DAY_MS).toISOString();
  upsertDevice(state, {
    deviceId,
    userId,
    pushProvider: pushToken ? 'fcm' : null,
    pushToken,
    lastRegisteredAt: timestamp,
  });
  // upsertDevice stamps `updatedAt` with "now"; age is judged by
  // `lastRegisteredAt`, so back-date the fallback too for rows that have none.
  state.devices.get(deviceId).updatedAt = timestamp;
}

/**
 * Run `fn` with console.warn captured.
 */
async function captureWarnings(fn: () => unknown | Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test('pruneStaleDevices removes registrations older than the window and keeps recent ones', async () => {
  const db = buildMockDb();
  const state = buildMinimalState(db);
  registerDeviceAged(state, 'device-stale', 'user-stale', 90);
  registerDeviceAged(state, 'device-fresh', 'user-stale', 1);

  const pruned = await pruneStaleDevices(db, state, { maxAgeMs: 60 * DAY_MS });

  assert.equal(pruned, 1);
  assert.equal(state.devices.has('device-stale'), false, 'abandoned row swept');
  assert.ok(state.devices.has('device-fresh'), 'recent row kept');
  assert.equal(db.deletes.length, 1);
  assert.equal(db.deletes[0].table, schema.devices);
  assert.equal(
    state.userDevices.get('user-stale')?.has('device-stale'),
    false,
    'the user -> device index is updated too'
  );
});

test('pruneStaleDevices keeps an old row that is merely unregistered but recent', async () => {
  const state = buildMinimalState(null);
  // No push token, but the row was touched yesterday: the install still exists,
  // the user just turned notifications off.
  registerDeviceAged(state, 'device-unregistered', 'user-unreg', 1, null);

  const pruned = await pruneStaleDevices(null, state, { maxAgeMs: 60 * DAY_MS });

  assert.equal(pruned, 0);
  assert.ok(state.devices.has('device-unregistered'));
});

test('pruneStaleDevices never removes the row backing an active session', async () => {
  const state = buildMinimalState(null);
  registerDeviceAged(state, 'device-session', 'user-session', 200);
  state.sessions.set('sess-live', {
    sessionId: 'sess-live',
    userId: 'user-session',
    deviceId: 'device-session',
    platform: 'android',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
  });

  const pruned = await pruneStaleDevices(null, state, { maxAgeMs: 60 * DAY_MS });

  assert.equal(pruned, 0);
  assert.ok(state.devices.has('device-session'), 'a session still resolves to this row');
});

test('pruneStaleDevices never removes the row backing a live socket connection', async () => {
  const state = buildMinimalState(null);
  registerDeviceAged(state, 'device-connected', 'user-connected', 200);
  state.userConnections.set(
    'user-connected',
    new Map([
      ['socket-1', {
        userId: 'user-connected',
        socketId: 'socket-1',
        deviceId: 'device-connected',
        sessionId: null,
      }],
    ])
  );

  const pruned = await pruneStaleDevices(null, state, { maxAgeMs: 60 * DAY_MS });

  assert.equal(pruned, 0);
  assert.ok(state.devices.has('device-connected'));
});

test('pruneStaleDevices leaves rows with no usable timestamp alone', async () => {
  const state = buildMinimalState(null);
  registerDeviceAged(state, 'device-undated', 'user-undated', 200);
  const device: any = state.devices.get('device-undated');
  device.lastRegisteredAt = null;
  device.updatedAt = null;

  const pruned = await pruneStaleDevices(null, state, { maxAgeMs: 60 * DAY_MS });

  assert.equal(pruned, 0, 'an unknown age is not evidence of abandonment');
});

// ─── Push fan-out cap ─────────────────────────────────────────────────────────

test('resolveReachableChannels caps push fan-out at the configured limit, newest first', async () => {
  const state = buildMinimalState(null);
  registerDeviceAged(state, 'device-oldest', 'user-fanout', 30);
  registerDeviceAged(state, 'device-middle', 'user-fanout', 10);
  registerDeviceAged(state, 'device-newest', 'user-fanout', 1);

  const channels = resolveReachableChannels(state, 'user-fanout', 2);
  const deviceIds = channels
    .filter((channel) => channel.type === 'push')
    .map((channel) => channel.deviceId);

  assert.deepEqual(deviceIds, ['device-newest', 'device-middle']);
});

test('resolveReachableChannels warns when the fan-out cap truncates delivery', async () => {
  const state = buildMinimalState(null);
  registerDeviceAged(state, 'device-a', 'user-capped', 30);
  registerDeviceAged(state, 'device-b', 'user-capped', 20);
  registerDeviceAged(state, 'device-c', 'user-capped', 10);

  const warnings = await captureWarnings(() => resolveReachableChannels(state, 'user-capped', 1));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Capped push fan-out user=user-capped devices=3 delivered=1/);
  assert.ok(
    warnings.every((line) => !line.includes('token-device-')),
    'the warning never contains a push token'
  );
});

test('resolveReachableChannels does not warn when every device is delivered to', async () => {
  const state = buildMinimalState(null);
  registerDeviceAged(state, 'device-only', 'user-uncapped', 1);

  const warnings = await captureWarnings(() => resolveReachableChannels(state, 'user-uncapped', 3));

  assert.deepEqual(warnings, []);
});

test('summarizeDeviceFanout reports aggregate counts without per-user detail', async () => {
  const state = buildMinimalState(null);
  registerDeviceAged(state, 'device-1', 'user-many', 1);
  registerDeviceAged(state, 'device-2', 'user-many', 2);
  registerDeviceAged(state, 'device-3', 'user-many', 3);
  registerDeviceAged(state, 'device-4', 'user-few', 1, null);

  const summary = summarizeDeviceFanout(state, 2);

  assert.equal(summary.total, 4);
  assert.equal(summary.pushRegistered, 3);
  assert.equal(summary.usersWithDevices, 2);
  assert.equal(summary.maxPerUser, 3);
  assert.equal(summary.threshold, 2);
  assert.equal(summary.usersOverThreshold, 1);
  assert.equal(
    JSON.stringify(summary).includes('user-many'),
    false,
    'aggregate only: no per-user detail'
  );
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
      caller.body.sessionId
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

test('appendCallEvent persists absent actor and reason as null', async () => {
  const db = buildMockDb();
  const state = buildCallState(db);
  const callId = '00000000-0000-0000-0000-000000000002';
  state.callEvents.set(callId, []);

  appendCallEvent(state, callId, 'created', '', '');
  await new Promise((resolve) => setImmediate(resolve));

  const events = state.callEvents.get(callId);
  assert.ok(events, 'the call has a recorded event list');
  const event = events[0];
  const insert = db.inserts.find((entry) => entry.table === schema.callEvents);
  assert.equal(event.actor, null);
  assert.equal(event.reason, null);
  assert.equal(insert.values.actor, null);
  assert.equal(insert.values.reason, null);
});

test('createCallRecord persists call_events only after the parent call row', async () => {
  const db = buildCallEventOrderingDb();
  const state = buildCallState(db);

  createCallRecord(state, {
    callerId: 'caller',
    calleeId: 'callee',
    ringingTimeoutMs: 30_000,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(db.operations, ['call-start', 'call-finish', 'event-after-call']);
});

// ─── loadPersistedState() – hydrates users and devices from DB ───────────────

test('loadPersistedState() populates state.users from DB rows', async () => {
  const userRows = [
    {
      userId: 'user-hydrate-1',
      authUid: 'account-hydrated',
      email: 'hydrated@example.com',
      authProvider: 'password',
      createdAt: new Date('2024-01-01T00:00:00Z'),
      verifiedAt: new Date('2024-01-01T00:00:01Z'),
    },
  ];
  const db = buildMockDb({ selectRows: userRows });
  const server = createServer({
    db,
    verifyIdToken: async (idToken) => ({ authUid: idToken }),
  });

  await server.loadPersistedState();

  // Verify the hydrated identity is protected from a different authenticated account.
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  try {
    const impostor = await postJson(url, '/session', {
      userId: 'user-hydrate-1',
      deviceId: 'device-x',
      idToken: 'account-impostor',
    });
    assert.equal(impostor.status, 409, 'hydrated identity should reject another account');
    assert.equal(impostor.body.code, 'identity_claimed');
  } finally {
    await closeTestServer(server);
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
    selectRowsByTable: new Map(([
      [schema.users, []],
      [schema.devices, []],
      [schema.calls, callRows],
      [schema.callEvents, eventRows],
      [schema.blocks, blockRows],
    ] as [any, any[]][])),
  });
  const server = createServer({ db });

  await server.loadPersistedState();

  const hydratedCall = server.getCall('00000000-0000-4000-8000-000000000111');
  assert.ok(hydratedCall, 'call should be available after hydration');
  assert.equal(hydratedCall.status, 'declined');

  const hydratedEvents = server.getCallEvents('00000000-0000-4000-8000-000000000111');
  assert.equal(hydratedEvents.length, 1);
  assert.equal(hydratedEvents[0].event, 'created');

  await closeTestServer(server);
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

  await closeTestServer(server);
});

test('loadPersistedState() is a no-op when no db is provided', async () => {
  // No db → should not throw.
  const server = createServer();
  await assert.doesNotReject(() => server.loadPersistedState());

  await closeTestServer(server);
});

test('loadPersistedState() fails loudly when users hydration fails', async () => {
  const db = asDatabase({
    select() {
      return {
        from(table: any) {
          if (table === schema.users) {
            return Promise.reject(new Error('users column missing'));
          }
          return Promise.resolve([]);
        },
      };
    },
  });
  const server = createServer({ db });
  await assert.rejects(() => server.loadPersistedState(), /failed to hydrate users from DB/);

  await closeTestServer(server);
});
