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

  return {
    callState: {
      get: async (callId: string) => calls.get(callId) ?? null,
      save: async (call: import('../src/stores/contracts.ts').CallRecord) => {
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
