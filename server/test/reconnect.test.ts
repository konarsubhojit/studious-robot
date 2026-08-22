/**
 * Reconnect and network-handoff scenario tests.
 *
 * These tests verify that the server correctly handles socket disconnects and
 * reconnects during active calls.  Key invariants:
 *
 *  - A socket disconnect does NOT end an in-progress call.
 *  - A participant who reconnects with the same session can receive call events
 *    on their new socket.
 *  - The ringing-timeout worker fires regardless of whether the caller's socket
 *    is still connected.
 *  - When both participants have multiple simultaneous connections, all sockets
 *    for a user receive call notifications.
 *  - A full network-handoff (disconnect → new socket → ICE restart → call end)
 *    completes successfully.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../src/index.ts';
import { DEFAULT_RINGING_TIMEOUT_MS } from '../src/config.ts';
import { getJson, listenOnRandomPort, postJson } from './helpers.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startServer() {
  const server = createServer();
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  /** @param clients */
  async function teardown(...clients: (import('socket.io-client').Socket | undefined)[]) {
    clients.forEach((c) => c?.disconnect());
    server.httpServer.closeAllConnections?.();
    await new Promise((resolve) =>
      server.io.close(() => server.httpServer.close(() => resolve(undefined)))
    );
  }

  return { ...server, url, teardown };
}

/**
 * @param auth - Socket.IO handshake auth payload.
 */
function connect(url: string, auth?: Record<string, unknown>): Promise<import('socket.io-client').Socket> {
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

function waitFor(socket: import('socket.io-client').Socket, event: string, timeoutMs: number = 1500): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
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

/**
 * @param url - Base URL of the server under test.
 * @returns the created session id
 */
async function createSession(url: string, userId: string, deviceId: string = `device-${userId}`): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

/** Wait a short tick for async disconnect handlers to complete. */
function tick(ms = 60) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// ─── 1. Call state preserved on socket disconnect ────────────────────────────

test('reconnect: ringing call is preserved when the caller socket disconnects', async () => {
  const { url, getCall, teardown } = await startServer();

  const callerSession = await createSession(url, 'user-alice');
  await createSession(url, 'user-bob'); // register callee so call can reach ringing

  const caller = await connect(url, { sessionId: callerSession });

  try {
    const ack = await emitWithAck(caller, 'call.initiate', {
      version: 1,
      calleeId: 'user-bob',
    });
    assert.equal(ack.ok, true);
    const callId = ack.call.callId;
    assert.equal(ack.call.status, 'ringing');

    // Caller socket drops (network loss, app background, etc.).
    caller.disconnect();
    await tick();

    // The call must still be ringing – socket disconnect does not end a call.
    const call = getCall(callId);
    assert.equal(call?.status, 'ringing', 'call must remain ringing after socket disconnect');
    assert.equal(call?.endReason, null);
  } finally {
    await teardown();
  }
});

// ─── 2. Reconnected caller receives call events ───────────────────────────────

test('reconnect: caller receives call.state_changed after reconnecting during ringing', async () => {
  const { url, teardown } = await startServer();

  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');

  const caller1 = await connect(url, { sessionId: callerSession });

  let caller2;
  try {
    const ack = await emitWithAck(caller1, 'call.initiate', {
      version: 1,
      calleeId: 'user-bob',
    });
    const callId = ack.call.callId;

    // Simulate a brief network drop on the caller side.
    caller1.disconnect();
    await tick();

    // Caller reconnects with the same session (Socket.IO reconnect uses same auth).
    caller2 = await connect(url, { sessionId: callerSession });

    // Callee accepts via HTTP; reconnected caller must receive the state update.
    const stateChangedPromise = waitFor(caller2, 'call.state_changed');
    await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);

    const stateChanged = await stateChangedPromise;
    assert.equal(stateChanged.callId, callId);
    assert.equal(stateChanged.status, 'accepted');
    assert.equal(stateChanged.previousStatus, 'ringing');
  } finally {
    await teardown(caller2);
  }
});

// ─── 3. Ringing timeout fires even when caller is offline ─────────────────────

test('reconnect: ringing timeout fires and marks call missed even when caller is offline', async () => {
  const { url, getCall, tickRingingTimeouts, teardown } = await startServer();

  const callerSession = await createSession(url, 'user-alice');
  await createSession(url, 'user-bob');

  const caller = await connect(url, { sessionId: callerSession });

  try {
    const ack = await emitWithAck(caller, 'call.initiate', {
      version: 1,
      calleeId: 'user-bob',
    });
    const callId = ack.call.callId;

    // Caller goes offline before the callee responds.
    caller.disconnect();
    await tick();

    // Advance time past the ringing timeout (deterministic – no real wait).
    const transitioned = tickRingingTimeouts(Date.now() + DEFAULT_RINGING_TIMEOUT_MS + 1_000);
    assert.equal(transitioned, 1, 'call should be transitioned to missed');

    const call = getCall(callId);
    assert.equal(call?.status, 'missed');
    assert.equal(call?.endReason, 'timeout');
  } finally {
    await teardown();
  }
});

