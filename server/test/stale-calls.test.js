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
const { DEFAULT_MEDIA_CONNECT_TIMEOUT_MS } = require('../src/config.js');
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
