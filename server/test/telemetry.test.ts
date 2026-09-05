import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer, CALL_END_REASONS } from '../src/index.ts';
import { createTelemetry } from '../src/telemetry.ts';
import { DEFAULT_RINGING_TIMEOUT_MS } from '../src/config.ts';
import { closeTestServer, getJson, listenOnRandomPort, postJson, readJson } from './helpers.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const METRICS_TOKEN = 'test-metrics-token';

async function startServer() {
  const previousDebugToken = process.env.DEBUG_API_TOKEN;
  process.env.DEBUG_API_TOKEN = METRICS_TOKEN;
  const server = createServer();
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  async function teardown() {
    await closeTestServer(server);
    if (previousDebugToken === undefined) delete process.env.DEBUG_API_TOKEN;
    else process.env.DEBUG_API_TOKEN = previousDebugToken;
  }

  return { ...server, url, teardown };
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

async function getMetricsHttp(url: string): Promise<{ status: number; body: any; }> {
  const response = await fetch(`${url}/metrics`, {
    headers: { 'x-debug-token': METRICS_TOKEN },
  });
  return { status: response.status, body: await readJson(response) };
}

// ─── GET /metrics ─────────────────────────────────────────────────────────────

test('GET /metrics returns a valid snapshot on a fresh server', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await getMetricsHttp(url);
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

    // The per-code breakdown starts empty, alongside the aggregate counter.
    assert.deepEqual(snap.signaling_errors_by_code, {});

    // Derived rates are null before any calls
    assert.equal(snap.derived.call_connect_rate, null);
    assert.equal(snap.derived.call_completion_rate, null);
  } finally {
    await teardown();
  }
});

test('GET /metrics requires the operator token', async () => {
  const { url, teardown } = await startServer();
  try {
    // Missing operator token should be rejected.
    const res = await fetch(`${url}/metrics`);
    assert.equal(res.status, 401);
    const body = await readJson(res);
    assert.equal(body.error, 'metrics authentication required');
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

    const res = await getMetricsHttp(url);
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

    const res = await getMetricsHttp(url);
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

    const res = await getMetricsHttp(url);
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

    const res = await getMetricsHttp(url);
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

    const res = await getMetricsHttp(url);
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

    const res = await getMetricsHttp(url);
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

    const res = await getMetricsHttp(url);
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

    const snap = (await getMetricsHttp(url)).body;
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

    const snap = (await getMetricsHttp(url)).body;
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
    const eventNames = res.body.events.map((e: { event: string; }) => e.event);
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
    const viaHttp = (await getMetricsHttp(url)).body;

    // Core counters must agree (ignoring the collectedAt timestamp difference)
    assert.deepEqual(direct.counters, viaHttp.counters);
  } finally {
    await teardown();
  }
});

// ─── signaling_errors_by_code ─────────────────────────────────────────────────

/**
 * Capture `console.warn` output for assertions.  Callers must `restore()` in a
 * `finally` block so later tests see the real implementation again.
 */
function captureConsoleWarn() {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args) => {
    lines.push(args.join(' '));
  };
  return {
    lines,
    restore: () => {
      console.warn = original;
    },
  };
}

function connectSocket(url: string, sessionId: string): Promise<import('socket.io-client').Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      auth: { sessionId },
      forceNew: true,
      transports: ['websocket'],
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

/**
 * @returns the server's acknowledgement
 */
function emitWithAck(socket: import('socket.io-client').Socket, event: string, payload: unknown): Promise<any> {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}

test('GET /metrics breaks signaling errors down by code', async () => {
  const { url, teardown } = await startServer();
  const callerSession = await createSession(url, 'alice');
  await createSession(url, 'bob');
  const caller = await connectSocket(url, callerSession);

  try {
    // Unknown call id → call_not_found, twice.
    for (let i = 0; i < 2; i += 1) {
      const ack = await emitWithAck(caller, 'rtc.offer', {
        version: 1,
        callId: '00000000-0000-4000-8000-000000000000',
        sdp: { type: 'offer', sdp: 'mock-offer' },
      });
      assert.equal(ack.error.code, 'call_not_found');
    }

    // A ringing (not yet accepted) call → stale_call_state.
    const callRes = await postJson(url, '/calls', { calleeId: 'bob' }, callerSession);
    const staleAck = await emitWithAck(caller, 'rtc.offer', {
      version: 1,
      callId: callRes.body.callId,
      sdp: { type: 'offer', sdp: 'mock-offer' },
    });
    assert.equal(staleAck.error.code, 'stale_call_state');

    const snap = (await getMetricsHttp(url)).body;
    // The aggregate counter stays, for backwards compatibility.
    assert.equal(snap.counters.signaling_errors, 3);
    assert.deepEqual(snap.signaling_errors_by_code, {
      call_not_found: 2,
      stale_call_state: 1,
    });
  } finally {
    caller.disconnect();
    await teardown();
  }
});

test('acknowledgeError logs the code, event, socket and user', async () => {
  const { url, teardown } = await startServer();
  const callerSession = await createSession(url, 'alice');
  const caller = await connectSocket(url, callerSession);
  const warned = captureConsoleWarn();

  try {
    const ack = await emitWithAck(caller, 'rtc.offer', {
      version: 1,
      callId: '00000000-0000-4000-8000-000000000000',
      sdp: { type: 'offer', sdp: 'mock-offer' },
    });
    assert.equal(ack.ok, false);

    const line = warned.lines.find((entry) => entry.includes('code=call_not_found'));
    assert.ok(line, `expected a warning for the rejected event, got ${JSON.stringify(warned.lines)}`);
    assert.ok(line.includes('event=rtc.offer'), line);
    assert.ok(line.includes(`socket=${caller.id}`), line);
    assert.ok(line.includes('user=alice'), line);
  } finally {
    warned.restore();
    caller.disconnect();
    await teardown();
  }
});

test('recordSignalingError buckets a missing code and caps distinct codes', () => {
  const telemetry = createTelemetry();

  telemetry.recordSignalingError();
  telemetry.recordSignalingError('');

  // Fill the per-code map to its cap, then overflow it.
  for (let i = 0; i < 60; i += 1) {
    telemetry.recordSignalingError(`code_${i}`);
  }

  const snap = telemetry.getSnapshot();
  const breakdown = snap.signaling_errors_by_code;

  assert.equal(breakdown.unknown, 2);
  assert.equal(breakdown.code_0, 1);
  // Everything past the cap is folded into a single `other` row, and the
  // breakdown still sums to the aggregate counter.
  assert.equal(breakdown.code_59, undefined);
  // 60 codes were recorded after `unknown` filled the first row, so the last
  // 11 (`code_49`…`code_59`) land in the overflow bucket.
  assert.equal(breakdown.other, 11);
  // The cap bounds the tracked codes; `other` is the one extra overflow row.
  assert.equal(Object.keys(breakdown).length, 51);
  assert.equal(
    Object.values(breakdown).reduce((total, count) => total + count, 0),
    snap.counters.signaling_errors
  );
});
