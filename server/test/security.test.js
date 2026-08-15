'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/index.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startServer(opts = {}) {
  const server = createServer(opts);
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  const url = `http://127.0.0.1:${port}`;

  async function teardown(...clients) {
    clients.forEach((c) => c.disconnect());
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

async function deleteJson(url, path, sessionId) {
  const fullPath = sessionId
    ? `${url}${path}?sessionId=${encodeURIComponent(sessionId)}`
    : `${url}${path}`;
  const response = await fetch(fullPath, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
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

async function createSession(url, userId, deviceId = `device-${userId}`) {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

function connect(url, auth) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      auth,
      forceNew: true,
      transports: ['websocket'],
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}

function waitFor(socket, event, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

// ─── Block management (HTTP) ──────────────────────────────────────────────────

test('POST /blocks: can block a user; GET /blocks: lists blocked users', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    const block = await postJson(url, '/blocks', { blockeeId: 'user-bob' }, aliceSession);
    assert.equal(block.status, 200);
    assert.equal(block.body.blockerId, 'user-alice');
    assert.equal(block.body.blockeeId, 'user-bob');

    const list = await getJson(url, '/blocks', aliceSession);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.blockedUsers, ['user-bob']);
  } finally {
    await teardown();
  }
});

test('DELETE /blocks/:blockeeId: can unblock a user', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');

    await postJson(url, '/blocks', { blockeeId: 'user-bob' }, aliceSession);

    const unblock = await deleteJson(url, '/blocks/user-bob', aliceSession);
    assert.equal(unblock.status, 200);
    assert.equal(unblock.body.blockerId, 'user-alice');
    assert.equal(unblock.body.blockeeId, 'user-bob');

    const list = await getJson(url, '/blocks', aliceSession);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.blockedUsers, []);
  } finally {
    await teardown();
  }
});

test('DELETE /blocks/:blockeeId: returns 404 when block does not exist', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');

    const res = await deleteJson(url, '/blocks/user-ghost', aliceSession);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'block not found');
  } finally {
    await teardown();
  }
});

test('POST /blocks: requires authentication', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await postJson(url, '/blocks', { blockeeId: 'user-bob' }, 'bad-session');
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

test('POST /blocks: rejects missing blockeeId', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const res = await postJson(url, '/blocks', {}, aliceSession);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'blockeeId is required');
  } finally {
    await teardown();
  }
});

test('POST /blocks: rejects blocking yourself', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const res = await postJson(url, '/blocks', { blockeeId: 'user-alice' }, aliceSession);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'cannot block yourself');
  } finally {
    await teardown();
  }
});

test('POST /blocks: blocking is idempotent', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');

    await postJson(url, '/blocks', { blockeeId: 'user-bob' }, aliceSession);
    const second = await postJson(url, '/blocks', { blockeeId: 'user-bob' }, aliceSession);
    assert.equal(second.status, 200);

    const list = await getJson(url, '/blocks', aliceSession);
    assert.deepEqual(list.body.blockedUsers, ['user-bob']);
  } finally {
    await teardown();
  }
});

test('GET /blocks: requires authentication', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await getJson(url, '/blocks', 'bad-session');
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

// ─── Blocklist enforcement – HTTP ─────────────────────────────────────────────

test('POST /calls: blocked caller receives 403', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const bobSession = await createSession(url, 'user-bob');

    // Bob blocks Alice.
    const block = await postJson(url, '/blocks', { blockeeId: 'user-alice' }, bobSession);
    assert.equal(block.status, 200);

    // Alice tries to call Bob → should be rejected.
    const res = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'blocked');
  } finally {
    await teardown();
  }
});

test('POST /calls: unblocked caller can call again after block is removed', async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const bobSession = await createSession(url, 'user-bob');

    await postJson(url, '/blocks', { blockeeId: 'user-alice' }, bobSession);
    await deleteJson(url, '/blocks/user-alice', bobSession);

    const res = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(res.status, 201);
  } finally {
    await teardown();
  }
});

