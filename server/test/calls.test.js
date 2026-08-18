'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, CALL_END_REASONS } = require('../src/index.js');
const { DEFAULT_RINGING_TIMEOUT_MS } = require('../src/config.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startServer() {
  const server = createServer();
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

async function getJson(url, path, sessionId) {
  const pathname = sessionId
    ? `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(sessionId)}`
    : path;
  const response = await fetch(`${url}${pathname}`);
  return { status: response.status, body: await response.json() };
}

/** Create a session for a given userId, returning the sessionId. */
async function createSession(url, userId, deviceId = `device-${userId}`) {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

// ─── POST /calls – initiate ───────────────────────────────────────────────────

test('initiate: caller gets a ringing call record', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob'); // register callee so they're known

    const res = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    assert.equal(res.status, 201);
    const call = res.body;

    assert.equal(typeof call.callId, 'string');
    assert.equal(call.callerId, 'user-alice');
    assert.equal(call.calleeId, 'user-bob');
    assert.equal(call.status, 'ringing');
    assert.equal(call.endReason, null);
    assert.equal(typeof call.createdAt, 'string');
    assert.equal(typeof call.ringTimeoutAt, 'string');
  } finally {
    await teardown();
  }
});

test('initiate: requires a valid session', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await postJson(url, '/calls', { calleeId: 'user-bob' }, 'bad-session');
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

test('initiate: rejects missing calleeId', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const res = await postJson(url, '/calls', {}, callerSession);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'calleeId is required');
  } finally {
    await teardown();
  }
});

test('initiate: rejects self-call', async () => {
  const { url, teardown } = await startServer();
  try {
    const session = await createSession(url, 'user-alice');
    const res = await postJson(url, '/calls', { calleeId: 'user-alice' }, session);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'cannot call yourself');
  } finally {
    await teardown();
  }
});

test('initiate: resolves to busy when callee already has an active call', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const carolSession = await createSession(url, 'user-carol');
    await createSession(url, 'user-bob');

    // Carol starts a call to Bob → Bob is now busy.
    const firstCall = await postJson(url, '/calls', { calleeId: 'user-bob' }, carolSession);
    assert.equal(firstCall.body.status, 'ringing');

    // Alice tries to call Bob → should immediately resolve to busy.
    const busyCall = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(busyCall.status, 201);
    assert.equal(busyCall.body.status, 'busy');
    assert.equal(busyCall.body.endReason, 'busy');
    assert.equal(busyCall.body.ringTimeoutAt, null);
  } finally {
    await teardown();
  }
});

test('initiate: resolves to unreachable when callee is completely unknown', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');

    // 'user-ghost' has never interacted with the server.
    const res = await postJson(url, '/calls', { calleeId: 'user-ghost' }, callerSession);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'unreachable');
    assert.equal(res.body.endReason, 'unreachable');
    assert.equal(res.body.ringTimeoutAt, null);
  } finally {
    await teardown();
  }
});

// ─── GET /calls/:callId ───────────────────────────────────────────────────────

test('get: caller and callee can both fetch the call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    const fromCaller = await getJson(url, `/calls/${callId}`, callerSession);
    assert.equal(fromCaller.status, 200);
    assert.equal(fromCaller.body.callId, callId);

    const fromCallee = await getJson(url, `/calls/${callId}`, calleeSession);
    assert.equal(fromCallee.status, 200);
    assert.equal(fromCallee.body.callId, callId);
  } finally {
    await teardown();
  }
});

test('get: third party cannot view the call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');
    const thirdSession = await createSession(url, 'user-carol');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    const res = await getJson(url, `/calls/${callId}`, thirdSession);
    assert.equal(res.status, 403);
  } finally {
    await teardown();
  }
});

test('get: returns 404 for unknown callId', async () => {
  const { url, teardown } = await startServer();
  try {
    const session = await createSession(url, 'user-alice');
    const res = await getJson(url, '/calls/no-such-call', session);
    assert.equal(res.status, 404);
  } finally {
    await teardown();
  }
});

// ─── POST /calls/:callId/accept ───────────────────────────────────────────────

test('accept: callee can accept a ringing call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    const res = await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'accepted');
    assert.equal(res.body.endReason, null);
  } finally {
    await teardown();
  }
});

test('accept: idempotent – accepting an already-accepted call returns 200', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
    const res = await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'accepted');
  } finally {
    await teardown();
  }
});

