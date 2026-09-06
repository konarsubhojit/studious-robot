/**
 * Regression tests for calls stranded in a non-terminal state.
 *
 * A call that reached `accepted` / `connecting_media` and then lost both peers
 * used to stay non-terminal forever: it was persisted, rehydrated on every
 * restart, and permanently made both participants `busy`, so no new call could
 * ever ring again.  Every state must therefore be finite, and a restart must
 * never resurrect a dead call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../src/index.ts';
import { CALL_TRANSITIONS, CONNECTED_CALL_STATUS, DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS, DEFAULT_MEDIA_CONNECT_TIMEOUT_MS, TERMINAL_CALL_STATES } from '../src/config.ts';
import { getCallExpiry } from '../src/domain/calls.ts';
import * as schema from '../db/schema.ts';
import { asDatabase, captureConsoleLog, closeTestServer, listenOnRandomPort, postJson, readJson } from './helpers.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the minimal call shape the timeout helpers read, typed as a full
 * record so the guard tests can exercise them without a live call.
 */
function callFixture(fields: { status: string; createdAt: string; updatedAt: string; }): import('../src/stores/contracts.ts').CallRecord {
  return (fields as any);
}

async function startServer(opts?: import('../src/createServer.ts').CreateServerOptions) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  /** @param clients */
  async function teardown(...clients: (import('socket.io-client').Socket | undefined)[]) {
    clients.forEach((client) => client?.disconnect());
    await closeTestServer(server);
  }

  return { ...server, url, teardown };
}

/**
 * @param url - Base URL of the server under test.
 * @param path - Request path, including the leading slash.
 * @param sessionId - Sent as `Authorization: Bearer <id>` when present.
 */
async function getJson(url: string, path: string, sessionId?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; }> {
  const response = await fetch(`${url}${path}`, {
    headers: { ...headers, ...(sessionId ? { authorization: `Bearer ${sessionId}` } : {}) },
  });
  return { status: response.status, body: await readJson(response) };
}

/**
 * @param url - Base URL of the server under test.
 * @returns the created session id
 */
async function createSession(url: string, userId: string, deviceId: string = `device-${userId}`): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

/**
 * @param auth - Socket.IO handshake auth payload.
 */
function connect(url: string, auth?: Record<string, unknown>): Promise<import('socket.io-client').Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { auth, forceNew: true, transports: ['websocket'] });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

/**
 * @returns the server's acknowledgement
 */
function emitWithAck(socket: import('socket.io-client').Socket, event: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ack of "${event}"`)), 1500);
    socket.emit(event, payload, (ack: any) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function waitFor(socket: import('socket.io-client').Socket, event: string, timeoutMs: number = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** @param ms */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve on the first `call.state_changed` carrying `status`.
 */
function waitForStatus(socket: import('socket.io-client').Socket, status: string, timeoutMs: number = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for status "${status}"`)),
      timeoutMs
    );
    socket.on('call.state_changed', (payload: any) => {
      if (payload?.status !== status) return;
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * Drive a call through to `connecting_media` over HTTP + sockets.
 *
 * @param url - Base URL of the server under test.
 * @returns the created call id
 */
async function startConnectingMediaCall(url: string, callerSession: string, calleeSession: string): Promise<string> {
  const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
  const callId = created.body.callId;
  assert.equal(created.body.status, 'ringing');
  await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
  return callId;
}

// ─── 1. Stale-state sweep ────────────────────────────────────────────────────

test('sweep: an accepted call that never connects media is ended, not left active', async () => {
  const { url, getCall, tickRingingTimeouts, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');
    const callId = await startConnectingMediaCall(url, callerSession, calleeSession);

    const transitioned = tickRingingTimeouts(Date.now() + DEFAULT_MEDIA_CONNECT_TIMEOUT_MS + 1_000);
    assert.equal(transitioned, 1);

    const call = getCall(callId);
    assert.equal(call?.status, 'ended');
    assert.equal(call?.endReason, 'media_connect_timeout');

    // …and the participants are free to call each other again.
    const next = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    assert.equal(next.body.status, 'ringing');
  } finally {
    await teardown();
  }
});

test('sweep: a call still inside the media-connect window is left alone', async () => {
  const { url, getCall, tickRingingTimeouts, teardown } = await startServer();
  let caller;
  let callee;
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');
    caller = await connect(url, { sessionId: callerSession });
    callee = await connect(url, { sessionId: calleeSession });

    const callId = await startConnectingMediaCall(url, callerSession, calleeSession);
    await emitWithAck(caller, 'rtc.offer', { version: 1, callId, sdp: { type: 'offer', sdp: 'x' } });
    assert.equal(getCall(callId)?.status, 'connecting_media');

    assert.equal(tickRingingTimeouts(Date.now() + DEFAULT_MEDIA_CONNECT_TIMEOUT_MS - 1_000), 0);
    assert.equal(getCall(callId)?.status, 'connecting_media');

    assert.equal(tickRingingTimeouts(Date.now() + DEFAULT_MEDIA_CONNECT_TIMEOUT_MS + 1_000), 1);
    assert.equal(getCall(callId)?.status, 'ended');
    assert.equal(getCall(callId)?.endReason, 'media_connect_timeout');
  } finally {
    await teardown(caller, callee);
  }
});

// ─── 2. Participant-disconnect cleanup ───────────────────────────────────────

test('disconnect: an in-progress call ends once both participants lose their sockets', async () => {
  const { url, getCall, teardown } = await startServer({ participantDisconnectGraceMs: 20 });
  let caller;
  let callee;
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');
    caller = await connect(url, { sessionId: callerSession });
    callee = await connect(url, { sessionId: calleeSession });

    const callId = await startConnectingMediaCall(url, callerSession, calleeSession);

    caller.disconnect();
    await sleep(60);
    // The callee is still connected: the call must survive the caller's drop.
    assert.equal(getCall(callId)?.status, 'accepted');

    callee.disconnect();
    await sleep(120);

    const call = getCall(callId);
    assert.equal(call?.status, 'ended');
    assert.equal(call?.endReason, 'participant_disconnected');
  } finally {
    await teardown();
  }
});

