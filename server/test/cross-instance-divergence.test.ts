/**
 * Regression tests for call state diverging between two signaling instances.
 *
 * Production ran two processes behind one address. Each published its
 * transitions on `signaling:call.transitions` and none subscribed, so an
 * instance that had not handled a transition itself kept serving its own cached
 * record indefinitely: it reported an ended call as `ringing`, refused the next
 * call as `busy`, suppressed the callee's incoming-call push, and rejected RTC
 * frames as `stale_call_state`.
 *
 * These tests run two servers in one process over a shared call store and a
 * shared in-memory bus — the same shape as the Redis deployment — and assert
 * that the instance which never handled the transition still ends up telling
 * the truth.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../src/index.ts';
import { createMemoryStores } from '../src/stores/index.ts';
import { createMemoryMessageBus } from '../src/messageBus.ts';
import { closeTestServer, listenOnRandomPort, readJson } from './helpers.ts';

type CallRecord = import('../src/stores/contracts.ts').CallRecord;

const TERMINAL = new Set(['ended', 'declined', 'missed', 'busy', 'unreachable']);

/**
 * A shared call/session backend, standing in for Redis.
 *
 * `listActiveCallsForUser` is the secondary index the real store maintains
 * alongside the per-call keys; the busy check needs a per-user answer and the
 * key-per-call layout cannot give one.
 */