test('accept: caller cannot accept their own call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const res = await postJson(url, `/calls/${created.body.callId}/accept`, {}, callerSession);
    assert.equal(res.status, 403);
  } finally {
    await teardown();
  }
});

test('accept: cannot accept a terminal-state call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    // Callee declines first.
    await postJson(url, `/calls/${callId}/decline`, {}, calleeSession);
    // Trying to accept afterwards must be rejected.
    const res = await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
    assert.equal(res.status, 409);
  } finally {
    await teardown();
  }
});

// ─── POST /calls/:callId/decline ─────────────────────────────────────────────

test('decline: callee can decline a ringing call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const res = await postJson(url, `/calls/${created.body.callId}/decline`, {}, calleeSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'declined');
    assert.equal(res.body.endReason, 'declined');
  } finally {
    await teardown();
  }
});

test('decline: idempotent – declining an already-declined call returns 200', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    await postJson(url, `/calls/${callId}/decline`, {}, calleeSession);
    const res = await postJson(url, `/calls/${callId}/decline`, {}, calleeSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'declined');
  } finally {
    await teardown();
  }
});

test('decline: caller cannot decline their own outbound call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const res = await postJson(url, `/calls/${created.body.callId}/decline`, {}, callerSession);
    assert.equal(res.status, 403);
  } finally {
    await teardown();
  }
});

// ─── POST /calls/:callId/cancel ───────────────────────────────────────────────

test('cancel: caller can cancel a ringing call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const res = await postJson(url, `/calls/${created.body.callId}/cancel`, {}, callerSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ended');
    assert.equal(res.body.endReason, 'cancelled');
  } finally {
    await teardown();
  }
});

test('cancel: callee cannot cancel a call (only caller can)', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const res = await postJson(url, `/calls/${created.body.callId}/cancel`, {}, calleeSession);
    assert.equal(res.status, 403);
  } finally {
    await teardown();
  }
});

test('cancel: idempotent – cancelling an already-ended call returns 200', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    await postJson(url, `/calls/${callId}/cancel`, {}, callerSession);
    const res = await postJson(url, `/calls/${callId}/cancel`, {}, callerSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ended');
  } finally {
    await teardown();
  }
});

// ─── POST /calls/:callId/end ──────────────────────────────────────────────────

test('end: either party can end an active call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);

    const res = await postJson(url, `/calls/${callId}/end`, {}, callerSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ended');
    assert.equal(res.body.endReason, 'ended');
  } finally {
    await teardown();
  }
});

test('end: callee can also end the call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);

    const res = await postJson(url, `/calls/${callId}/end`, {}, calleeSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ended');
  } finally {
    await teardown();
  }
});

test('end: idempotent – ending an already-ended call returns 200', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
    await postJson(url, `/calls/${callId}/end`, {}, callerSession);
    const res = await postJson(url, `/calls/${callId}/end`, {}, callerSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ended');
  } finally {
    await teardown();
  }
});

test('end: third party cannot end a call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');
    const thirdSession = await createSession(url, 'user-carol');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const res = await postJson(url, `/calls/${created.body.callId}/end`, {}, thirdSession);
    assert.equal(res.status, 403);
  } finally {
    await teardown();
  }
});

// ─── Terminal-state immutability ──────────────────────────────────────────────

test('terminal state: declined call cannot be accepted or ended', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;
    await postJson(url, `/calls/${callId}/decline`, {}, calleeSession);

    const acceptRes = await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
    assert.equal(acceptRes.status, 409);

    const endRes = await postJson(url, `/calls/${callId}/end`, {}, callerSession);
    assert.equal(endRes.status, 409);
  } finally {
    await teardown();
  }
});

// ─── State transitions: full lifecycle ───────────────────────────────────────

test('full lifecycle: ringing → accepted → ended produces consistent event log', async () => {
  const { url, getCallEvents, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
    await postJson(url, `/calls/${callId}/end`, {}, callerSession);

    const events = getCallEvents(callId);
    assert.equal(events.length, 3);
    assert.equal(events[0].event, 'created');
    assert.equal(events[1].event, 'accepted');
    assert.equal(events[2].event, 'ended');
    assert.equal(events[2].reason, 'ended');
  } finally {
    await teardown();
  }
});

// ─── Timeout worker ───────────────────────────────────────────────────────────