// ─── Blocklist enforcement – Socket.IO ───────────────────────────────────────

test('call.initiate via socket: blocked caller receives blocked error', async () => {
  const { url, teardown } = await startServer();
  const aliceSession = await createSession(url, 'user-alice');
  const bobSession = await createSession(url, 'user-bob');
  await postJson(url, '/blocks', { blockeeId: 'user-alice' }, bobSession);
  const [caller, callee] = await Promise.all([
    connect(url, { sessionId: aliceSession }),
    connect(url, { sessionId: bobSession }),
  ]);
  try {
    const ack = await emitWithAck(caller, 'call.initiate', {
      version: 1,
      calleeId: 'user-bob',
    });
    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, 'blocked');
  } finally {
    await teardown(caller, callee);
  }
});

test('call.initiate via socket: callee does NOT receive incoming call when caller is blocked', async () => {
  const { url, teardown } = await startServer();
  const aliceSession = await createSession(url, 'user-alice');
  const bobSession = await createSession(url, 'user-bob');
  await postJson(url, '/blocks', { blockeeId: 'user-alice' }, bobSession);
  const [caller, callee] = await Promise.all([
    connect(url, { sessionId: aliceSession }),
    connect(url, { sessionId: bobSession }),
  ]);
  try {
    let calleeReceivedIncoming = false;
    callee.on('call.incoming', () => {
      calleeReceivedIncoming = true;
    });

    await emitWithAck(caller, 'call.initiate', { version: 1, calleeId: 'user-bob' });

    // Give the server a moment to deliver any spurious event.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      calleeReceivedIncoming,
      false,
      'callee should not receive incoming call from blocked caller'
    );
  } finally {
    await teardown(caller, callee);
  }
});

// ─── Rate limiting – call initiation ─────────────────────────────────────────

test('POST /calls: rate limit is enforced after exceeding the window', async () => {
  // Allow only 2 calls per window so the test is quick.
  const { url, teardown } = await startServer({ callRateLimit: 2, callRateWindowMs: 60_000 });
  try {
    const aliceSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    const first = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(first.status, 201);

    const second = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(second.status, 201);

    const third = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(third.status, 429);
    assert.equal(third.body.error, 'too many requests');
    assert.equal(typeof third.body.retryAfter, 'number');
  } finally {
    await teardown();
  }
});

test('POST /calls: rate limit is per-user – other users are not affected', async () => {
  const { url, teardown } = await startServer({ callRateLimit: 1, callRateWindowMs: 60_000 });
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const carolSession = await createSession(url, 'user-carol');
    await createSession(url, 'user-bob');

    // Alice exhausts her quota.
    await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    const aliceBlocked = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(aliceBlocked.status, 429);

    // Carol still has her own quota.
    const carolOk = await postJson(url, '/calls', { calleeId: 'user-bob' }, carolSession);
    assert.equal(carolOk.status, 201);
  } finally {
    await teardown();
  }
});

test('call.initiate via socket: rate limit is enforced', async () => {
  const { url, teardown } = await startServer({ callRateLimit: 2, callRateWindowMs: 60_000 });
  const aliceSession = await createSession(url, 'user-alice');
  const bobSession = await createSession(url, 'user-bob');
  const [caller, callee] = await Promise.all([
    connect(url, { sessionId: aliceSession }),
    connect(url, { sessionId: bobSession }),
  ]);
  try {
    const first = await emitWithAck(caller, 'call.initiate', { version: 1, calleeId: 'user-bob' });
    assert.equal(first.ok, true);

    const second = await emitWithAck(caller, 'call.initiate', { version: 1, calleeId: 'user-bob' });
    assert.equal(second.ok, true);

    const third = await emitWithAck(caller, 'call.initiate', { version: 1, calleeId: 'user-bob' });
    assert.equal(third.ok, false);
    assert.equal(third.error.code, 'rate_limited');
  } finally {
    await teardown(caller, callee);
  }
});

// ─── Rate limiting – RTC signaling ───────────────────────────────────────────

