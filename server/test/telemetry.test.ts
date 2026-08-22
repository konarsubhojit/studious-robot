import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, CALL_END_REASONS } from '../src/index.ts';
import { DEFAULT_RINGING_TIMEOUT_MS } from '../src/config.ts';
import { getJson, listenOnRandomPort, postJson, readJson } from './helpers.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startServer() {
  const server = createServer();
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  async function teardown() {
    server.httpServer.closeAllConnections?.();
    await new Promise((resolve) =>
      server.io.close(() => server.httpServer.close(() => resolve(undefined)))
    );
  }

  return { ...server, url, teardown };
}

/**
 * @param {string} url - Base URL of the server under test.
 * @param {string} userId
 * @param {string} [deviceId]
 * @returns {Promise<string>} the created session id
 */
async function createSession(url: string, userId: string, deviceId: string = `device-${userId}`): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

// ─── GET /metrics ─────────────────────────────────────────────────────────────

test('GET /metrics returns a valid snapshot on a fresh server', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await getJson(url, '/metrics');
    assert.equal(res.status, 200);
    const snap = res.body;

    // Top-level shape
    assert.equal(typeof snap.collectedAt, 'string');
    assert.ok(typeof snap.counters === 'object' && snap.counters !== null);
    assert.ok(typeof snap.histograms === 'object' && snap.histograms !== null);
    assert.ok(typeof snap.derived === 'object' && snap.derived !== null);

    // Counters should all start at 0
    assert.equal(snap.counters.calls_initiated, 0);
    assert.equal(snap.counters.calls_ringing, 0);
    assert.equal(snap.counters.calls_accepted, 0);
    assert.equal(snap.counters.calls_in_call, 0);
    assert.equal(snap.counters.calls_ended, 0);
    assert.equal(snap.counters.calls_declined, 0);
    assert.equal(snap.counters.calls_missed, 0);
    assert.equal(snap.counters.calls_cancelled, 0);
    assert.equal(snap.counters.calls_busy, 0);
    assert.equal(snap.counters.calls_unreachable, 0);
    assert.equal(snap.counters.calls_failed, 0);
    assert.equal(snap.counters.signaling_errors, 0);

    // Derived rates are null before any calls
    assert.equal(snap.derived.call_connect_rate, null);
    assert.equal(snap.derived.call_completion_rate, null);
  } finally {
    await teardown();
  }
});

test('GET /metrics does not require authentication', async () => {
  const { url, teardown } = await startServer();
  try {
    // No session header – should still return 200
    const res = await fetch(`${url}/metrics`);
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.equal(typeof body.counters, 'object');
  } finally {
    await teardown();
  }
});

test('GET /metrics increments calls_initiated and calls_ringing after a call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    await createSession(url, 'bob');

    await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);

    const res = await getJson(url, '/metrics');
    assert.equal(res.body.counters.calls_initiated, 1);
    assert.equal(res.body.counters.calls_ringing, 1);
  } finally {
    await teardown();
  }
});

test('GET /metrics increments calls_accepted after callee accepts', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    const calleeSession = await createSession(url, 'bob');

    const callRes = await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    const callId = callRes.body.callId;

    await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);

    const res = await getJson(url, '/metrics');
    assert.equal(res.body.counters.calls_initiated, 1);
    assert.equal(res.body.counters.calls_accepted, 1);
  } finally {
    await teardown();
  }
});

test('GET /metrics increments calls_declined after callee declines', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    const calleeSession = await createSession(url, 'bob');

    const callRes = await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    const callId = callRes.body.callId;

    await postJson(url, `/calls/${callId}/decline`, {}, calleeSession);

    const res = await getJson(url, '/metrics');
    assert.equal(res.body.counters.calls_declined, 1);
    assert.equal(res.body.counters.calls_accepted, 0);
  } finally {
    await teardown();
  }
});

test('GET /metrics increments calls_ended after caller ends the call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    const calleeSession = await createSession(url, 'bob');

    const callRes = await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    const callId = callRes.body.callId;

    await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
    await postJson(url, `/calls/${callId}/end`, {}, callerSession);

    const res = await getJson(url, '/metrics');
    assert.equal(res.body.counters.calls_ended, 1);
    assert.equal(res.body.counters.calls_accepted, 1);
  } finally {
    await teardown();
  }
});

test('GET /metrics increments calls_cancelled after caller cancels', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    await createSession(url, 'bob');

    const callRes = await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    const callId = callRes.body.callId;

    await postJson(url, `/calls/${callId}/cancel`, {}, callerSession);

    const res = await getJson(url, '/metrics');
    assert.equal(res.body.counters.calls_ended, 1);
    assert.equal(res.body.counters.calls_cancelled, 1);
  } finally {
    await teardown();
  }
});

test('GET /metrics increments calls_missed after ringing timeout', async () => {
  const { url, teardown, tickRingingTimeouts } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    await createSession(url, 'bob');

    await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);

    // Advance time past the ringing timeout.
    tickRingingTimeouts(Date.now() + DEFAULT_RINGING_TIMEOUT_MS + 1_000);

    const res = await getJson(url, '/metrics');
    assert.equal(res.body.counters.calls_missed, 1);
  } finally {
    await teardown();
  }
});