test('tickRingingTimeouts: transitions stale ringing calls to missed', async () => {
  const { url, getCall, tickRingingTimeouts, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;
    assert.equal(created.body.status, 'ringing');

    // Tick with a timestamp far in the future.
    const transitioned = tickRingingTimeouts(Date.now() + DEFAULT_RINGING_TIMEOUT_MS + 1_000);
    assert.equal(transitioned, 1);

    const call = getCall(callId);
    assert.equal(call.status, 'missed');
    assert.equal(call.endReason, 'timeout');
    assert.equal(call.ringTimeoutAt, null);
  } finally {
    await teardown();
  }
});

test('tickRingingTimeouts: does not affect calls not yet expired', async () => {
  const { url, getCall, tickRingingTimeouts, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    // Tick with the current time – the call was just created so it shouldn't expire.
    const transitioned = tickRingingTimeouts(Date.now());
    assert.equal(transitioned, 0);

    const call = getCall(callId);
    assert.equal(call.status, 'ringing');
  } finally {
    await teardown();
  }
});

test('tickRingingTimeouts: does not re-transition already-terminal calls', async () => {
  const { url, getCallEvents, tickRingingTimeouts, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    const callId = created.body.callId;

    // Callee declines → terminal state.
    await postJson(url, `/calls/${callId}/decline`, {}, calleeSession);

    // Tick far in the future – should not affect the already-terminal call.
    const transitioned = tickRingingTimeouts(Date.now() + DEFAULT_RINGING_TIMEOUT_MS + 1_000);
    assert.equal(transitioned, 0);

    const events = getCallEvents(callId);
    assert.ok(
      events.every((e) => e.event !== 'missed'),
      'no missed event should be appended'
    );
  } finally {
    await teardown();
  }
});

// ─── call_events persistence ──────────────────────────────────────────────────

test('call_events: busy call generates created + busy events', async () => {
  const { url, getCallEvents, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const carolSession = await createSession(url, 'user-carol');
    await createSession(url, 'user-bob');

    // Carol starts a call to Bob → Bob is now busy.
    await postJson(url, '/calls', { calleeId: 'user-bob' }, carolSession);

    // Alice calls Bob → gets `busy` immediately.
    const busyCall = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    const events = getCallEvents(busyCall.body.callId);

    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'created');
    assert.equal(events[1].event, 'busy');
  } finally {
    await teardown();
  }
});

// ─── GET /call-end-reasons ────────────────────────────────────────────────────

test('call-end-reasons: returns the canonical reason map (no auth required)', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await getJson(url, '/call-end-reasons');
    assert.equal(res.status, 200);
    const { reasons } = res.body;
    // Spot-check known reasons are present and map to non-empty i18n keys.
    for (const [reason, key] of Object.entries(CALL_END_REASONS)) {
      assert.equal(typeof reasons[reason], 'string', `reason '${reason}' should be a string`);
      assert.equal(reasons[reason], key);
    }
  } finally {
    await teardown();
  }
});

// ─── GET /calls (history) ─────────────────────────────────────────────────────

test('history: returns calls for the authenticated user', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const bobSession = await createSession(url, 'user-bob');

    // Alice calls Bob and Bob declines.
    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    await postJson(url, `/calls/${created.body.callId}/decline`, {}, bobSession);

    const aliceHistory = await getJson(url, '/calls', aliceSession);
    assert.equal(aliceHistory.status, 200);
    assert.equal(aliceHistory.body.calls.length, 1);
    assert.equal(aliceHistory.body.total, 1);
    assert.equal(aliceHistory.body.calls[0].callId, created.body.callId);
    assert.equal(aliceHistory.body.calls[0].status, 'declined');

    const bobHistory = await getJson(url, '/calls', bobSession);
    assert.equal(bobHistory.status, 200);
    assert.equal(bobHistory.body.calls.length, 1);
  } finally {
    await teardown();
  }
});

test('history: requires a valid session', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await getJson(url, '/calls', 'bad-session');
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

test('history: returns 401 with no session', async () => {
  const { url, teardown } = await startServer();
  try {
    const response = await fetch(`${url}/calls`);
    assert.equal(response.status, 401);
  } finally {
    await teardown();
  }
});

test('history: only shows calls involving the requesting user', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const bobSession = await createSession(url, 'user-bob');
    const carolSession = await createSession(url, 'user-carol');

    // Alice calls Bob; Carol is not involved.
    await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);

    const carolHistory = await getJson(url, '/calls', carolSession);
    assert.equal(carolHistory.body.calls.length, 0);
    assert.equal(carolHistory.body.total, 0);

    // Make Carol place a call so she has history.
    await createSession(url, 'user-dave');
    await postJson(url, '/calls', { calleeId: 'user-dave' }, carolSession);
    const carolHistory2 = await getJson(url, '/calls', carolSession);
    assert.equal(carolHistory2.body.calls.length, 1);

    // Bob's history still only has Alice's call.
    const bobHistory = await getJson(url, '/calls', bobSession);
    assert.equal(bobHistory.body.calls.length, 1);
    assert.equal(bobHistory.body.calls[0].callerId, 'user-alice');
  } finally {
    await teardown();
  }
});