test('rtc.offer via socket: rate limit is enforced', async () => {
  // Allow only 1 RTC event per large window to reliably trigger the limit.
  const { url, teardown } = await startServer({ rtcRateLimit: 1, rtcRateWindowMs: 60_000 });
  const aliceSession = await createSession(url, 'user-alice');
  const bobSession = await createSession(url, 'user-bob');
  const [caller, callee] = await Promise.all([
    connect(url, { sessionId: aliceSession }),
    connect(url, { sessionId: bobSession }),
  ]);
  try {
    // Set up a ringing call.
    const incomingP = waitFor(callee, 'call.incoming');
    const ringingP = waitFor(caller, 'call.ringing');
    const callerStateP = waitFor(caller, 'call.state_changed');
    const calleeStateP = waitFor(callee, 'call.state_changed');
    const initiated = await emitWithAck(caller, 'call.initiate', {
      version: 1,
      calleeId: 'user-bob',
    });
    const callId = initiated.call.callId;
    await Promise.all([incomingP, ringingP, callerStateP, calleeStateP]);

    // Accept the call.
    const acceptCallerP = waitFor(caller, 'call.accept');
    const acceptCallerStateP = waitFor(caller, 'call.state_changed');
    const acceptCalleeStateP = waitFor(callee, 'call.state_changed');
    await emitWithAck(callee, 'call.accept', { version: 1, callId });
    await Promise.all([acceptCallerP, acceptCallerStateP, acceptCalleeStateP]);

    // First RTC offer is within quota.
    const firstOffer = await emitWithAck(caller, 'rtc.offer', {
      version: 1,
      callId,
      sdp: { type: 'offer', sdp: 'mock' },
    });
    assert.equal(firstOffer.ok, true);

    // Second RTC offer exceeds quota.
    const secondOffer = await emitWithAck(caller, 'rtc.offer', {
      version: 1,
      callId,
      sdp: { type: 'offer', sdp: 'mock2' },
    });
    assert.equal(secondOffer.ok, false);
    assert.equal(secondOffer.error.code, 'rate_limited');
  } finally {
    await teardown(caller, callee);
  }
});

// ─── Session expiry ───────────────────────────────────────────────────────────

test('GET /session: returns 401 after session expires', async () => {
  const { url, teardown } = await startServer({ sessionTtlMs: 100 });
  try {
    const res = await postJson(url, '/session', { userId: 'user-alice', deviceId: 'dev-1' });
    assert.equal(res.status, 201);
    assert.equal(typeof res.body.expiresAt, 'string');

    const sessionId = res.body.sessionId;

    // Immediately the session is valid.
    const valid = await getJson(url, '/session', sessionId);
    assert.equal(valid.status, 200);

    // Wait for TTL to elapse.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const expired = await getJson(url, '/session', sessionId);
    assert.equal(expired.status, 401);
  } finally {
    await teardown();
  }
});

test('socket connect: a stale sessionId downgrades to guest and emits session.invalid', async () => {
  const { url, teardown } = await startServer({ sessionTtlMs: 100 });
  let socket;
  try {
    const sessionId = await createSession(url, 'user-alice');

    // Wait for the session to expire (simulates a server restart wiping the
    // in-memory session table just as well as a natural TTL expiry).
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Build the client manually (rather than via `connect()`) and register
    // the `session.invalid` listener before `connect` fires: the server may
    // emit it immediately after the handshake, arriving in the same read as
    // the CONNECT packet, so waiting for `connect` to resolve first can lose
    // the race and miss a `once`-registered listener.
    socket = ioClient(url, { auth: { sessionId }, forceNew: true, transports: ['websocket'] });
    const invalidPromise = waitFor(socket, 'session.invalid');
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });

    const invalidPayload = await invalidPromise;
    assert.equal(invalidPayload.sessionId, sessionId);

    // The socket authenticated as a guest, so an authenticated action like
    // call.initiate is rejected instead of silently using the stale identity.
    const ack = await emitWithAck(socket, 'call.initiate', { version: 1, calleeId: 'user-bob' });
    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, 'unauthorized');
  } finally {
    await teardown(socket);
  }
});

