import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';

import { API_ROUTES, CLIENT_EVENTS, SERVER_EVENTS } from '../../shared/index.ts';
import { createServer, createStores } from '../src/index.ts';
import { closeTestServer, listenOnRandomPort, readJson } from './helpers.ts';
import type { SessionRecord, Stores } from '../src/stores/contracts.ts';

function createSessionState(): NonNullable<Stores['sessionState']> {
  const sharedSessions = new Map<string, SessionRecord>();
  const userSessionIds = new Map<string, Set<string>>();
  const revokedDevices = new Map<string, string>();
  return {
      get: async (sessionId: string) => sharedSessions.get(sessionId) ?? null,
      save: async (session: SessionRecord) => {
        sharedSessions.set(session.sessionId, { ...session });
        const ids = userSessionIds.get(session.userId) ?? new Set<string>();
        ids.add(session.sessionId);
        userSessionIds.set(session.userId, ids);
      },
      remove: async (sessionId: string) => {
        const session = sharedSessions.get(sessionId);
        sharedSessions.delete(sessionId);
        if (!session) return;
        const ids = userSessionIds.get(session.userId);
        ids?.delete(sessionId);
        if (ids?.size === 0) userSessionIds.delete(session.userId);
      },
      listByUser: async (userId: string) => Array.from(userSessionIds.get(userId) ?? [])
        .map((sessionId) => sharedSessions.get(sessionId))
        .filter((session): session is SessionRecord => Boolean(session)),
      revokeDevice: async (userId: string, deviceId: string, revokedAt: string) => {
        revokedDevices.set(`${userId}\n${deviceId}`, revokedAt);
      },
      getDeviceRevokedAt: async (userId: string, deviceId: string) =>
        revokedDevices.get(`${userId}\n${deviceId}`) ?? null,
  };
}

function createSharedStores(sessionState = createSessionState()): Stores {
  return { ...createStores(), sessionState };
}

async function startServer(opts: import('../src/createServer.ts').CreateServerOptions = {}) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;
  return { ...server, url };
}

async function postJson(url: string, path: string, body: Record<string, unknown>, sessionId?: string) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sessionId ? { authorization: 'Bearer ' + sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await readJson(response) };
}

async function getJson(url: string, path: string, sessionId: string) {
  const response = await fetch(`${url}${path}`, {
    headers: { authorization: 'Bearer ' + sessionId },
  });
  return { status: response.status, body: await readJson(response) };
}

async function createSession(
  url: string,
  userId: string,
  deviceId: string,
  body: Record<string, unknown> = {}
): Promise<string> {
  const result = await postJson(url, API_ROUTES.SESSION, { userId, deviceId, ...body });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.sessionId;
}

