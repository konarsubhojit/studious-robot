'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/index.js');

async function startServer() {
  const server = createServer();
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

function waitFor(socket, event, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
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

async function createSession(url, userId, deviceId = `device-${userId}`) {
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