test('socket connect: a fresh guest (no sessionId presented) does not emit session.invalid', async () => {
  const { url, teardown } = await startServer();
  let socket;
  try {
    socket = await connect(url, { userId: 'user-guest' });

    let receivedInvalid = false;
    socket.on('session.invalid', () => {
      receivedInvalid = true;
    });

    // Give any (incorrect) emission a moment to arrive.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(receivedInvalid, false);
  } finally {
    await teardown(socket);
  }
});

test('POST /calls: rejects an expired session', async () => {
  const { url, teardown } = await startServer({ sessionTtlMs: 100 });
  try {
    const aliceSession = (await postJson(url, '/session', { userId: 'user-alice' })).body.sessionId;
    await createSession(url, 'user-bob');

    await new Promise((resolve) => setTimeout(resolve, 200));

    const res = await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

test('session without TTL has no expiresAt', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await postJson(url, '/session', { userId: 'user-alice' });
    assert.equal(res.status, 201);
    assert.equal(res.body.expiresAt, null);
  } finally {
    await teardown();
  }
});

// ─── Session refresh ──────────────────────────────────────────────────────────

test('POST /session/refresh: returns a new session and invalidates the old one', async () => {
  const { url, teardown } = await startServer();
  try {
    const created = await postJson(url, '/session', { userId: 'user-alice' });
    assert.equal(created.status, 201);
    const oldSessionId = created.body.sessionId;

    const refresh = await postJson(url, '/session/refresh', {}, oldSessionId);
    assert.equal(refresh.status, 200);
    const newSessionId = refresh.body.sessionId;
    assert.notEqual(newSessionId, oldSessionId);
    assert.equal(refresh.body.userId, 'user-alice');

    // Old session is now invalid.
    const oldCheck = await getJson(url, '/session', oldSessionId);
    assert.equal(oldCheck.status, 401);

    // New session is valid.
    const newCheck = await getJson(url, '/session', newSessionId);
    assert.equal(newCheck.status, 200);
    assert.equal(newCheck.body.userId, 'user-alice');
  } finally {
    await teardown();
  }
});

test('POST /session/refresh: returns 401 for an invalid session', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await postJson(url, '/session/refresh', {}, 'bad-session');
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

test('POST /session/refresh: refreshed session extends TTL', async () => {
  const { url, teardown } = await startServer({ sessionTtlMs: 300 });
  try {
    const created = await postJson(url, '/session', { userId: 'user-alice' });
    const oldSessionId = created.body.sessionId;

    // Wait 150 ms – old session still valid but halfway through TTL.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const refresh = await postJson(url, '/session/refresh', {}, oldSessionId);
    assert.equal(refresh.status, 200);
    const newSessionId = refresh.body.sessionId;

    // New session has a future expiresAt.
    const newExpiresAt = new Date(refresh.body.expiresAt).getTime();
    assert.ok(newExpiresAt > Date.now(), 'new session should not be expired');

    // Wait another 200 ms – old session would be expired but new one isn't yet.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const check = await getJson(url, '/session', newSessionId);
    assert.equal(check.status, 200);
  } finally {
    await teardown();
  }
});

// ─── Audit log ────────────────────────────────────────────────────────────────

test('GET /audit-log: returns 401 without a valid session', async () => {
  const { url, teardown } = await startServer();
  try {
    const res = await getJson(url, '/audit-log', 'bad-session');
    assert.equal(res.status, 401);
  } finally {
    await teardown();
  }
});

test("GET /audit-log: blocked call attempt appears in the caller's audit log", async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const bobSession = await createSession(url, 'user-bob');

    // Bob blocks Alice.
    await postJson(url, '/blocks', { blockeeId: 'user-alice' }, bobSession);

    // Alice attempts to call Bob.
    await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);

    const log = await getJson(url, '/audit-log', aliceSession);
    assert.equal(log.status, 200);
    const blockedEntry = log.body.entries.find((e) => e.event === 'call.blocked');
    assert.ok(blockedEntry, 'audit log should contain a call.blocked entry');
    assert.equal(blockedEntry.actor, 'user-alice');
    assert.equal(blockedEntry.target, 'user-bob');
    assert.equal(blockedEntry.outcome, 'rejected');
  } finally {
    await teardown();
  }
});