test('history: respects the limit query parameter', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');

    // Create 5 calls (each to a different unknown callee to get terminal status immediately).
    for (let i = 0; i < 5; i++) {
      await postJson(url, '/calls', { calleeId: `ghost-${i}` }, callerSession);
    }

    const res = await getJson(url, '/calls?limit=3', callerSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.calls.length, 3);
    assert.equal(res.body.total, 5);
  } finally {
    await teardown();
  }
});

test('history: filters by status', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const bobSession = await createSession(url, 'user-bob');

    // One declined call.
    const c1 = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    await postJson(url, `/calls/${c1.body.callId}/decline`, {}, bobSession);

    // One unreachable call (ghost user).
    await postJson(url, '/calls', { calleeId: 'ghost-user' }, aliceSession);

    const declined = await getJson(url, '/calls?status=declined', aliceSession);
    assert.equal(declined.body.calls.length, 1);
    assert.equal(declined.body.calls[0].status, 'declined');

    const unreachable = await getJson(url, '/calls?status=unreachable', aliceSession);
    assert.equal(unreachable.body.calls.length, 1);

    const all = await getJson(url, '/calls', aliceSession);
    assert.equal(all.body.total, 2);
  } finally {
    await teardown();
  }
});

test('history: returns most-recent calls first', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');

    // Create 3 calls and capture their IDs in order.
    const callIds = [];
    for (let i = 0; i < 3; i++) {
      const r = await postJson(url, '/calls', { calleeId: `ghost-${i}` }, callerSession);
      callIds.push(r.body.callId);
    }

    const res = await getJson(url, '/calls?limit=3', callerSession);
    // Most recent should be at index 0.
    assert.equal(res.body.calls[0].callId, callIds[2]);
    assert.equal(res.body.calls[2].callId, callIds[0]);
  } finally {
    await teardown();
  }
});

test('CALL_END_REASONS: exported object has expected terminal reasons', () => {
  const expected = ['ended', 'declined', 'cancelled', 'timeout', 'busy', 'unreachable', 'failed'];
  for (const reason of expected) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(CALL_END_REASONS, reason),
      `expected reason '${reason}' to be in CALL_END_REASONS`
    );
    assert.equal(typeof CALL_END_REASONS[reason], 'string');
  }
});

test('ring window: defaults to two minutes and is configurable via RINGING_TIMEOUT_MS', async () => {
  // A 30s window was too short for a locked or silent handset to be picked up.
  assert.equal(DEFAULT_RINGING_TIMEOUT_MS, 120_000);

  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-ring-default');
    await createSession(url, 'user-ring-default-callee');
    const before = Date.now();
    const res = await postJson(
      url,
      '/calls',
      { calleeId: 'user-ring-default-callee' },
      callerSession
    );
    const remainingMs = new Date(res.body.ringTimeoutAt).getTime() - before;
    assert.ok(
      remainingMs > 110_000 && remainingMs <= 121_000,
      `unexpected ring window ${remainingMs}ms`
    );
  } finally {
    await teardown();
  }

  const previous = process.env.RINGING_TIMEOUT_MS;
  process.env.RINGING_TIMEOUT_MS = '45000';
  const configured = await startServer();
  try {
    const callerSession = await createSession(configured.url, 'user-ring-env');
    await createSession(configured.url, 'user-ring-env-callee');
    const before = Date.now();
    const res = await postJson(
      configured.url,
      '/calls',
      { calleeId: 'user-ring-env-callee' },
      callerSession
    );
    const remainingMs = new Date(res.body.ringTimeoutAt).getTime() - before;
    assert.ok(
      remainingMs > 40_000 && remainingMs <= 46_000,
      `unexpected configured ring window ${remainingMs}ms`
    );
  } finally {
    await configured.teardown();
    if (previous === undefined) delete process.env.RINGING_TIMEOUT_MS;
    else process.env.RINGING_TIMEOUT_MS = previous;
  }
});