function connect(url: string, sessionId: string): Promise<import('socket.io-client').Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { auth: { sessionId }, forceNew: true, transports: ['websocket'] });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function waitFor(socket: import('socket.io-client').Socket, event: string, timeoutMs = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

test('GET /devices returns only the caller devices without push tokens', async () => {
  const server = await startServer();
  try {
    const alicePhone = await createSession(server.url, 'alice', 'alice-phone');
    await createSession(server.url, 'alice', 'alice-laptop');
    await createSession(server.url, 'bob', 'bob-phone');
    await postJson(
      server.url,
      API_ROUTES.DEVICES_REGISTER,
      { deviceId: 'alice-phone', provider: 'fcm', pushToken: 'secret-token' },
      alicePhone
    );

    const result = await getJson(server.url, API_ROUTES.DEVICES, alicePhone);

    assert.equal(result.status, 200);
    assert.deepEqual(
      result.body.devices.map((device: any) => device.deviceId).sort(),
      ['alice-laptop', 'alice-phone']
    );
    assert.equal(result.body.devices.some((device: any) => 'pushToken' in device), false);
    assert.equal(result.body.devices.find((device: any) => device.deviceId === 'alice-phone').current, true);
    assert.equal(result.body.devices.find((device: any) => device.deviceId === 'alice-phone').pushRegistered, true);
  } finally {
    await closeTestServer(server);
  }
});

test('a user cannot revoke another account device', async () => {
  const server = await startServer();
  try {
    const alice = await createSession(server.url, 'alice', 'alice-phone');
    const bob = await createSession(server.url, 'bob', 'bob-phone');

    const denied = await postJson(server.url, API_ROUTES.DEVICES_REVOKE, { deviceId: 'bob-phone' }, alice);
    const stillValid = await getJson(server.url, API_ROUTES.SESSION, bob);

    assert.equal(denied.status, 404);
    assert.equal(stillValid.status, 200);
  } finally {
    await closeTestServer(server);
  }
});

test('revoking a device is idempotent and invalidates its REST session', async () => {
  const server = await startServer();
  try {
    const phone = await createSession(server.url, 'alice', 'alice-phone');
    const laptop = await createSession(server.url, 'alice', 'alice-laptop');
    await postJson(
      server.url,
      API_ROUTES.DEVICES_REGISTER,
      { deviceId: 'alice-phone', provider: 'fcm', pushToken: 'secret-token' },
      phone
    );

    const first = await postJson(server.url, API_ROUTES.DEVICES_REVOKE, { deviceId: 'alice-phone' }, laptop);
    const second = await postJson(server.url, API_ROUTES.DEVICES_REVOKE, { deviceId: 'alice-phone' }, laptop);
    const revokedRest = await getJson(server.url, API_ROUTES.SESSION, phone);
    const inventory = await getJson(server.url, API_ROUTES.DEVICES, laptop);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(revokedRest.status, 401);
    const revoked = inventory.body.devices.find((device: any) => device.deviceId === 'alice-phone');
    assert.equal(revoked.pushRegistered, false);
    assert.equal(revoked.activeSession, false);
    assert.equal(typeof revoked.revokedAt, 'string');
  } finally {
    await closeTestServer(server);
  }
});

test('revoked shared sessions fail on an instance with a stale local cache', async () => {
  const sessionState = createSessionState();
  const first = await startServer({ stores: createSharedStores(sessionState) });
  const second = await startServer({ stores: createSharedStores(sessionState) });
  try {
    const phone = await createSession(first.url, 'alice', 'alice-phone');
    const laptop = await createSession(first.url, 'alice', 'alice-laptop');
    assert.equal((await getJson(second.url, API_ROUTES.SESSION, phone)).status, 200);

    assert.equal((await postJson(first.url, API_ROUTES.DEVICES_REVOKE, { deviceId: 'alice-phone' }, laptop)).status, 200);

    assert.equal((await getJson(second.url, API_ROUTES.SESSION, phone)).status, 401);
  } finally {
    await closeTestServer(first);
    await closeTestServer(second);
  }
});

test('revoking a connected device emits session.invalid and disconnects its socket', async () => {
  const server = await startServer();
  let socket: import('socket.io-client').Socket | undefined;
  try {
    const phone = await createSession(server.url, 'alice', 'alice-phone');
    const laptop = await createSession(server.url, 'alice', 'alice-laptop');
    socket = await connect(server.url, phone);
    const invalid = waitFor(socket, SERVER_EVENTS.SESSION_INVALID);
    const disconnect = waitFor(socket, 'disconnect');

    const result = await postJson(server.url, API_ROUTES.DEVICES_REVOKE, { deviceId: 'alice-phone' }, laptop);

    assert.equal(result.status, 200);
    assert.equal((await invalid).reason, 'revoked');
    await disconnect;
  } finally {
    socket?.disconnect();
    await closeTestServer(server);
  }
});

test('socket authorization re-checks shared state before handling packets', async () => {
  const stores = createSharedStores();
  const server = await startServer({ stores });
  let socket: import('socket.io-client').Socket | undefined;
  try {
    const session = await createSession(server.url, 'alice', 'alice-phone');
    socket = await connect(server.url, session);
    await stores.sessionState?.remove(session);
    const invalid = waitFor(socket, SERVER_EVENTS.SESSION_INVALID);
    const disconnect = waitFor(socket, 'disconnect');
    socket.emit(CLIENT_EVENTS.CALL_STATE_REPORT, { version: 1, activeCallIds: [] }, () => {});

    assert.equal((await invalid).reason, 'revoked');
    await disconnect;
  } finally {
    socket?.disconnect();
    await closeTestServer(server);
  }
});

test('a revoked installation must reauthenticate before minting another session', async () => {
  const stores = createSharedStores();
  let authTime = '2026-01-01T00:00:00.000Z';
  const server = await startServer({
    stores,
    verifyIdToken: async () => ({ authUid: 'alice-auth', authTime }),
  });
  try {
    const phone = await createSession(server.url, 'alice', 'alice-phone', { idToken: 'token' });
    const laptop = await createSession(server.url, 'alice', 'alice-laptop', { idToken: 'token' });
    assert.equal((await postJson(server.url, API_ROUTES.DEVICES_REVOKE, { deviceId: 'alice-phone' }, laptop)).status, 200);

    const withoutFreshAuth = await postJson(server.url, API_ROUTES.SESSION, {
      userId: 'alice',
      deviceId: 'alice-phone',
      idToken: 'token',
    });
    authTime = '2027-01-01T00:00:00.000Z';
    const withFreshAuth = await postJson(server.url, API_ROUTES.SESSION, {
      userId: 'alice',
      deviceId: 'alice-phone',
      idToken: 'token',
    });

    assert.equal((await getJson(server.url, API_ROUTES.SESSION, phone)).status, 401);
    assert.equal(withoutFreshAuth.status, 401);
    assert.equal(withoutFreshAuth.body.code, 'reauthentication_required');
    assert.equal(withFreshAuth.status, 201);
  } finally {
    await closeTestServer(server);
  }
});

test('sign-out-all revokes the current session and reports explicit semantics', async () => {
  const server = await startServer();
  try {
    const phone = await createSession(server.url, 'alice', 'alice-phone');
    await createSession(server.url, 'alice', 'alice-laptop');

    const result = await postJson(server.url, API_ROUTES.DEVICES_REVOKE_ALL, {}, phone);
    const revokedCurrent = await getJson(server.url, API_ROUTES.SESSION, phone);

    assert.equal(result.status, 200);
    assert.equal(result.body.includesCurrentDevice, true);
    assert.equal(result.body.reauthentication, 'required');
    assert.match(result.body.currentCallHandling, /disconnect/);
    assert.equal(revokedCurrent.status, 401);
  } finally {
    await closeTestServer(server);
  }
});

test('device inventory fails closed when shared session state is unavailable', async () => {
  const stores = createSharedStores();
  const originalList = stores.sessionState?.listByUser;
  const server = await startServer({ stores });
  try {
    const session = await createSession(server.url, 'alice', 'alice-phone');
    stores.sessionState!.listByUser = async () => {
      throw new Error('redis unavailable');
    };

    const result = await getJson(server.url, API_ROUTES.DEVICES, session);

    assert.equal(result.status, 503);
  } finally {
    if (originalList) stores.sessionState!.listByUser = originalList;
    await closeTestServer(server);
  }
});
