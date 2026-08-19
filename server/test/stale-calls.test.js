'use strict';

/**
 * Regression tests for calls stranded in a non-terminal state.
 *
 * A call that reached `accepted` / `connecting_media` and then lost both peers
 * used to stay non-terminal forever: it was persisted, rehydrated on every
 * restart, and permanently made both participants `busy`, so no new call could
 * ever ring again.  Every state must therefore be finite, and a restart must
 * never resurrect a dead call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/index.js');
const {
  CALL_TRANSITIONS,
  CONNECTED_CALL_STATUS,
  DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_MEDIA_CONNECT_TIMEOUT_MS,
  TERMINAL_CALL_STATES,
} = require('../src/config.js');
const { getCallExpiry } = require('../src/domain/calls.js');
const { captureConsoleLog } = require('./helpers');
const schema = require('../db/schema');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startServer(opts) {
  const server = createServer(opts);
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  const url = `http://127.0.0.1:${port}`;

  async function teardown(...clients) {
    clients.forEach((client) => client.disconnect());
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

async function getJson(url, path, sessionId, headers = {}) {
  const pathname = sessionId
    ? `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(sessionId)}`
    : path;
  const response = await fetch(`${url}${pathname}`, { headers });
  return { status: response.status, body: await response.json() };
}

async function createSession(url, userId, deviceId = `device-${userId}`) {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

function connect(url, auth) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { auth, forceNew: true, transports: ['websocket'] });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ack of "${event}"`)), 1500);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function waitFor(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve on the first `call.state_changed` carrying `status`. */
function waitForStatus(socket, status, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for status "${status}"`)),
      timeoutMs
    );
    socket.on('call.state_changed', (payload) => {
      if (payload?.status !== status) return;
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Drive a call through to `connecting_media` over HTTP + sockets. */
async function startConnectingMediaCall(url, callerSession, calleeSession) {
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
    assert.equal(call.status, 'ended');
    assert.equal(call.endReason, 'media_connect_timeout');

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
    assert.equal(getCall(callId).status, 'connecting_media');

    assert.equal(tickRingingTimeouts(Date.now() + DEFAULT_MEDIA_CONNECT_TIMEOUT_MS - 1_000), 0);
    assert.equal(getCall(callId).status, 'connecting_media');

    assert.equal(tickRingingTimeouts(Date.now() + DEFAULT_MEDIA_CONNECT_TIMEOUT_MS + 1_000), 1);
    assert.equal(getCall(callId).status, 'ended');
    assert.equal(getCall(callId).endReason, 'media_connect_timeout');
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
    assert.equal(getCall(callId).status, 'accepted');

    callee.disconnect();
    await sleep(120);

    const call = getCall(callId);
    assert.equal(call.status, 'ended');
    assert.equal(call.endReason, 'participant_disconnected');
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
  const db = {
    select() {
      return {
        from(table) {
          return Promise.resolve(table === schema.calls ? callRows : []);
        },
      };
    },
    insert() {
      return {
        values() {
          return {
            then: (resolve, reject) => Promise.resolve().then(resolve, reject),
            catch: (reject) => Promise.resolve().catch(reject),
            onConflictDoUpdate: () => Promise.resolve(),
            onConflictDoNothing: () => Promise.resolve(),
          };
        },
      };
    },
  };

  const { url, getCall, loadPersistedState, teardown } = await startServer({ db });
  try {
    await loadPersistedState();

    const stale = getCall(staleCallId);
    assert.equal(stale.status, 'ended');
    assert.equal(stale.endReason, 'stale_cleanup');

    // A call that was mid-setup moments before the restart is still legitimate.
    assert.equal(getCall(freshCallId).status, 'connecting_media');

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
    assert.equal(call.status, 'ended');
    assert.equal(call.endReason, 'client_state_reconciled');
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
    assert.equal(getCall(callId).status, 'accepted');
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
    assert.equal(getCall(callId).status, 'connecting_media');

    const stateChanged = waitForStatus(callee, CONNECTED_CALL_STATUS);
    const ack = await emitWithAck(caller, 'call.connected', {
      version: 1,
      callId,
      iceState: 'connected',
    });
    assert.equal(ack.ok, true);
    assert.equal(getCall(callId).status, CONNECTED_CALL_STATUS);
    assert.equal((await stateChanged).status, CONNECTED_CALL_STATUS);

    // The peer reports too; the second report is absorbed, not rejected.
    const second = await emitWithAck(callee, 'call.connected', {
      version: 1,
      callId,
      iceState: 'completed',
    });
    assert.equal(second.ok, true);
    assert.equal(getCall(callId).status, CONNECTED_CALL_STATUS);
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
    assert.equal(getCall(callId).status, CONNECTED_CALL_STATUS);

    // Well past the media-connect window: a healthy call must stay up.
    assert.equal(tickRingingTimeouts(Date.now() + DEFAULT_MEDIA_CONNECT_TIMEOUT_MS + 30_000), 0);
    assert.equal(getCall(callId).status, CONNECTED_CALL_STATUS);

    // …and when it does eventually expire it is because the device stopped
    // reporting liveness, never because media "failed to connect".
    assert.equal(tickRingingTimeouts(Date.now() + DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS + 5_000), 1);
    assert.equal(getCall(callId).endReason, 'heartbeat_timeout');
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
    assert.equal(call.status, 'ended');
    assert.equal(call.endReason, 'media_failed');
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
    assert.equal(getCall(callId).status, CONNECTED_CALL_STATUS);

    // Once the beats stop, the abandoned call is closed out long before the
    // absolute duration cap would have fired.
    assert.equal(tickRingingTimeouts(Date.now() + DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS + 5_000), 1);
    assert.equal(getCall(callId).endReason, 'heartbeat_timeout');
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
      { status, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      {}
    );
    assert.ok(expiry, `status "${status}" has no timeout and could stay active forever`);
    assert.ok(TERMINAL_CALL_STATES.has(expiry.status));
  }
});

test('guard: the connected steady state is never subject to the media-connect timeout', () => {
  const now = Date.now();
  const call = {
    status: CONNECTED_CALL_STATUS,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  const expiry = getCallExpiry(call, {});
  assert.notEqual(expiry.reason, 'media_connect_timeout');
  assert.ok(
    expiry.deadlineMs - now > DEFAULT_MEDIA_CONNECT_TIMEOUT_MS,
    'a connected call must outlive the media-connect window by a wide margin'
  );

  // Only a status that is still setting up media may carry that reason.
  for (const status of ['accepted', 'connecting_media']) {
    assert.equal(getCallExpiry({ ...call, status }, {}).reason, 'media_connect_timeout');
  }
});
