import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { CLIENT_EVENTS, parseEventPayload, SERVER_EVENTS, SIGNALING_VERSION } from '../../shared/index.ts';
import { createServer } from '../src/index.ts';
import { closeTestServer, listenOnRandomPort, postJson } from './helpers.ts';

async function startServer(options: Parameters<typeof createServer>[0] = {}) {
  const server = createServer(options);
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

test('v3 participant and peer-addressed RTC events round-trip through both schemas', () => {
  const callId = 'contract-call';
  const peerId = 'contract-peer';
  const clientEvents = [
    [CLIENT_EVENTS.RTC_OFFER, { version: SIGNALING_VERSION, callId, peerId, sdp: { type: 'offer' } }],
    [CLIENT_EVENTS.RTC_ANSWER, { version: SIGNALING_VERSION, callId, peerId, sdp: { type: 'answer' } }],
    [CLIENT_EVENTS.RTC_ICE, { version: SIGNALING_VERSION, callId, peerId, candidate: { candidate: 'ice' } }],
  ] as const;
  for (const [event, payload] of clientEvents) {
    const result = parseEventPayload(event, payload);
    assert.equal(result.success, true);
    if (result.success) assert.deepEqual(result.data, payload);
  }

  const serverRtcEvents = [
    [SERVER_EVENTS.RTC_OFFER, { version: SIGNALING_VERSION, callId, peerId, fromUserId: peerId, sdp: { type: 'offer' } }],
    [SERVER_EVENTS.RTC_ANSWER, { version: SIGNALING_VERSION, callId, peerId, fromUserId: peerId, sdp: { type: 'answer' } }],
    [SERVER_EVENTS.RTC_ICE, { version: SIGNALING_VERSION, callId, peerId, fromUserId: peerId, candidate: { candidate: 'ice' } }],
  ] as const;
  for (const [event, payload] of serverRtcEvents) {
    const result = parseEventPayload(event, payload, 'server');
    assert.equal(result.success, true);
    if (result.success) assert.deepEqual(result.data, payload);
  }

  for (const [event, state] of [
    [SERVER_EVENTS.CALL_PARTICIPANT_JOINED, 'joined'],
    [SERVER_EVENTS.CALL_PARTICIPANT_LEFT, 'left'],
  ] as const) {
    const payload = { version: SIGNALING_VERSION, callId, participantId: peerId, state };
    const result = parseEventPayload(event, payload, 'server');
    assert.equal(result.success, true);
    if (result.success) assert.deepEqual(result.data, payload);
  }

  const incoming = parseEventPayload(SERVER_EVENTS.CALL_INCOMING, {
    version: SIGNALING_VERSION,
    callId,
    call: {
      callId,
      callerId: 'contract-caller',
      calleeId: peerId,
      status: 'ringing',
      participants: [
        { userId: 'contract-caller', state: 'joined' },
        { userId: peerId, state: 'ringing' },
      ],
    },
  }, 'server');
  assert.equal(incoming.success, true);
});

/**
 * @param url - Base URL of the server under test.
 * @returns the created session id
 */
async function createSession(url: string, userId: string, deviceId: string = `device-${userId}`): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

test('call.stats accepts active-call participants and rejects malformed or unrelated reports', async () => {
  const { url, teardown } = await startServer({
    callStatsRateLimit: 2,
    callStatsRateWindowMs: 60_000,
  });
  const callerSession = await createSession(url, 'stats-alice');
  const calleeSession = await createSession(url, 'stats-bob');
  const outsiderSession = await createSession(url, 'stats-carol');
  const [caller, callee, outsider] = await Promise.all([
    connect(url, { sessionId: callerSession }),
    connect(url, { sessionId: calleeSession }),
    connect(url, { sessionId: outsiderSession }),
  ]);

  try {
    const initiated = await emitWithAck(caller, 'call.initiate', {
      version: SIGNALING_VERSION,
      calleeId: 'stats-bob',
    });
    const accepted = await emitWithAck(callee, 'call.accept', {
      version: SIGNALING_VERSION,
      callId: initiated.call.callId,
    });
    assert.equal(accepted.ok, true);

    const sample = {
      version: SIGNALING_VERSION,
      callId: initiated.call.callId,
      rttMs: 85,
      jitterMs: 12,
      packetLossPercent: 0.5,
      bitrateBps: 48_000,
      codec: 'opus',
    };
    const acceptedSample = await emitWithAck(caller, 'call.stats', sample);
    assert.equal(acceptedSample.ok, true);
    assert.equal(acceptedSample.callId, initiated.call.callId);

    const invalidSample = await emitWithAck(caller, 'call.stats', {
      ...sample,
      packetLossPercent: -1,
    });
    assert.equal(invalidSample.error.code, 'bad_request');

    const unrelatedSample = await emitWithAck(outsider, 'call.stats', sample);
    assert.equal(unrelatedSample.error.code, 'forbidden');

    const rateLimited = await emitWithAck(caller, 'call.stats', sample);
    assert.equal(rateLimited.error.code, 'rate_limited');
  } finally {
    await teardown(caller, callee, outsider);
  }
});
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
      version: 2,
      calleeId: 'user-bob',
      mediaType: 'audio',
    });

    assert.equal(ack.ok, true);
    assert.equal(ack.version, 2);
    assert.equal(ack.event, 'call.initiate');
    assert.equal(ack.call.status, 'ringing');
    assert.equal(ack.call.mediaType, 'audio');

    const incoming = await incomingPromise;
    assert.equal(incoming.version, 2);
    assert.equal(incoming.callId, ack.call.callId);
    assert.equal(incoming.call.callerId, 'user-alice');
    assert.equal(incoming.call.calleeId, 'user-bob');
    assert.equal(incoming.call.mediaType, 'audio');

    const ringing = await ringingPromise;
    assert.equal(ringing.version, 2);
    assert.equal(ringing.callId, ack.call.callId);
    assert.equal(ringing.call.status, 'ringing');

    const callerState = await callerStatePromise;
    assert.equal(callerState.version, 2);
    assert.equal(callerState.previousStatus, null);
    assert.equal(callerState.status, 'ringing');
    assert.equal(callerState.actor, 'user-alice');

    const calleeState = await calleeStatePromise;
    assert.equal(calleeState.version, 2);
    assert.equal(calleeState.callId, ack.call.callId);
    assert.equal(calleeState.status, 'ringing');
  } finally {
    await teardown(caller, callee);
  }
});

