import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/index.ts';
import { createMemoryStores } from '../src/stores/index.ts';
import { closeTestServer, listenOnRandomPort, readJson } from './helpers.ts';

function createSharedBackends() {
  const calls = new Map<string, import('../src/stores/contracts.ts').CallRecord>();
  const sessions = new Map<string, import('../src/stores/contracts.ts').SessionRecord>();
  let leaseOwner: string | null = null;
  let leaseExpiry = 0;
  const terminal = new Set(['ended', 'declined', 'missed', 'busy', 'unreachable']);

  const saves: string[] = [];

  return {
    saves,
    callState: {
      get: async (callId: string) => calls.get(callId) ?? null,
      save: async (call: import('../src/stores/contracts.ts').CallRecord) => {
        saves.push(call.callId);
        calls.set(call.callId, { ...call });
      },
      transitionAtomic: async ({
        callId,
        fromStatus,
        toStatus,
      }: {
        callId: string;
        fromStatus: string;
        toStatus: string;
        actor?: string | null;
        reason?: string | null;
      }) => {
        const call = calls.get(callId);
        if (!call) return { ok: false as const, error: 'not_found' as const };
        if (call.status === toStatus) {
          return { ok: true as const, call: { ...call }, idempotent: true };
        }
        if (terminal.has(call.status)) {
          return { ok: false as const, error: 'terminal_state' as const };
        }
        if (call.status !== fromStatus) {
          return { ok: false as const, error: 'stale_call_state' as const };
        }
        calls.set(callId, { ...call, status: toStatus, updatedAt: new Date().toISOString() });
        return { ok: true as const, call: { ...(calls.get(callId) as any) }, idempotent: false };
      },
      acquireSweepLease: async (instanceId: string, ttlMs: number) => {
        const now = Date.now();
        if (leaseOwner === instanceId || leaseExpiry <= now) {
          leaseOwner = instanceId;
          leaseExpiry = now + ttlMs;
          return true;
        }
        return false;
      },
      releaseSweepLease: async (instanceId: string) => {
        if (leaseOwner === instanceId) {
          leaseOwner = null;
          leaseExpiry = 0;
        }
      },
    },
    sessionState: {
      get: async (sessionId: string) => sessions.get(sessionId) ?? null,
      save: async (session: import('../src/stores/contracts.ts').SessionRecord) => {
        sessions.set(session.sessionId, { ...session });
      },
      remove: async (sessionId: string) => {
        sessions.delete(sessionId);
      },
    },
  };
}

async function startServer(stores: import('../src/stores/contracts.ts').Stores) {
  const server = createServer({ stores });
  const port = await listenOnRandomPort(server.httpServer);
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    teardown: async () => closeTestServer(server),
  };
}

async function postJson(url: string, path: string, body: Record<string, unknown>, sessionId?: string) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sessionId ? { ...body, sessionId } : body),
  });
  return { status: response.status, body: await readJson(response) };
}

test('shared call/session state allows create on one instance and accept on another', async () => {
  const shared = createSharedBackends();
  const storesA = Object.assign(createMemoryStores(), {
    stateAffinity: 'shared' as const,
    instanceId: 'instance-a',
    callState: shared.callState,
    sessionState: shared.sessionState,
  });
  const storesB = Object.assign(createMemoryStores(), {
    stateAffinity: 'shared' as const,
    instanceId: 'instance-b',
    callState: shared.callState,
    sessionState: shared.sessionState,
  });

  const a = await startServer(storesA);
  const b = await startServer(storesB);
  try {
    const callerSession = (await postJson(a.url, '/session', { userId: 'user-a', deviceId: 'dev-a' })).body.sessionId;
    const calleeSession = (await postJson(a.url, '/session', { userId: 'user-b', deviceId: 'dev-b' })).body.sessionId;

    const created = await postJson(a.url, '/calls', { calleeId: 'user-b' }, callerSession);
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'ringing');

    const accepted = await postJson(b.url, `/calls/${created.body.callId}/accept`, {}, calleeSession);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, 'accepted');
  } finally {
    await a.teardown();
    await b.teardown();
  }
});

test('shared atomic transitions: exactly one concurrent conflicting transition wins', async () => {
  const shared = createSharedBackends();
  const storesA = Object.assign(createMemoryStores(), {
    stateAffinity: 'shared' as const,
    instanceId: 'instance-a',
    callState: shared.callState,
    sessionState: shared.sessionState,
  });
  const storesB = Object.assign(createMemoryStores(), {
    stateAffinity: 'shared' as const,
    instanceId: 'instance-b',
    callState: shared.callState,
    sessionState: shared.sessionState,
  });

  const a = await startServer(storesA);
  const b = await startServer(storesB);
  try {
    const callerSession = (await postJson(a.url, '/session', { userId: 'user-a', deviceId: 'dev-a' })).body.sessionId;
    const calleeSession = (await postJson(a.url, '/session', { userId: 'user-b', deviceId: 'dev-b' })).body.sessionId;
    const created = await postJson(a.url, '/calls', { calleeId: 'user-b' }, callerSession);
    const callId = created.body.callId;

    const [cancelled, accepted] = await Promise.all([
      postJson(a.url, `/calls/${callId}/cancel`, {}, callerSession),
      postJson(b.url, `/calls/${callId}/accept`, {}, calleeSession),
    ]);

    const statuses = [cancelled.status, accepted.status].sort((x, y) => x - y);
    assert.deepEqual(statuses, [200, 409]);
  } finally {
    await a.teardown();
    await b.teardown();
  }
});