test('GET /metrics tracks calls_busy when callee already has an active call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    const callerSession2 = await createSession(url, 'carol');
    await createSession(url, 'bob');

    // First call puts bob in an active call (ringing).
    await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    // Second call should be immediately busy.
    await postJson(url, '/calls', { calleeId: 'bob' }, callerSession2);

    const res = await getJson(url, '/metrics');
    assert.equal(res.body.counters.calls_initiated, 2);
    assert.equal(res.body.counters.calls_busy, 1);
  } finally {
    await teardown();
  }
});

test('GET /metrics call_connect_rate is a number after a connected call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    const calleeSession = await createSession(url, 'bob');

    const callRes = await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    const callId = callRes.body.callId;
    await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
    await postJson(url, `/calls/${callId}/end`, {}, callerSession);

    const snap = (await getJson(url, '/metrics')).body;
    // calls_in_call is 0 until rtc transitions; but connect_rate should not throw
    assert.equal(typeof snap.derived.call_connect_rate, 'number');
  } finally {
    await teardown();
  }
});

test('GET /metrics histograms include call_setup_latency_ms after accepted call', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    const calleeSession = await createSession(url, 'bob');

    const callRes = await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    const callId = callRes.body.callId;
    await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);

    const snap = (await getJson(url, '/metrics')).body;
    const hist = snap.histograms.call_setup_latency_ms;
    assert.equal(hist.count, 1);
    assert.equal(typeof hist.mean, 'number');
  } finally {
    await teardown();
  }
});

// ─── GET /calls/:callId/events ────────────────────────────────────────────────

test('GET /calls/:callId/events returns event timeline for participant', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    const calleeSession = await createSession(url, 'bob');

    const callRes = await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    const callId = callRes.body.callId;
    await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
    await postJson(url, `/calls/${callId}/end`, {}, callerSession);

    const res = await getJson(url, `/calls/${callId}/events`, callerSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.callId, callId);
    assert.ok(Array.isArray(res.body.events));

    // Should have at least: created, accepted, ended
    const eventNames = res.body.events.map((/** @type {{ event: string }} */ e: { event: string; }) => e.event);
    assert.ok(eventNames.includes('created'), 'events should include created');
    assert.ok(eventNames.includes('accepted'), 'events should include accepted');
    assert.ok(eventNames.includes('ended'), 'events should include ended');

    // Every event should have required fields
    for (const e of res.body.events) {
      assert.equal(typeof e.eventId, 'string');
      assert.equal(typeof e.callId, 'string');
      assert.equal(typeof e.event, 'string');
      assert.equal(typeof e.timestamp, 'string');
    }
  } finally {
    await teardown();
  }
});

test('GET /calls/:callId/events is accessible by callee', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    const calleeSession = await createSession(url, 'bob');

    const callRes = await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    const callId = callRes.body.callId;

    const res = await getJson(url, `/calls/${callId}/events`, calleeSession);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.events));
  } finally {
    await teardown();
  }
});

test('GET /calls/:callId/events requires authentication', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    await createSession(url, 'bob');

    const callRes = await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    const callId = callRes.body.callId;

    const res = await getJson(url, `/calls/${callId}/events`);
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

test('GET /calls/:callId/events returns 403 for non-participant', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    await createSession(url, 'bob');
    const eveSession = await createSession(url, 'eve');

    const callRes = await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    const callId = callRes.body.callId;

    const res = await getJson(url, `/calls/${callId}/events`, eveSession);
    assert.equal(res.status, 403);
  } finally {
    await teardown();
  }
});

test('GET /calls/:callId/events returns 404 for unknown callId', async () => {
  const { url, teardown } = await startServer();
  try {
    const session = await createSession(url, 'alice');
    const res = await getJson(url, '/calls/nonexistent-call/events', session);
    assert.equal(res.status, 404);
  } finally {
    await teardown();
  }
});

test('GET /calls/:callId/events events are in chronological order', async () => {
  const { url, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    const calleeSession = await createSession(url, 'bob');

    const callRes = await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    const callId = callRes.body.callId;
    await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
    await postJson(url, `/calls/${callId}/end`, {}, callerSession);

    const res = await getJson(url, `/calls/${callId}/events`, callerSession);
    const { events } = res.body;

    // Timestamps must be monotonically non-decreasing
    for (let i = 1; i < events.length; i++) {
      assert.ok(
        new Date(events[i].timestamp) >= new Date(events[i - 1].timestamp),
        `event[${i}] timestamp should be >= event[${i - 1}] timestamp`
      );
    }
  } finally {
    await teardown();
  }
});

// ─── getMetrics() programmatic API ────────────────────────────────────────────

test('getMetrics() returns the same data as GET /metrics', async () => {
  const { url, getMetrics, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'alice');
    await createSession(url, 'bob');
    await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);

    const direct = getMetrics();
    const viaHttp = (await getJson(url, '/metrics')).body;

    // Core counters must agree (ignoring the collectedAt timestamp difference)
    assert.deepEqual(direct.counters, viaHttp.counters);
  } finally {
    await teardown();
  }
});