test('a v2 client keeps receiving the previous call and RTC payload shapes', async () => {
  const { url, teardown } = await startServer();
  const callerSession = await createSession(url, 'legacy-alice');
  const calleeSession = await createSession(url, 'legacy-bob');
  const [caller, callee] = await Promise.all([
    connect(url, { sessionId: callerSession }),
    connect(url, { sessionId: calleeSession }),
  ]);

  try {
    const incomingPromise = waitFor(callee, 'call.incoming');
    const initiated = await emitWithAck(caller, 'call.initiate', {
      version: 2,
      calleeId: 'legacy-bob',
    });
    assert.equal(initiated.ok, true);
    assert.equal(initiated.version, 2);
    const incoming = await incomingPromise;
    assert.equal(incoming.version, 2);
    assert.equal(incoming.call.callerId, 'legacy-alice');
    assert.equal(incoming.call.calleeId, 'legacy-bob');

    const accepted = await emitWithAck(callee, 'call.accept', {
      version: 2,
      callId: initiated.call.callId,
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.version, 2);

    const offerPromise = waitFor(callee, 'rtc.offer');
    const offerAck = await emitWithAck(caller, 'rtc.offer', {
      version: 2,
      callId: initiated.call.callId,
      sdp: { type: 'offer', sdp: 'legacy-offer' },
    });
    assert.equal(offerAck.ok, true);
    assert.equal(offerAck.version, 2);
    const offer = await offerPromise;
    assert.equal(offer.version, 2);
    assert.equal(offer.fromUserId, 'legacy-alice');
    assert.deepEqual(offer.sdp, { type: 'offer', sdp: 'legacy-offer' });

    const messagePromise = waitFor(callee, 'message.received');
    const messageAck = await emitWithAck(caller, 'message.send', {
      version: 2,
      recipientId: 'legacy-bob',
      body: 'legacy message',
    });
    assert.equal(messageAck.ok, true);
    assert.equal(messageAck.version, 2);
    const message = await messagePromise;
    assert.equal(message.version, 2);
    assert.equal(message.message.body, 'legacy message');
  } finally {
    await teardown(caller, callee);
  }
});

test('v3 RTC offers addressed outside the participant set are rejected', async () => {
  const { url, teardown } = await startServer();
  const callerSession = await createSession(url, 'peer-alice');
  const calleeSession = await createSession(url, 'peer-bob');
  const [caller, callee] = await Promise.all([
    connect(url, { sessionId: callerSession, signalingVersion: SIGNALING_VERSION }),
    connect(url, { sessionId: calleeSession, signalingVersion: SIGNALING_VERSION }),
  ]);

  try {
    const incomingPromise = waitFor(callee, 'call.incoming');
    const initiated = await emitWithAck(caller, 'call.initiate', {
      version: SIGNALING_VERSION,
      calleeId: 'peer-bob',
    });
    assert.deepEqual(initiated.call.participants, [
      { userId: 'peer-alice', state: 'joined' },
      { userId: 'peer-bob', state: 'ringing' },
    ]);
    const incoming = await incomingPromise;
    assert.deepEqual(incoming.call.participants, [
      { userId: 'peer-alice', state: 'joined' },
      { userId: 'peer-bob', state: 'ringing' },
    ]);
    const callerJoinedPromise = waitFor(caller, 'call.participant.joined');
    const calleeJoinedPromise = waitFor(callee, 'call.participant.joined');
    const accepted = await emitWithAck(callee, 'call.accept', {
      version: SIGNALING_VERSION,
      callId: initiated.call.callId,
    });
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.call.participants, [
      { userId: 'peer-alice', state: 'joined' },
      { userId: 'peer-bob', state: 'joined' },
    ]);
    const [callerJoined, calleeJoined] = await Promise.all([callerJoinedPromise, calleeJoinedPromise]);
    assert.equal(callerJoined.state, 'joined');
    assert.equal(calleeJoined.participantId, 'peer-bob');

    const rejected = await emitWithAck(caller, 'rtc.offer', {
      version: SIGNALING_VERSION,
      callId: initiated.call.callId,
      peerId: 'peer-carol',
      sdp: { type: 'offer', sdp: 'forbidden-target' },
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'forbidden');

    const callerLeftPromise = waitFor(caller, 'call.participant.left');
    const calleeLeftPromise = waitFor(callee, 'call.participant.left');
    await emitWithAck(caller, 'call.end', {
      version: SIGNALING_VERSION,
      callId: initiated.call.callId,
    });
    const [callerLeft, calleeLeft] = await Promise.all([callerLeftPromise, calleeLeftPromise]);
    assert.equal(callerLeft.state, 'left');
    assert.equal(calleeLeft.state, 'left');
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
      version: 2,
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
      version: 2,
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
      version: 2,
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
      version: 2,
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
      version: 2,
      callId,
    });

    assert.equal(acceptAck.ok, true);
    assert.equal(acceptAck.call.status, 'accepted');

    const acceptEvent = await acceptEventPromise;
    assert.equal(acceptEvent.version, 2);
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
      version: 2,
      callId,
      sdp: { type: 'offer', sdp: 'mock-offer' },
    });

    assert.equal(offerAck.ok, true);
    assert.equal(offerAck.callId, callId);

    const offer = await offerPromise;
    assert.equal(offer.version, 2);
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
      version: 2,
      callId,
      sdp: { type: 'answer', sdp: 'mock-answer' },
    });
    assert.equal(answerAck.ok, true);

    const answer = await answerPromise;
    assert.equal(answer.version, 2);
    assert.equal(answer.callId, callId);
    assert.equal(answer.fromUserId, 'user-bob');
    assert.deepEqual(answer.sdp, { type: 'answer', sdp: 'mock-answer' });

    const candidatePromise = waitFor(callee, 'rtc.candidate');
    const candidateAck = await emitWithAck(caller, 'rtc.candidate', {
      version: 2,
      callId,
      candidate: { candidate: 'mock-candidate' },
    });
    assert.equal(candidateAck.ok, true);

    const candidate = await candidatePromise;
    assert.equal(candidate.version, 2);
    assert.equal(candidate.callId, callId);
    assert.equal(candidate.fromUserId, 'user-alice');
    assert.deepEqual(candidate.candidate, { candidate: 'mock-candidate' });

    // Screen-share state relay reuses the same generic RTC-relay plumbing.
    const mediaStatePromise = waitFor(callee, 'call.media-state');
    const mediaStateAck = await emitWithAck(caller, 'call.media-state', {
      version: 2,
      callId,
      mediaState: { isScreenSharing: true },
    });
    assert.equal(mediaStateAck.ok, true);

    const mediaState = await mediaStatePromise;
    assert.equal(mediaState.version, 2);
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
      version: 2,
      calleeId: 'user-bob',
    });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.error.code, 'unauthorized');

    const invalidVersion = await emitWithAck(caller, 'call.initiate', {
      version: 1,
      calleeId: 'user-bob',
    });
    assert.equal(invalidVersion.ok, false);
    assert.equal(invalidVersion.error.code, 'unsupported_version');

    const incomingPromise = waitFor(callee, 'call.incoming');
    const ringingPromise = waitFor(caller, 'call.ringing');
    const callerRingingStatePromise = waitFor(caller, 'call.state_changed');
    const calleeRingingStatePromise = waitFor(callee, 'call.state_changed');
    const initiated = await emitWithAck(caller, 'call.initiate', {
      version: 2,
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
      version: 2,
      callId,
      sdp: { type: 'offer', sdp: 'too-early' },
    });
    assert.equal(staleOffer.ok, false);
    assert.equal(staleOffer.error.code, 'stale_call_state');

    const forbiddenOffer = await emitWithAck(intruder, 'rtc.offer', {
      version: 2,
      callId,
      sdp: { type: 'offer', sdp: 'forbidden' },
    });
    assert.equal(forbiddenOffer.ok, false);
    assert.equal(forbiddenOffer.error.code, 'forbidden');

    const acceptEventPromise = waitFor(caller, 'call.accept');
    const acceptCallerStatePromise = waitFor(caller, 'call.state_changed');
    const acceptCalleeStatePromise = waitFor(callee, 'call.state_changed');
    await emitWithAck(callee, 'call.accept', {
      version: 2,
      callId,
    });
    await Promise.all([acceptEventPromise, acceptCallerStatePromise, acceptCalleeStatePromise]);

    const endEventPromise = waitFor(caller, 'call.end');
    const endCallerStatePromise = waitFor(caller, 'call.state_changed');
    const endCalleeStatePromise = waitFor(callee, 'call.state_changed');
    await emitWithAck(caller, 'call.end', {
      version: 2,
      callId,
    });
    await Promise.all([endEventPromise, endCallerStatePromise, endCalleeStatePromise]);

    const endedCandidate = await emitWithAck(callee, 'rtc.candidate', {
      version: 2,
      callId,
      candidate: { candidate: 'after-end' },
    });
    assert.equal(endedCandidate.ok, false);
    assert.equal(endedCandidate.error.code, 'stale_call_state');
  } finally {
    await teardown(guest, caller, callee, intruder);
  }
});