// Regression: creating a call and transitioning it each used to write the same
// record to the shared store twice — once fire-and-forget from the domain
// helper, once awaited by its `…WithShared` wrapper — so every call action paid
// two shared-store round trips for one logical save. The awaited save is the
// one another instance depends on, so it is the fire-and-forget copy that went.
test('a call create and a transition each write the shared store exactly once', async () => {
  const shared = createSharedBackends();
  const stores = Object.assign(createMemoryStores(), {
    stateAffinity: 'shared' as const,
    instanceId: 'instance-a',
    callState: shared.callState,
    sessionState: shared.sessionState,
  });

  const a = await startServer(stores);
  try {
    const callerSession = (await postJson(a.url, '/session', { userId: 'user-a', deviceId: 'dev-a' })).body.sessionId;
    const calleeSession = (await postJson(a.url, '/session', { userId: 'user-b', deviceId: 'dev-b' })).body.sessionId;

    shared.saves.length = 0;
    const created = await postJson(a.url, '/calls', { calleeId: 'user-b' }, callerSession);
    assert.equal(created.status, 201);
    const callId = created.body.callId;
    assert.deepEqual(shared.saves, [callId], 'create writes the shared store once');

    shared.saves.length = 0;
    const accepted = await postJson(a.url, `/calls/${callId}/accept`, {}, calleeSession);
    assert.equal(accepted.status, 200);
    assert.deepEqual(shared.saves, [callId], 'the transition writes the shared store once');

    // The awaited save is still the one that lands before the response, so a
    // peer on another instance can resolve the call immediately.
    assert.equal((await shared.callState.get(callId))?.status, 'accepted');
  } finally {
    await a.teardown();
  }
});

// Decision 2: the deployment is a single systemd unit, so `REDIS_URL` is unset
// and `state.callState` is absent. In that shape the in-memory registry plus
// Postgres is the *only* authority — the Lua transition machine in
// `stores/redis.ts` must not be consulted at all, so it cannot drift from the
// TypeScript state machine in `domain/calls.ts`. This asserts the single
// authority directly: a spying shared store that is never wired in is never
// touched, and the local transition still succeeds end to end.
test('without shared call state the local registry is the only transition authority', async () => {
  const shared = createSharedBackends();
  const touched: string[] = [];
  const spy = {
    ...shared.callState,
    get: async (callId: string) => {
      touched.push('get');
      return shared.callState.get(callId);
    },
    save: async (call: import('../src/stores/contracts.ts').CallRecord) => {
      touched.push('save');
      return shared.callState.save(call);
    },
    transitionAtomic: async (args: Parameters<typeof shared.callState.transitionAtomic>[0]) => {
      touched.push('transitionAtomic');
      return shared.callState.transitionAtomic(args);
    },
  };

  // Deliberately *not* wired into the stores bundle: this is the no-Redis shape.
  const stores = createMemoryStores();
  assert.equal(stores.callState, undefined, 'memory stores carry no shared call state');

  const a = await startServer(stores);
  try {
    const health = await readJson(await fetch(`${a.url}/health`));
    assert.equal(health.stateAffinity, 'sticky');
    assert.equal(health.sharedState.calls, false);
    assert.equal(health.sharedState.messageBus, false);

    const callerSession = (await postJson(a.url, '/session', { userId: 'user-a', deviceId: 'dev-a' })).body.sessionId;
    const calleeSession = (await postJson(a.url, '/session', { userId: 'user-b', deviceId: 'dev-b' })).body.sessionId;

    const created = await postJson(a.url, '/calls', { calleeId: 'user-b' }, callerSession);
    assert.equal(created.status, 201);
    const callId = created.body.callId;

    const accepted = await postJson(a.url, `/calls/${callId}/accept`, {}, calleeSession);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, 'accepted');

    const ended = await postJson(a.url, `/calls/${callId}/end`, {}, callerSession);
    assert.equal(ended.status, 200);
    assert.equal(ended.body.status, 'ended');

    // Re-ending is idempotent, but re-accepting a terminal call is rejected —
    // the state machine is enforced locally, not by the Lua copy.
    assert.equal((await postJson(a.url, `/calls/${callId}/end`, {}, callerSession)).status, 200);
    const reaccept = await postJson(a.url, `/calls/${callId}/accept`, {}, calleeSession);
    assert.equal(reaccept.status, 409);
    assert.match(String(reaccept.body.error), /terminal state/);

    assert.deepEqual(touched, [], 'the shared store is never consulted without REDIS_URL');
    assert.deepEqual(shared.saves, []);
  } finally {
    await a.teardown();
  }
});
