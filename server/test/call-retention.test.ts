/**
 * Regression tests for in-memory call retention.
 *
 * `state.calls` was never pruned: every call the process had ever seen stayed
 * in the map forever.  That is a memory leak, and it also made `GET /calls`
 * and the ringing sweep iterate a set whose size grew without bound.
 *
 * Terminal calls are now evicted once they age past the retention window, with
 * a hard ceiling for bursts that all land inside one window.  A call that is
 * still live must never be evicted — it is state, not history.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/index.ts';
import { parseByteSize, parseNonNegativeNumber } from '../src/lib/env.ts';
import { closeTestServer, listenOnRandomPort, postJson, readJson } from './helpers.ts';

const HOUR_MS = 60 * 60 * 1000;

async function startServer(opts?: import('../src/createServer.ts').CreateServerOptions) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  async function teardown() {
    await closeTestServer(server);
  }

  return { ...server, url, teardown };
}

async function createSession(url: string, userId: string, deviceId: string = `device-${userId}`): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

/**
 * Ring `user-bob` and immediately decline, leaving one terminal call behind.
 *
 * @returns the completed call's id
 */
async function completeCall(url: string, callerSession: string, calleeSession: string): Promise<string> {
  const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
  assert.equal(created.status, 201);
  const callId = created.body.callId;
  const declined = await postJson(url, `/calls/${callId}/decline`, {}, calleeSession);
  assert.equal(declined.status, 200);
  return callId;
}

async function getCalls(url: string, sessionId: string): Promise<any[]> {
  const response = await fetch(`${url}/calls?sessionId=${encodeURIComponent(sessionId)}`);
  assert.equal(response.status, 200);
  const body = await readJson(response);
  return body.calls ?? body;
}

test('retention: the call map returns to baseline after N completed calls', async () => {
  // The per-route rate limiter would otherwise reject the burst below.
  const { url, getCall, pruneTerminalCalls, teardown } = await startServer({ callRateLimit: 100 });
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const callIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      callIds.push(await completeCall(url, callerSession, calleeSession));
    }
    // All twelve are still resident: they are inside the retention window.
    assert.equal(callIds.filter((id) => getCall(id) !== null).length, 12);

    // Advance past the window and sweep.
    const evicted = pruneTerminalCalls(Date.now() + 25 * HOUR_MS);

    assert.equal(evicted, 12);
    assert.equal(callIds.filter((id) => getCall(id) !== null).length, 0);
  } finally {
    await teardown();
  }
});

test('retention: a live call is never evicted, however old the window makes it look', async () => {
  const { url, getCall, pruneTerminalCalls, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    const created = await postJson(url, '/calls', { calleeId: 'user-bob' }, callerSession);
    assert.equal(created.status, 201);
    const callId = created.body.callId;
    assert.equal(getCall(callId)?.status, 'ringing');

    assert.equal(pruneTerminalCalls(Date.now() + 1000 * HOUR_MS), 0);

    // Still ringing, still addressable: bounded by the timeout sweep, not by
    // retention.
    assert.equal(getCall(callId)?.status, 'ringing');
  } finally {
    await teardown();
  }
});

test('retention: evicting a call drops its event log too', async () => {
  const { url, getCallEvents, pruneTerminalCalls, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const callId = await completeCall(url, callerSession, calleeSession);
    assert.ok(getCallEvents(callId).length > 0, 'expected a timeline for a completed call');

    pruneTerminalCalls(Date.now() + 25 * HOUR_MS);

    // Otherwise the leak simply moves from one map to the other.
    assert.deepEqual(getCallEvents(callId), []);
  } finally {
    await teardown();
  }
});

test('retention: the count ceiling drops the oldest calls first', async () => {
  const { url, getCall, pruneTerminalCalls, teardown } = await startServer({ maxRetainedCalls: 5, callRateLimit: 100 });
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const callIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      callIds.push(await completeCall(url, callerSession, calleeSession));
    }

    // A burst inside a single retention window is bounded by the ceiling
    // rather than by age, so the sweep runs at the current time.
    const evicted = pruneTerminalCalls(Date.now());

    assert.equal(evicted, 3);
    const surviving = callIds.filter((id) => getCall(id) !== null);
    assert.equal(surviving.length, 5);
    // The three oldest went; the five newest stayed.
    assert.deepEqual(surviving, callIds.slice(3));
  } finally {
    await teardown();
  }
});