// ─── 3. Hydration sanitization ───────────────────────────────────────────────

test('hydration: a stale non-terminal call from the DB is closed, not restored as active', async () => {
  const staleCallId = '00000000-0000-4000-8000-0000000000aa';
  const freshCallId = '00000000-0000-4000-8000-0000000000bb';
  const callRows = [
    {
      callId: staleCallId,
      callerId: 'user-zen',
      calleeId: 'user-nez',
      status: 'connecting_media',
      endReason: null,
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      ringTimeoutAt: null,
    },
    {
      callId: freshCallId,
      callerId: 'user-zen',
      calleeId: 'user-nez',
      status: 'connecting_media',
      endReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ringTimeoutAt: null,
    },
  ];
  const db = asDatabase({
    select() {
      return {
        /** @param table */
        from(table: unknown) {
          const rows = table === schema.calls ? callRows : [];
          // Hydration narrows its reads (`.where()` on events, `.orderBy()` /
          // `.limit()` on calls), so the double is chainable as well as
          // awaitable.
          const chain: any = {
            where: () => chain,
            orderBy: () => chain,
            limit: () => chain,
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
          return chain;
        },
      };
    },
    insert() {
      return {
        values() {
          return {
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve().then(resolve, reject),
            /** @param reject */
            catch: (reject: (reason: unknown) => unknown) => Promise.resolve().catch(reject),
            onConflictDoUpdate: () => Promise.resolve(),
            onConflictDoNothing: () => Promise.resolve(),
          };
        },
      };
    },
  });

  const { url, getCall, loadPersistedState, teardown } = await startServer({ db });
  try {
    await loadPersistedState();

    const stale = getCall(staleCallId);
    assert.equal(stale?.status, 'ended');
    assert.equal(stale?.endReason, 'stale_cleanup');

    // A call that was mid-setup moments before the restart is still legitimate.
    assert.equal(getCall(freshCallId)?.status, 'connecting_media');

    // The stale record must not make its participants busy any more.
    const zenSession = await createSession(url, 'user-zen');
    await createSession(url, 'user-carol');
    const created = await postJson(url, '/calls', { calleeId: 'user-carol' }, zenSession);
    assert.equal(created.body.status, 'ringing');
  } finally {
    await teardown();
  }
});

// ─── 4. Cancelling an outgoing call frees the caller ─────────────────────────

test('cancel: a cancelled outgoing call does not leave the caller busy', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');
    const bobSession = await createSession(url, 'user-bob', 'device-bob-2');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const cancelled = await postJson(url, `/calls/${created.body.callId}/cancel`, {}, callerSession);
    assert.equal(cancelled.body.status, 'ended');

    // Both directions must ring again immediately after the cancellation.
    const retry = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    assert.equal(retry.body.status, 'ringing');
    await postJson(url, `/calls/${retry.body.callId}/cancel`, {}, callerSession);

    const reverse = await postJson(url, '/calls', { calleeId: 'user-alice' }, bobSession);
    assert.equal(reverse.body.status, 'ringing');
  } finally {
    await teardown();
  }
});