// ─── 4. Active call survives callee socket disconnect ─────────────────────────

test('reconnect: active call remains in RTC-active state after callee socket drops', async () => {
  const { url, getCall, teardown } = await startServer();

  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');

  const caller = await connect(url, { sessionId: callerSession });
  const callee1 = await connect(url, { sessionId: calleeSession });

  try {
    // Initiate and accept the call.
    const incomingPromise = waitFor(callee1, 'call.incoming');
    const ack = await emitWithAck(caller, 'call.initiate', { version: 1, calleeId: 'user-bob' });
    const callId = ack.call.callId;
    await incomingPromise;

    const acceptAck = await emitWithAck(callee1, 'call.accept', { version: 1, callId });
    assert.equal(acceptAck.call.status, 'accepted');

    // Exchange offer to move into connecting_media.
    const offerRelayed = waitFor(callee1, 'rtc.offer');
    await emitWithAck(caller, 'rtc.offer', {
      version: 1,
      callId,
      sdp: { type: 'offer', sdp: 'initial-offer' },
    });
    await offerRelayed;

    // Callee socket drops unexpectedly.
    callee1.disconnect();
    await tick();

    // The call must still be in an RTC-active state (not ended).
    const RTC_ACTIVE = new Set(['accepted', 'connecting_media', 'in_call']);
    const callAfterDrop = getCall(callId);
    assert.ok(
      RTC_ACTIVE.has(callAfterDrop?.status ?? ''),
      `call must remain RTC-active after socket drop, got: ${callAfterDrop?.status}`
    );
  } finally {
    await teardown(caller);
  }
});

// ─── 5. Reconnected participant can restart ICE ───────────────────────────────

test('reconnect: callee can send a new rtc.offer to restart ICE after reconnecting', async () => {
  const { url, teardown } = await startServer();

  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');

  const caller = await connect(url, { sessionId: callerSession });
  const callee1 = await connect(url, { sessionId: calleeSession });

  let callee2;
  try {
    // Bring call to connecting_media state.
    const incomingPromise = waitFor(callee1, 'call.incoming');
    const ack = await emitWithAck(caller, 'call.initiate', { version: 1, calleeId: 'user-bob' });
    const callId = ack.call.callId;
    await incomingPromise;

    await emitWithAck(callee1, 'call.accept', { version: 1, callId });

    const offerRelayed = waitFor(callee1, 'rtc.offer');
    await emitWithAck(caller, 'rtc.offer', {
      version: 1,
      callId,
      sdp: { type: 'offer', sdp: 'initial-offer' },
    });
    await offerRelayed;

    // Callee drops and reconnects.
    callee1.disconnect();
    await tick();

    callee2 = await connect(url, { sessionId: calleeSession });

    // Callee sends a new rtc.offer to restart ICE – caller must receive it.
    const iceRestartRelayed = waitFor(caller, 'rtc.offer');
    const iceRestartAck = await emitWithAck(callee2, 'rtc.offer', {
      version: 1,
      callId,
      sdp: { type: 'offer', sdp: 'ice-restart-offer' },
    });
    assert.equal(iceRestartAck.ok, true, 'ICE-restart offer must be accepted after reconnect');

    const relayed = await iceRestartRelayed;
    assert.deepEqual(relayed.sdp, { type: 'offer', sdp: 'ice-restart-offer' });
    assert.equal(relayed.fromUserId, 'user-bob');
  } finally {
    await teardown(caller, callee2);
  }
});

// ─── 6. Multiple simultaneous sockets receive call events ────────────────────

test('reconnect: all active sockets for a user receive call.incoming notification', async () => {
  const { url, teardown } = await startServer();

  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');

  // Callee has two simultaneously connected sockets (e.g., two devices).
  const caller = await connect(url, { sessionId: callerSession });
  const callee1 = await connect(url, { sessionId: calleeSession });
  const callee2 = await connect(url, { sessionId: calleeSession });

  try {
    const incoming1 = waitFor(callee1, 'call.incoming');
    const incoming2 = waitFor(callee2, 'call.incoming');

    const ack = await emitWithAck(caller, 'call.initiate', { version: 1, calleeId: 'user-bob' });
    assert.equal(ack.ok, true);

    // Both callee sockets must receive the incoming-call notification.
    const [inc1, inc2] = await Promise.all([incoming1, incoming2]);
    assert.equal(inc1.callId, ack.call.callId);
    assert.equal(inc2.callId, ack.call.callId);
    assert.equal(inc1.call.callerId, 'user-alice');
    assert.equal(inc2.call.callerId, 'user-alice');
  } finally {
    await teardown(caller, callee1, callee2);
  }
});