test('retention: recent history is still served by GET /calls', async () => {
  const { url, pruneTerminalCalls, teardown } = await startServer();
  try {
    const callerSession = await createSession(url, 'user-alice');
    const calleeSession = await createSession(url, 'user-bob');

    const recentId = await completeCall(url, callerSession, calleeSession);

    // A sweep at the current time must leave the window's contents alone.
    assert.equal(pruneTerminalCalls(Date.now()), 0);

    const calls = await getCalls(url, callerSession);
    assert.ok(
      calls.some((call: any) => call.callId === recentId),
      'expected the just-completed call to still appear in history'
    );
  } finally {
    await teardown();
  }
});

// ─── Environment parsing ─────────────────────────────────────────────────────
//
// Both windows document `0` as "skip this bound on this pass", but they were
// read with `Number(env) || DEFAULT`, in which `0` is falsy: an operator who
// disabled a bound silently got the default instead, and a typo that parsed to
// `NaN` was indistinguishable from an unset variable.

test('retention: CALL_RETENTION_MS=0 disables age eviction instead of defaulting', async () => {
  const previous = process.env.CALL_RETENTION_MS;
  process.env.CALL_RETENTION_MS = '0';
  try {
    const { url, getCall, pruneTerminalCalls, teardown } = await startServer();
    try {
      const callerSession = await createSession(url, 'user-alice');
      const calleeSession = await createSession(url, 'user-bob');
      const callId = await completeCall(url, callerSession, calleeSession);

      // Far beyond the 24h default: with `0` swallowed as falsy this call would
      // have been evicted.
      assert.equal(pruneTerminalCalls(Date.now() + 1000 * HOUR_MS), 0);
      assert.ok(getCall(callId) !== null);
    } finally {
      await teardown();
    }
  } finally {
    if (previous === undefined) delete process.env.CALL_RETENTION_MS;
    else process.env.CALL_RETENTION_MS = previous;
  }
});

test('retention: MAX_RETAINED_CALLS=0 disables the ceiling instead of defaulting', async () => {
  const previous = process.env.MAX_RETAINED_CALLS;
  process.env.MAX_RETAINED_CALLS = '0';
  try {
    const { url, getCall, pruneTerminalCalls, teardown } = await startServer({ callRateLimit: 100 });
    try {
      const callerSession = await createSession(url, 'user-alice');
      const calleeSession = await createSession(url, 'user-bob');
      const callIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        callIds.push(await completeCall(url, callerSession, calleeSession));
      }

      assert.equal(pruneTerminalCalls(Date.now()), 0);
      assert.equal(callIds.filter((id) => getCall(id) !== null).length, 6);
    } finally {
      await teardown();
    }
  } finally {
    if (previous === undefined) delete process.env.MAX_RETAINED_CALLS;
    else process.env.MAX_RETAINED_CALLS = previous;
  }
});

test('retention: numeric configuration accepts zero and rejects invalid values', () => {
  assert.equal(parseNonNegativeNumber('TEST_VALUE', '0', 42), 0);
  assert.equal(parseNonNegativeNumber('TEST_VALUE', undefined, 42), 42);
  assert.equal(parseNonNegativeNumber('TEST_VALUE', '1500', 42), 1500);
  for (const value of ['not-a-number', '-1', '', '1.5', 'Infinity']) {
    assert.throws(
      () => parseNonNegativeNumber('TEST_VALUE', value, 42),
      /Invalid TEST_VALUE: expected a non-negative integer/
    );
  }
});

test('server startup rejects an invalid numeric environment setting', () => {
  const previous = process.env.CALL_RATE_LIMIT;
  process.env.CALL_RATE_LIMIT = '-1';
  try {
    assert.throws(
      () => createServer(),
      /Invalid CALL_RATE_LIMIT: expected a non-negative integer, received "-1"/
    );
  } finally {
    if (previous === undefined) delete process.env.CALL_RATE_LIMIT;
    else process.env.CALL_RATE_LIMIT = previous;
  }
});

test('byte-size configuration accepts supported units and rejects invalid values', () => {
  assert.equal(parseByteSize('JSON_BODY_LIMIT', undefined, '64kb'), '64kb');
  assert.equal(parseByteSize('JSON_BODY_LIMIT', '128KB', '64kb'), '128KB');
  assert.throws(
    () => parseByteSize('JSON_BODY_LIMIT', '-1kb', '64kb'),
    /Invalid JSON_BODY_LIMIT: expected a non-negative byte size/
  );
});
