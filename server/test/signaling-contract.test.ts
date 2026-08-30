import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../src/index.ts';
import { closeTestServer, listenOnRandomPort, postJson } from './helpers.ts';

async function startServer() {
  const server = createServer();
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  /** @param clients */
  async function teardown(...clients: import('socket.io-client').Socket[]) {
    clients.forEach((client) => client.disconnect());
    await closeTestServer(server);
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

function waitFor(socket: import('socket.io-client').Socket, event: string, timeoutMs: number = 1000): Promise<any> {
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

test('call.initiate notifies the callee and caller with versioned call events', async () => {
  const { url, teardown } = await startServer();
  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');
  const [caller, callee] = await Promise.all([
    connect(url, { sessionId: callerSession }),
    connect(url, { sessionId: calleeSession }),
  ]);

  try {
    const incomingPromise = waitFor(callee, 'call.incoming');
    const ringingPromise = waitFor(caller, 'call.ringing');
    const callerStatePromise = waitFor(caller, 'call.state_changed');
    const calleeStatePromise = waitFor(callee, 'call.state_changed');

    const ack = await emitWithAck(caller, 'call.initiate', {
      version: 1,
      calleeId: 'user-bob',
    });

    assert.equal(ack.ok, true);
    assert.equal(ack.version, 1);
    assert.equal(ack.event, 'call.initiate');
    assert.equal(ack.call.status, 'ringing');

    const incoming = await incomingPromise;
    assert.equal(incoming.version, 1);
    assert.equal(incoming.callId, ack.call.callId);
    assert.equal(incoming.call.callerId, 'user-alice');
    assert.equal(incoming.call.calleeId, 'user-bob');

    const ringing = await ringingPromise;
    assert.equal(ringing.version, 1);
    assert.equal(ringing.callId, ack.call.callId);
    assert.equal(ringing.call.status, 'ringing');

    const callerState = await callerStatePromise;
    assert.equal(callerState.version, 1);
    assert.equal(callerState.previousStatus, null);
    assert.equal(callerState.status, 'ringing');
    assert.equal(callerState.actor, 'user-alice');

    const calleeState = await calleeStatePromise;
    assert.equal(calleeState.version, 1);
    assert.equal(calleeState.callId, ack.call.callId);
    assert.equal(calleeState.status, 'ringing');
  } finally {
    await teardown(caller, callee);
  }
});

test('call.ringing tells the caller whether the callee rang or was only pushed', async () => {
  const { url, teardown } = await startServer();
  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');
  const intruderSession = await createSession(url, 'user-carol');
  // The callee deliberately has no socket yet: every device is asleep, so the
  // call can only be delivered by a push that has to wake one.
  const caller = await connect(url, { sessionId: callerSession });
  let callee: import('socket.io-client').Socket | null = null;
  let intruder: import('socket.io-client').Socket | null = null;

  try {
    const ringingPromise = waitFor(caller, 'call.ringing');
    const ack = await emitWithAck(caller, 'call.initiate', {
      version: 1,
      calleeId: 'user-bob',
    });
    assert.equal(ack.ok, true);

    const pushRinging = await ringingPromise;
    assert.equal(pushRinging.delivery, 'push');

    // The pushed device wakes and acknowledges: the caller is owed the news
    // that the push landed, so the screen stops saying "waking their phone".
    const wokeRingingPromise = waitFor(caller, 'call.ringing');
    callee = await connect(url, { sessionId: calleeSession });
    const ackResult = await emitWithAck(callee, 'call.incoming.ack', {
      version: 1,
      callId: ack.call.callId,
      deviceId: 'device-user-bob',
    });
    assert.equal(ackResult.ok, true);

    const wokeRinging = await wokeRingingPromise;
    assert.equal(wokeRinging.callId, ack.call.callId);
    assert.equal(wokeRinging.delivery, 'ringing');

    // Nobody else may claim the callee's phone is ringing, even knowing the id.
    intruder = await connect(url, { sessionId: intruderSession });
    const forged = emitWithAck(intruder, 'call.incoming.ack', {
      version: 1,
      callId: ack.call.callId,
      deviceId: 'device-user-carol',
    });
    await assert.rejects(
      Promise.all([forged, waitFor(caller, 'call.ringing', 250)]),
      /Timeout waiting for "call.ringing"/
    );
  } finally {
    await teardown(caller, ...(callee ? [callee] : []), ...(intruder ? [intruder] : []));
  }
});

test('accepted calls relay rtc.offer/answer/candidate only to the other participant', async () => {
  const { url, teardown } = await startServer();
  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');
  const intruderSession = await createSession(url, 'user-carol');
  const [caller, callee, intruder] = await Promise.all([
    connect(url, { sessionId: callerSession }),
    connect(url, { sessionId: calleeSession }),
    connect(url, { sessionId: intruderSession }),
  ]);

  try {
    const incomingPromise = waitFor(callee, 'call.incoming');
    const ringingPromise = waitFor(caller, 'call.ringing');
    const callerRingingStatePromise = waitFor(caller, 'call.state_changed');
    const calleeRingingStatePromise = waitFor(callee, 'call.state_changed');
    const initiateAck = await emitWithAck(caller, 'call.initiate', {
      version: 1,
      calleeId: 'user-bob',
    });
    const callId = initiateAck.call.callId;
    await Promise.all([
      incomingPromise,
      ringingPromise,
      callerRingingStatePromise,
      calleeRingingStatePromise,
    ]);

    const acceptEventPromise = waitFor(caller, 'call.accept');
    const acceptCallerStatePromise = waitFor(caller, 'call.state_changed');
    const acceptCalleeStatePromise = waitFor(callee, 'call.state_changed');
    const acceptAck = await emitWithAck(callee, 'call.accept', {
      version: 1,
      callId,
    });

    assert.equal(acceptAck.ok, true);
    assert.equal(acceptAck.call.status, 'accepted');

    const acceptEvent = await acceptEventPromise;
    assert.equal(acceptEvent.version, 1);
    assert.equal(acceptEvent.callId, callId);
    assert.equal(acceptEvent.call.status, 'accepted');

    const acceptCallerState = await acceptCallerStatePromise;
    assert.equal(acceptCallerState.status, 'accepted');
    assert.equal(acceptCallerState.previousStatus, 'ringing');

    const acceptCalleeState = await acceptCalleeStatePromise;
    assert.equal(acceptCalleeState.status, 'accepted');

    let intruderSawOffer = false;
    intruder.once('rtc.offer', () => {
      intruderSawOffer = true;
    });

    const offerPromise = waitFor(callee, 'rtc.offer');
    const mediaCallerStatePromise = waitFor(caller, 'call.state_changed');
    const mediaCalleeStatePromise = waitFor(callee, 'call.state_changed');
    const offerAck = await emitWithAck(caller, 'rtc.offer', {
      version: 1,
      callId,
      sdp: { type: 'offer', sdp: 'mock-offer' },
    });

    assert.equal(offerAck.ok, true);
    assert.equal(offerAck.callId, callId);

    const offer = await offerPromise;
    assert.equal(offer.version, 1);
    assert.equal(offer.callId, callId);
    assert.equal(offer.fromUserId, 'user-alice');
    assert.deepEqual(offer.sdp, { type: 'offer', sdp: 'mock-offer' });

    const mediaCallerState = await mediaCallerStatePromise;
    assert.equal(mediaCallerState.status, 'connecting_media');
    assert.equal(mediaCallerState.previousStatus, 'accepted');

    const mediaCalleeState = await mediaCalleeStatePromise;
    assert.equal(mediaCalleeState.status, 'connecting_media');

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(intruderSawOffer, false);

    const answerPromise = waitFor(caller, 'rtc.answer');
    const answerAck = await emitWithAck(callee, 'rtc.answer', {
      version: 1,
      callId,
      sdp: { type: 'answer', sdp: 'mock-answer' },
    });
    assert.equal(answerAck.ok, true);

    const answer = await answerPromise;
    assert.equal(answer.version, 1);
    assert.equal(answer.callId, callId);
    assert.equal(answer.fromUserId, 'user-bob');
    assert.deepEqual(answer.sdp, { type: 'answer', sdp: 'mock-answer' });

    const candidatePromise = waitFor(callee, 'rtc.candidate');
    const candidateAck = await emitWithAck(caller, 'rtc.candidate', {
      version: 1,
      callId,
      candidate: { candidate: 'mock-candidate' },
    });
    assert.equal(candidateAck.ok, true);

    const candidate = await candidatePromise;
    assert.equal(candidate.version, 1);
    assert.equal(candidate.callId, callId);
    assert.equal(candidate.fromUserId, 'user-alice');
    assert.deepEqual(candidate.candidate, { candidate: 'mock-candidate' });

    // Screen-share state relay reuses the same generic RTC-relay plumbing.
    const mediaStatePromise = waitFor(callee, 'call.media-state');
    const mediaStateAck = await emitWithAck(caller, 'call.media-state', {
      version: 1,
      callId,
      mediaState: { isScreenSharing: true },
    });
    assert.equal(mediaStateAck.ok, true);

    const mediaState = await mediaStatePromise;
    assert.equal(mediaState.version, 1);
    assert.equal(mediaState.callId, callId);
    assert.equal(mediaState.fromUserId, 'user-alice');
    assert.deepEqual(mediaState.mediaState, { isScreenSharing: true });
  } finally {
    await teardown(caller, callee, intruder);
  }
});

test('unauthorized, invalid-version, forbidden, and stale rtc events are rejected cleanly', async () => {
  const { url, teardown } = await startServer();
  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');
  const intruderSession = await createSession(url, 'user-carol');
  const [guest, caller, callee, intruder] = await Promise.all([
    connect(url),
    connect(url, { sessionId: callerSession }),
    connect(url, { sessionId: calleeSession }),
    connect(url, { sessionId: intruderSession }),
  ]);

  try {
    const unauthorized = await emitWithAck(guest, 'call.initiate', {
      version: 1,
      calleeId: 'user-bob',
    });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.error.code, 'unauthorized');

    const invalidVersion = await emitWithAck(caller, 'call.initiate', {
      version: 2,
      calleeId: 'user-bob',
    });
    assert.equal(invalidVersion.ok, false);
    assert.equal(invalidVersion.error.code, 'unsupported_version');

    const incomingPromise = waitFor(callee, 'call.incoming');
    const ringingPromise = waitFor(caller, 'call.ringing');
    const callerRingingStatePromise = waitFor(caller, 'call.state_changed');
    const calleeRingingStatePromise = waitFor(callee, 'call.state_changed');
    const initiated = await emitWithAck(caller, 'call.initiate', {
      version: 1,
      calleeId: 'user-bob',
    });
    const callId = initiated.call.callId;
    await Promise.all([
      incomingPromise,
      ringingPromise,
      callerRingingStatePromise,
      calleeRingingStatePromise,
    ]);

    const staleOffer = await emitWithAck(caller, 'rtc.offer', {
      version: 1,
      callId,
      sdp: { type: 'offer', sdp: 'too-early' },
    });
    assert.equal(staleOffer.ok, false);
    assert.equal(staleOffer.error.code, 'stale_call_state');

    const forbiddenOffer = await emitWithAck(intruder, 'rtc.offer', {
      version: 1,
      callId,
      sdp: { type: 'offer', sdp: 'forbidden' },
    });
    assert.equal(forbiddenOffer.ok, false);
    assert.equal(forbiddenOffer.error.code, 'forbidden');

    const acceptEventPromise = waitFor(caller, 'call.accept');
    const acceptCallerStatePromise = waitFor(caller, 'call.state_changed');
    const acceptCalleeStatePromise = waitFor(callee, 'call.state_changed');
    await emitWithAck(callee, 'call.accept', {
      version: 1,
      callId,
    });
    await Promise.all([acceptEventPromise, acceptCallerStatePromise, acceptCalleeStatePromise]);

    const endEventPromise = waitFor(caller, 'call.end');
    const endCallerStatePromise = waitFor(caller, 'call.state_changed');
    const endCalleeStatePromise = waitFor(callee, 'call.state_changed');
    await emitWithAck(caller, 'call.end', {
      version: 1,
      callId,
    });
    await Promise.all([endEventPromise, endCallerStatePromise, endCalleeStatePromise]);

    const endedCandidate = await emitWithAck(callee, 'rtc.candidate', {
      version: 1,
      callId,
      candidate: { candidate: 'after-end' },
    });
    assert.equal(endedCandidate.ok, false);
    assert.equal(endedCandidate.error.code, 'stale_call_state');
  } finally {
    await teardown(guest, caller, callee, intruder);
  }
});