test("GET /audit-log: rate-limited call attempt appears in the caller's audit log", async () => {
  const { url, teardown } = await startServer({ callRateLimit: 1, callRateWindowMs: 60_000 });
  try {
    const aliceSession = await createSession(url, 'user-alice');
    await createSession(url, 'user-bob');

    await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession);
    await postJson(url, '/calls', { calleeId: 'user-bob' }, aliceSession); // rate-limited

    const log = await getJson(url, '/audit-log', aliceSession);
    assert.equal(log.status, 200);
    const rateLimitEntry = log.body.entries.find((e) => e.event === 'call.rate_limited');
    assert.ok(rateLimitEntry, 'audit log should contain a call.rate_limited entry');
    assert.equal(rateLimitEntry.actor, 'user-alice');
    assert.equal(rateLimitEntry.outcome, 'rejected');
  } finally {
    await teardown();
  }
});

test("GET /audit-log: block management events appear in the blocker's audit log", async () => {
  const { url, teardown } = await startServer();
  try {
    const aliceSession = await createSession(url, 'user-alice');

    await postJson(url, '/blocks', { blockeeId: 'user-bob' }, aliceSession);
    await deleteJson(url, '/blocks/user-bob', aliceSession);

    const log = await getJson(url, '/audit-log', aliceSession);
    assert.equal(log.status, 200);

    const addedEntry = log.body.entries.find((e) => e.event === 'block.added');
    assert.ok(addedEntry, 'audit log should contain block.added');
    assert.equal(addedEntry.actor, 'user-alice');
    assert.equal(addedEntry.target, 'user-bob');

    const removedEntry = log.body.entries.find((e) => e.event === 'block.removed');
    assert.ok(removedEntry, 'audit log should contain block.removed');
    assert.equal(removedEntry.actor, 'user-alice');
    assert.equal(removedEntry.target, 'user-bob');
  } finally {
    await teardown();
  }
});

test("GET /audit-log: session refresh appears in the user's audit log", async () => {
  const { url, teardown } = await startServer();
  try {
    const created = await postJson(url, '/session', { userId: 'user-alice' });
    const oldSessionId = created.body.sessionId;

    const refresh = await postJson(url, '/session/refresh', {}, oldSessionId);
    const newSessionId = refresh.body.sessionId;

    const log = await getJson(url, '/audit-log', newSessionId);
    assert.equal(log.status, 200);
    const refreshEntry = log.body.entries.find((e) => e.event === 'session.refreshed');
    assert.ok(refreshEntry, 'audit log should contain session.refreshed');
    assert.equal(refreshEntry.actor, 'user-alice');
    assert.equal(refreshEntry.outcome, 'success');
  } finally {
    await teardown();
  }
});

test('GET /audit-log: user only sees their own events', async () => {
  const { url, teardown } = await startServer({ callRateLimit: 1, callRateWindowMs: 60_000 });
  try {
    const aliceSession = await createSession(url, 'user-alice');
    const bobSession = await createSession(url, 'user-bob');
    await createSession(url, 'user-carol');

    // Alice exhausts her rate limit.
    await postJson(url, '/calls', { calleeId: 'user-carol' }, aliceSession);
    await postJson(url, '/calls', { calleeId: 'user-carol' }, aliceSession);

    // Bob's audit log should be empty (no events involving Bob yet).
    const bobLog = await getJson(url, '/audit-log', bobSession);
    assert.equal(bobLog.status, 200);
    const rateLimitEvents = bobLog.body.entries.filter((e) => e.event === 'call.rate_limited');
    assert.equal(rateLimitEvents.length, 0, "Bob should not see Alice's rate-limit events");
  } finally {
    await teardown();
  }
});