// ─── 7. Full network handoff: disconnect → reconnect → ICE restart → end ─────

test('network handoff: call completes cleanly after callee switches networks mid-call', async () => {
  const { url, getCall, teardown } = await startServer();

  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');

  const caller = await connect(url, { sessionId: callerSession });
  const calleeFirst = await connect(url, { sessionId: calleeSession });

  let calleeNew;
  try {
    // Step 1: Establish the call in connecting_media state.
    const incomingPromise = waitFor(calleeFirst, 'call.incoming');
    const ack = await emitWithAck(caller, 'call.initiate', { version: 1, calleeId: 'user-bob' });
    const callId = ack.call.callId;
    await incomingPromise;

    await emitWithAck(calleeFirst, 'call.accept', { version: 1, callId });

    const firstOfferRelayed = waitFor(calleeFirst, 'rtc.offer');
    await emitWithAck(caller, 'rtc.offer', {
      version: 1,
      callId,
      sdp: { type: 'offer', sdp: 'offer-before-handoff' },
    });
    await firstOfferRelayed;

    // Step 2: Callee loses connectivity (WiFi → cellular network switch).
    calleeFirst.disconnect();
    await tick();

    const callMidHandoff = getCall(callId);
    assert.ok(
      ['accepted', 'connecting_media', 'in_call'].includes(callMidHandoff?.status ?? ''),
      `expected active state during handoff, got: ${callMidHandoff?.status}`
    );

    // Step 3: Callee connects on the new network (new socket, same session).
    calleeNew = await connect(url, { sessionId: calleeSession });

    // Step 4: Callee restarts ICE by sending a fresh offer.
    const restartOfferRelayed = waitFor(caller, 'rtc.offer');
    const restartAck = await emitWithAck(calleeNew, 'rtc.offer', {
      version: 1,
      callId,
      sdp: { type: 'offer', sdp: 'ice-restart-after-handoff' },
    });
    assert.equal(restartAck.ok, true);
    await restartOfferRelayed;

    // Step 5: Caller answers the restart offer.
    const restartAnswerRelayed = waitFor(calleeNew, 'rtc.answer');
    const answerAck = await emitWithAck(caller, 'rtc.answer', {
      version: 1,
      callId,
      sdp: { type: 'answer', sdp: 'answer-after-handoff' },
    });
    assert.equal(answerAck.ok, true);
    await restartAnswerRelayed;

    // Step 6: Either party can end the call cleanly after the handoff.
    const endAck = await emitWithAck(caller, 'call.end', { version: 1, callId });
    assert.equal(endAck.ok, true);

    const finalCall = getCall(callId);
    assert.equal(finalCall?.status, 'ended');
    assert.equal(finalCall?.endReason, 'ended');
  } finally {
    await teardown(caller, calleeNew);
  }
});

// ─── 8. Offline callee: ringing state when callee has no active socket ────────

test('offline callee: call enters ringing state and HTTP polling can poll its status', async () => {
  const { url, getCall, tickRingingTimeouts, teardown } = await startServer();

  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');
  // Callee has a session but no live WebSocket connection.

  const caller = await connect(url, { sessionId: callerSession });

  try {
    const ack = await emitWithAck(caller, 'call.initiate', { version: 1, calleeId: 'user-bob' });
    assert.equal(ack.ok, true);
    assert.equal(ack.call.status, 'ringing');

    const callId = ack.call.callId;

    // Simulate callee polling – they can see the call via HTTP.
    const polled = await getJson(url, `/calls/${callId}`, calleeSession);
    assert.equal(polled.status, 200);
    const polledBody = polled.body;
    assert.equal(polledBody.status, 'ringing');

    // Callee accepts via HTTP (e.g., from a background task or polling).
    const acceptRes = await postJson(url, `/calls/${callId}/accept`, {}, calleeSession);
    assert.equal(acceptRes.status, 200);
    const accepted = acceptRes.body;
    assert.equal(accepted.status, 'accepted');

    // Ringing timeout must not re-transition the now-accepted call while it is
    // still inside the media-connect window.
    const transitioned = tickRingingTimeouts(Date.now() + 1_000);
    assert.equal(transitioned, 0, 'accepted call must not be re-transitioned to missed');

    const call = getCall(callId);
    assert.equal(call?.status, 'accepted');
  } finally {
    await teardown(caller);
  }
});