// ─── 5. Diagnosing busy ──────────────────────────────────────────────────────

test('busy: the log names the blocking call, its status and its age', async () => {
  const { url, teardown } = await startServer();
  const log = captureConsoleLog();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const carolSession = await createSession(url, 'user-carol');
    await createSession(url, 'user-bob');

    const blocking = await postJson(url, '/calls', { calleeId: 'user-bob' }, carolSession);
    const busy = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(busy.body.status, 'busy');

    const skipLine = log.lines.find(
      (line) => line.includes(busy.body.callId) && line.includes('reason=call_status_busy')
    );
    assert.ok(skipLine, 'busy rejection should be logged');
    assert.ok(
      skipLine.includes(`blockedBy=${blocking.body.callId}:ringing:`),
      `expected blocking call in: ${skipLine}`
    );
  } finally {
    log.restore();
    await teardown();
  }
});

test('GET /debug/active-calls/:userId lists what is holding a user busy', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);

    const res = await getJson(url, '/debug/active-calls/user-bob', calleeSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.activeCalls[0].callId, created.body.callId);
    assert.equal(res.body.activeCalls[0].status, 'ringing');
    assert.equal(typeof res.body.activeCalls[0].ageMs, 'number');

    // Sessions may only inspect themselves, and anonymous callers not at all.
    const forbidden = await getJson(url, '/debug/active-calls/user-bob', callerSession);
    assert.equal(forbidden.status, 403);
    const unauthorized = await getJson(url, '/debug/active-calls/user-bob');
    assert.equal(unauthorized.status, 401);
  } finally {
    await teardown();
  }
});

// ─── 6. Client self-heal ─────────────────────────────────────────────────────

test('call.state.report: a client with no active call clears its phantom calls', async () => {
  const { url, getCall, teardown } = await startServer();
  let caller;
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');
    caller = await connect(url, { sessionId: callerSession });

    const callId = await startConnectingMediaCall(url, callerSession, calleeSession);
    const stateChanged = waitFor(caller, 'call.state_changed');

    const ack = await emitWithAck(caller, 'call.state.report', { version: 1, activeCallIds: [] });
    assert.equal(ack.ok, true);
    assert.deepEqual(ack.clearedCallIds, [callId]);
    assert.equal(ack.activeCalls.length, 0);

    const call = getCall(callId);
    assert.equal(call?.status, 'ended');
    assert.equal(call?.endReason, 'client_state_reconciled');
    assert.equal((await stateChanged).status, 'ended');

    // The caller can immediately place a new call.
    const retry = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    assert.equal(retry.body.status, 'ringing');
  } finally {
    await teardown(caller);
  }
});

test('call.state.report: a call the client still holds is left untouched', async () => {
  const { url, getCall, teardown } = await startServer();
  let caller;
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');
    caller = await connect(url, { sessionId: callerSession });

    const callId = await startConnectingMediaCall(url, callerSession, calleeSession);

    const ack = await emitWithAck(caller, 'call.state.report', {
      version: 1,
      activeCallIds: [callId],
    });
    assert.equal(ack.ok, true);
    assert.deepEqual(ack.clearedCallIds, []);
    assert.equal(getCall(callId)?.status, 'accepted');
  } finally {
    await teardown(caller);
  }
});

// ─── 5. call.connected: the transition that makes a call survive the sweep ───

test('call.connected: media reaching the connected ICE state advances the call', async () => {
  const { url, getCall, teardown } = await startServer();
  let caller;
  let callee;
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');
    caller = await connect(url, { sessionId: callerSession });
    callee = await connect(url, { sessionId: calleeSession });

    const callId = await startConnectingMediaCall(url, callerSession, calleeSession);
    await emitWithAck(caller, 'rtc.offer', { version: 1, callId, sdp: { type: 'offer', sdp: 'x' } });
    assert.equal(getCall(callId)?.status, 'connecting_media');

    const stateChanged = waitForStatus(callee, CONNECTED_CALL_STATUS);
    const ack = await emitWithAck(caller, 'call.connected', {
      version: 1,
      callId,
      iceState: 'connected',
    });
    assert.equal(ack.ok, true);
    assert.equal(getCall(callId)?.status, CONNECTED_CALL_STATUS);
    assert.equal((await stateChanged).status, CONNECTED_CALL_STATUS);

    // The peer reports too; the second report is absorbed, not rejected.
    const second = await emitWithAck(callee, 'call.connected', {
      version: 1,
      callId,
      iceState: 'completed',
    });
    assert.equal(second.ok, true);
    assert.equal(getCall(callId)?.status, CONNECTED_CALL_STATUS);
  } finally {
    await teardown(caller, callee);
  }
});