test('an offer relayed to a peer with no sockets is counted, not silently acked', async () => {
  const server = await startServer();
  const { url, teardown } = server;
  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob');
  const [caller, callee] = await Promise.all([
    connect(url, { sessionId: callerSession }),
    connect(url, { sessionId: calleeSession }),
  ]);

  try {
    const incomingPromise = waitFor(callee, 'call.incoming');
    const initiateAck = await emitWithAck(caller, 'call.initiate', {
      version: 2,
      calleeId: 'user-bob',
    });
    const callId = initiateAck.call.callId;
    await incomingPromise;
    await emitWithAck(callee, 'call.accept', { version: 2, callId });

    // The callee vanishes — the exact shape of the incident this counter was
    // added for, where the relay fired into an empty room and acked `ok`.
    callee.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const offerAck = await emitWithAck(caller, 'rtc.offer', {
      version: 2,
      callId,
      sdp: { type: 'offer', sdp: 'mock-offer' },
    });
    // The ack is still `ok`: the server genuinely cannot fail this emit. What
    // changes is that the drop is now visible.
    assert.equal(offerAck.ok, true);

    const { counters } = server.getMetrics();
    assert.equal(counters.rtc_relays_offer, 1);
    assert.equal(counters.rtc_relays_no_recipient, 1);
  } finally {
    await teardown(caller, callee);
  }
});