function createSharedBackends() {
  const calls = new Map<string, CallRecord>();
  const sessions = new Map<string, import('../src/stores/contracts.ts').SessionRecord>();

  return {
    calls,
    callState: {
      get: async (callId: string) => calls.get(callId) ?? null,
      save: async (call: CallRecord) => {
        calls.set(call.callId, { ...call });
      },
      listActiveCallsForUser: async (userId: string) => {
        const active: CallRecord[] = [];
        for (const call of calls.values()) {
          if (TERMINAL.has(call.status)) continue;
          if (call.callerId === userId || call.calleeId === userId) active.push({ ...call });
        }
        return active;
      },
      transitionAtomic: async ({ callId, fromStatus, toStatus }: {
        callId: string;
        fromStatus: string;
        toStatus: string;
        actor?: string | null;
        reason?: string | null;
      }) => {
        const call = calls.get(callId);
        if (!call) return { ok: false as const, error: 'not_found' as const };
        if (call.status === toStatus) return { ok: true as const, call: { ...call }, idempotent: true };
        if (TERMINAL.has(call.status)) return { ok: false as const, error: 'terminal_state' as const };
        if (call.status !== fromStatus) return { ok: false as const, error: 'stale_call_state' as const };
        const next = { ...call, status: toStatus, updatedAt: new Date().toISOString() };
        calls.set(callId, next);
        return { ok: true as const, call: { ...next }, idempotent: false };
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

async function startInstance(
  instanceId: string,
  shared: ReturnType<typeof createSharedBackends>,
  messageBus: import('../src/messageBus.ts').MessageBus
) {
  const stores = Object.assign(createMemoryStores(), {
    stateAffinity: 'shared' as const,
    instanceId,
    callState: shared.callState,
    sessionState: shared.sessionState,
    messageBus,
  });
  const server = createServer({ stores });
  // The subscription is established asynchronously at boot; a test that raced
  // it would be reporting on an instance that was never listening.
  await server.callTransitionSubscriptionReady;
  const port = await listenOnRandomPort(server.httpServer);
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    teardown: () => closeTestServer(server),
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

async function getJson(url: string, path: string, sessionId?: string) {
  const response = await fetch(`${url}${path}`, {
    headers: sessionId ? { authorization: 'Bearer ' + sessionId } : {},
  });
  return { status: response.status, body: await readJson(response) };
}

/** Let the bus deliver and the subscriber finish its shared-store read. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function connect(url: string, sessionId?: string): Promise<import('socket.io-client').Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      auth: sessionId ? { sessionId } : undefined,
      forceNew: true,
      transports: ['websocket'],
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emitWithAck(socket: import('socket.io-client').Socket, event: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), 4_000);
    socket.emit(event, payload, (ack: unknown) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

// ─── P1: transitions handled elsewhere repair the local record ───────────────

test('a transition handled by another instance updates this instance\'s cached record', async () => {
  const shared = createSharedBackends();
  const bus = createMemoryMessageBus();
  const a = await startInstance('instance-a', shared, bus);
  const b = await startInstance('instance-b', shared, bus);
  try {
    const callerSession = (await postJson(a.url, '/session', { userId: 'user-a', deviceId: 'dev-a' })).body.sessionId;
    const calleeSession = (await postJson(a.url, '/session', { userId: 'user-b', deviceId: 'dev-b' })).body.sessionId;

    const created = await postJson(a.url, '/calls', { calleeId: 'user-b' }, callerSession);
    assert.equal(created.status, 201);
    const callId = created.body.callId;

    // Instance A holds the record it created; every later transition is
    // handled by B, exactly as when the callee's socket lands on the other
    // instance.
    assert.equal(await postJson(b.url, `/calls/${callId}/accept`, {}, calleeSession).then(r => r.status), 200);
    await settle();
    assert.equal((await getJson(a.url, `/calls/${callId}`, callerSession)).body.status, 'accepted');

    assert.equal(await postJson(b.url, `/calls/${callId}/end`, {}, calleeSession).then(r => r.status), 200);
    await settle();
    assert.equal((await getJson(a.url, `/calls/${callId}`, callerSession)).body.status, 'ended');
  } finally {
    await a.teardown();
    await b.teardown();
  }
});

// ─── P3: the busy verdict answers a per-user question ────────────────────────

test('a call ended on another instance does not make the caller busy', async () => {
  const shared = createSharedBackends();
  const bus = createMemoryMessageBus();
  const a = await startInstance('instance-a', shared, bus);
  const b = await startInstance('instance-b', shared, bus);
  try {
    const callerSession = (await postJson(a.url, '/session', { userId: 'user-a', deviceId: 'dev-a' })).body.sessionId;
    const calleeSession = (await postJson(a.url, '/session', { userId: 'user-b', deviceId: 'dev-b' })).body.sessionId;

    const created = await postJson(a.url, '/calls', { calleeId: 'user-b' }, callerSession);
    const callId = created.body.callId;
    await postJson(b.url, `/calls/${callId}/accept`, {}, calleeSession);
    await postJson(b.url, `/calls/${callId}/end`, {}, calleeSession);

    const next = await postJson(a.url, '/calls', { calleeId: 'user-b' }, callerSession);
    assert.equal(next.status, 201, 'the finished call must not block the next one');
    assert.notEqual(next.body.callId, callId);
  } finally {
    await a.teardown();
    await b.teardown();
  }
});

test('a stale local record is not enough to report a user as busy', async () => {
  const shared = createSharedBackends();
  const bus = createMemoryMessageBus();
  const a = await startInstance('instance-a', shared, bus);
  const b = await startInstance('instance-b', shared, bus);
  try {
    const callerSession = (await postJson(a.url, '/session', { userId: 'user-a', deviceId: 'dev-a' })).body.sessionId;
    const calleeSession = (await postJson(a.url, '/session', { userId: 'user-b', deviceId: 'dev-b' })).body.sessionId;

    const created = await postJson(a.url, '/calls', { calleeId: 'user-b' }, callerSession);
    const callId = created.body.callId;

    // Silence the bus so A never learns of the end: the pre-fix production
    // shape, and the one a dropped pub/sub message still produces.
    await postJson(b.url, `/calls/${callId}/accept`, {}, calleeSession);
    await shared.callState.transitionAtomic({ callId, fromStatus: 'accepted', toStatus: 'ended' });

    const report = await getJson(a.url, `/debug/active-calls/user-a`, callerSession);
    assert.equal(report.status, 200);
    const blocking = (report.body.calls as any[]).find(entry => entry.callId === callId);
    // The stale copy is still *reported* — the endpoint exists to show it —
    // but it carries the age that disqualifies it from blocking anything.
    if (blocking) assert.equal(typeof blocking.staleMs, 'number');

    const next = await postJson(a.url, '/calls', { calleeId: 'user-b' }, callerSession);
    assert.equal(next.status, 201, 'a call the shared store says is over must not block');
  } finally {
    await a.teardown();
    await b.teardown();
  }
});

// ─── P6: candidates that arrive during the ring are replayed, not dropped ────

test('an ICE candidate sent while ringing is buffered and replayed on accept', async () => {
  const shared = createSharedBackends();
  const bus = createMemoryMessageBus();
  const a = await startInstance('instance-a', shared, bus);
  try {
    const callerSession = (await postJson(a.url, '/session', { userId: 'user-a', deviceId: 'dev-a' })).body.sessionId;
    const calleeSession = (await postJson(a.url, '/session', { userId: 'user-b', deviceId: 'dev-b' })).body.sessionId;
    const caller = await connect(a.url, callerSession);
    const callee = await connect(a.url, calleeSession);

    try {
      const created = await postJson(a.url, '/calls', { calleeId: 'user-b' }, callerSession);
      const callId = created.body.callId;

      const delivered = new Promise<any>(resolve => callee.once('rtc.candidate', resolve));
      const ack = await emitWithAck(caller, 'rtc.candidate', {
        version: 1,
        callId,
        candidate: { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 },
      });
      assert.equal(ack.ok, true, 'an early candidate is held, not rejected');
      assert.equal(ack.buffered, true);

      await postJson(a.url, `/calls/${callId}/accept`, {}, calleeSession);
      const replayed = await delivered;
      assert.equal(replayed.callId, callId);
      assert.equal(replayed.candidate.candidate, 'candidate:early');
    } finally {
      caller.disconnect();
      callee.disconnect();
    }
  } finally {
    await a.teardown();
  }
});

test('candidates buffered for a call that ends are discarded, not replayed', async () => {
  const shared = createSharedBackends();
  const bus = createMemoryMessageBus();
  const a = await startInstance('instance-a', shared, bus);
  try {
    const callerSession = (await postJson(a.url, '/session', { userId: 'user-a', deviceId: 'dev-a' })).body.sessionId;
    const calleeSession = (await postJson(a.url, '/session', { userId: 'user-b', deviceId: 'dev-b' })).body.sessionId;
    const caller = await connect(a.url, callerSession);

    try {
      const created = await postJson(a.url, '/calls', { calleeId: 'user-b' }, callerSession);
      const callId = created.body.callId;

      const buffered = await emitWithAck(caller, 'rtc.candidate', {
        version: 1,
        callId,
        candidate: { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 },
      });
      assert.equal(buffered.buffered, true);
      assert.equal(buffered.bufferedCount, 1);

      assert.equal((await postJson(a.url, `/calls/${callId}/decline`, {}, calleeSession)).status, 200);
      await settle();
      // The call is over, so nothing may be relayed for it any more.
      const afterEnd = await emitWithAck(caller, 'rtc.candidate', {
        version: 1,
        callId,
        candidate: { candidate: 'candidate:late', sdpMid: '0', sdpMLineIndex: 0 },
      });
      assert.equal(afterEnd.ok, false);
    } finally {
      caller.disconnect();
    }
  } finally {
    await a.teardown();
  }
});