test('sweep: a connected call is never ended by the media-connect timeout', async () => {
  const { url, getCall, tickRingingTimeouts, teardown } = await startServer();
  let caller;
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');
    caller = await connect(url, { sessionId: callerSession });

    const callId = await startConnectingMediaCall(url, callerSession, calleeSession);
    await emitWithAck(caller, 'rtc.offer', { version: 1, callId, sdp: { type: 'offer', sdp: 'x' } });
    await emitWithAck(caller, 'call.connected', { version: 1, callId, iceState: 'connected' });
    assert.equal(getCall(callId)?.status, CONNECTED_CALL_STATUS);

    // Well past the media-connect window: a healthy call must stay up.
    assert.equal(tickRingingTimeouts(Date.now() + DEFAULT_MEDIA_CONNECT_TIMEOUT_MS + 30_000), 0);
    assert.equal(getCall(callId)?.status, CONNECTED_CALL_STATUS);

    // …and when it does eventually expire it is because the device stopped
    // reporting liveness, never because media "failed to connect".
    assert.equal(tickRingingTimeouts(Date.now() + DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS + 5_000), 1);
    assert.equal(getCall(callId)?.endReason, 'heartbeat_timeout');
  } finally {
    await teardown(caller);
  }
});

test('call.connected: an unrecovered ICE failure ends the call without waiting for a sweep', async () => {
  const { url, getCall, teardown } = await startServer();
  let caller;
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');
    caller = await connect(url, { sessionId: callerSession });

    const callId = await startConnectingMediaCall(url, callerSession, calleeSession);
    const ack = await emitWithAck(caller, 'call.connected', {
      version: 1,
      callId,
      iceState: 'failed',
    });
    assert.equal(ack.ok, true);

    const call = getCall(callId);
    assert.equal(call?.status, 'ended');
    assert.equal(call?.endReason, 'media_failed');
  } finally {
    await teardown(caller);
  }
});

test('call.connected: each report is resolved from its own payload, not a shared binding', async () => {
  // `iceState` used to be smuggled from `resolveTransition` to `onSuccess`
  // through a mutable binding in the enclosing module scope. Two interleaved
  // reports shared that binding, so the value one call logged could be the one
  // the other call reported. It now travels on the `CallTransition` itself.
  const { url, getCall, teardown } = await startServer({ callRateLimit: 100 });
  let caller;
  let carol;
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');
    const carolSession = await createSession(url, 'user-carol');
    const daveSession = await createSession(url, 'user-dave');
    caller = await connect(url, { sessionId: callerSession });
    carol = await connect(url, { sessionId: carolSession });

    const healthyId = await startConnectingMediaCall(url, callerSession, calleeSession);
    const created = await postJson(url, '/calls', { calleeId: 'user-dave' }, carolSession);
    const failingId = created.body.callId;
    await postJson(url, `/calls/${failingId}/accept`, {}, daveSession);

    // Interleaved: the failing report is resolved between the healthy one being
    // resolved and its outcome being recorded, as far as the event loop allows.
    const [healthyAck, failingAck] = await Promise.all([
      emitWithAck(caller, 'call.connected', { version: 1, callId: healthyId, iceState: 'connected' }),
      emitWithAck(carol, 'call.connected', { version: 1, callId: failingId, iceState: 'disconnected' }),
    ]);
    assert.equal(healthyAck.ok, true);
    assert.equal(failingAck.ok, true);

    assert.equal(getCall(healthyId)?.status, CONNECTED_CALL_STATUS);
    assert.equal(getCall(healthyId)?.endReason, null);
    assert.equal(getCall(failingId)?.status, 'ended');
    assert.equal(getCall(failingId)?.endReason, 'media_failed');
  } finally {
    await teardown(caller, carol);
  }
});

test('call.connected: an unvalidated iceState never picks the destination status', async () => {
  const { url, getCall, teardown } = await startServer();
  let caller;
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');
    caller = await connect(url, { sessionId: callerSession });

    const callId = await startConnectingMediaCall(url, callerSession, calleeSession);
    // `failed` is spelled in a way the schema rejects. The handler resolves the
    // transition from the parsed payload, so this is refused outright rather
    // than being read as a failure and ending the call.
    const ack = await emitWithAck(caller, 'call.connected', {
      version: 1,
      callId,
      iceState: ['failed'],
    });
    assert.equal(ack.ok, false);
    assert.equal(getCall(callId)?.status, 'accepted');
  } finally {
    await teardown(caller);
  }
});

test('heartbeat: a connected call is aged out only once its liveness reports stop', async () => {
  const { url, getCall, tickRingingTimeouts, teardown } = await startServer();
  let caller;
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');
    caller = await connect(url, { sessionId: callerSession });

    const callId = await startConnectingMediaCall(url, callerSession, calleeSession);
    await emitWithAck(caller, 'call.connected', { version: 1, callId, iceState: 'connected' });

    // A heartbeat that is still fresh keeps the call alive.
    await emitWithAck(caller, 'call.media-state', {
      version: 1,
      callId,
      mediaState: { isScreenSharing: false, heartbeat: true },
    });
    assert.equal(tickRingingTimeouts(Date.now() + DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS - 5_000), 0);
    assert.equal(getCall(callId)?.status, CONNECTED_CALL_STATUS);

    // Once the beats stop, the abandoned call is closed out long before the
    // absolute duration cap would have fired.
    assert.equal(tickRingingTimeouts(Date.now() + DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS + 5_000), 1);
    assert.equal(getCall(callId)?.endReason, 'heartbeat_timeout');
  } finally {
    await teardown(caller);
  }
});

test('heartbeat: only an explicit liveness report refreshes a connected call', async () => {
  const { url, getCall, teardown } = await startServer();
  let caller;
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');
    caller = await connect(url, { sessionId: callerSession });

    const callId = await startConnectingMediaCall(url, callerSession, calleeSession);
    await emitWithAck(caller, 'call.connected', { version: 1, callId, iceState: 'connected' });
    const stampedAt = getCall(callId)?.lastHeartbeatAt;
    assert.ok(stampedAt, 'call.connected must stamp the first liveness report');

    // A client that predates the heartbeat still emits `call.media-state` when
    // screen sharing is toggled. Those frames must not be mistaken for
    // liveness, or an abandoned call is kept alive by a stray UI toggle.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await emitWithAck(caller, 'call.media-state', {
      version: 1,
      callId,
      mediaState: { isScreenSharing: true },
    });
    assert.equal(getCall(callId)?.lastHeartbeatAt, stampedAt);

    await emitWithAck(caller, 'call.media-state', {
      version: 1,
      callId,
      mediaState: { isScreenSharing: true, heartbeat: true },
    });
    assert.notEqual(getCall(callId)?.lastHeartbeatAt, stampedAt);
  } finally {
    await teardown(caller);
  }
});

// ─── 6. State-machine regression guard ───────────────────────────────────────

test('guard: every non-terminal status has a forward transition and a bounded timeout', () => {
  for (const [status, nextStates] of CALL_TRANSITIONS) {
    assert.ok(
      [...nextStates].some((next) => !TERMINAL_CALL_STATES.has(next)) ||
        status === CONNECTED_CALL_STATUS,
      `status "${status}" has no forward (non-terminal) transition, so it can only ever time out`
    );

    const expiry = getCallExpiry(
      callFixture({
        status,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      {}
    );
    assert.ok(expiry, `status "${status}" has no timeout and could stay active forever`);
    assert.ok(TERMINAL_CALL_STATES.has(expiry.status));
  }
});

test('guard: the connected steady state is never subject to the media-connect timeout', () => {
  const now = Date.now();
  const call = callFixture({
    status: CONNECTED_CALL_STATUS,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  const expiry = getCallExpiry(call, {});
  assert.notEqual(expiry?.reason, 'media_connect_timeout');
  assert.ok(
    (expiry?.deadlineMs ?? 0) - now > DEFAULT_MEDIA_CONNECT_TIMEOUT_MS,
    'a connected call must outlive the media-connect window by a wide margin'
  );

  // Only a status that is still setting up media may carry that reason.
  for (const status of ['accepted', 'connecting_media']) {
    assert.equal(getCallExpiry({ ...call, status }, {})?.reason, 'media_connect_timeout');
  }
});
