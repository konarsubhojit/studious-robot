#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

const CLIENT_EVENTS = Object.freeze({
  CALL_ACCEPT: 'call.accept',
  CALL_CONNECTED: 'call.connected',
  CALL_DECLINE: 'call.decline',
  CALL_END: 'call.end',
  CALL_INITIATE: 'call.initiate',
  CONVERSATION_CALL_ACCEPT: 'conversation.call.accept',
  CONVERSATION_CALL_DECLINE: 'conversation.call.decline',
  CONVERSATION_CALL_LEAVE: 'conversation.call.leave',
  CONVERSATION_CALL_START: 'conversation.call.start',
  MESSAGE_SEND: 'message.send',
  RTC_ANSWER: 'rtc.answer',
  RTC_OFFER: 'rtc.offer',
});
const SERVER_EVENTS = Object.freeze({
  CALL_INCOMING: 'call.incoming',
  MESSAGE_RECEIVED: 'message.received',
  SERVER_DRAINING: 'server.draining',
  SESSION_INVALID: 'session.invalid',
  SIGNALING_ERROR: 'signaling.error',
});
const SIGNALING_VERSION = 3;
const REPORT_INTERVAL_MS = 15_000;
const SWEEP_INTERVAL_MS = 5_000;
const RAMP_BATCH_INTERVAL_MS = 1_000;
const LATENCY_SAMPLE_LIMIT = 10_000;
const CALL_RING_CLEANUP_MS = 130_000;

const DEFAULTS = Object.freeze({
  USERS: 1000,
  USER_OFFSET: 0,
  MSG_PER_MIN: 20,
  HOLD_SECS: 300,
  RAMP_SECS: 120,
  BODY_BYTES: 120,
  DELIVERY_TIMEOUT_MS: 30_000,
  CALLS_PER_MIN: 0,
  CALL_HOLD_SECS: 10,
  CALL_ANSWER_RATE: 100,
  GROUP_CALL_RATE: 0,
  GROUP_CALL_SIZE: 4,
});

class ConfigError extends Error {}

function parseInteger(env, name, fallback, { min = 0 } = {}) {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${name} must be an integer >= ${min}; got ${JSON.stringify(raw)}`);
  }
  return value;
}

function defaultOutputPath(now = new Date()) {
  return `run-${now.toISOString().replace(/[:.]/g, '-')}.jsonl`;
}

function loadConfig(env = process.env, now = new Date()) {
  const target = env.TARGET?.trim();
  if (!target) {
    throw new ConfigError('TARGET is required; set it to the base URL of the server under test.');
  }

  const users = parseInteger(env, 'USERS', DEFAULTS.USERS, { min: 2 });
  if (users % 2 !== 0) {
    throw new ConfigError(`USERS must be even so users can be paired; got ${users}.`);
  }

  const userOffset = parseInteger(env, 'USER_OFFSET', DEFAULTS.USER_OFFSET, { min: 0 });
  const msgPerMin = parseInteger(env, 'MSG_PER_MIN', DEFAULTS.MSG_PER_MIN, { min: 0 });
  const holdSecs = parseInteger(env, 'HOLD_SECS', DEFAULTS.HOLD_SECS, { min: 0 });
  const rampSecs = parseInteger(env, 'RAMP_SECS', DEFAULTS.RAMP_SECS, { min: 1 });
  const bodyBytes = parseInteger(env, 'BODY_BYTES', DEFAULTS.BODY_BYTES, { min: 1 });
  const deliveryTimeoutMs = parseInteger(env, 'DELIVERY_TIMEOUT_MS', DEFAULTS.DELIVERY_TIMEOUT_MS, { min: 1 });
  const callsPerMin = parseInteger(env, 'CALLS_PER_MIN', DEFAULTS.CALLS_PER_MIN, { min: 0 });
  const callHoldSecs = parseInteger(env, 'CALL_HOLD_SECS', DEFAULTS.CALL_HOLD_SECS, { min: 0 });
  const callAnswerRate = parseInteger(env, 'CALL_ANSWER_RATE', DEFAULTS.CALL_ANSWER_RATE, { min: 0 });
  if (callAnswerRate > 100) {
    throw new ConfigError(`CALL_ANSWER_RATE must be an integer between 0 and 100; got ${callAnswerRate}.`);
  }
  const groupCallRate = parseInteger(env, 'GROUP_CALL_RATE', DEFAULTS.GROUP_CALL_RATE, { min: 0 });
  if (groupCallRate > 100) {
    throw new ConfigError(`GROUP_CALL_RATE must be an integer between 0 and 100; got ${groupCallRate}.`);
  }
  const groupCallSize = parseInteger(env, 'GROUP_CALL_SIZE', DEFAULTS.GROUP_CALL_SIZE, { min: 3 });
  if (groupCallRate > 0 && groupCallSize > users) {
    throw new ConfigError(`GROUP_CALL_SIZE must not exceed USERS (${users}); got ${groupCallSize}.`);
  }
  const minRampBatch = Math.max(1, Math.ceil(users / rampSecs));
  const rampBatch = env.RAMP_BATCH === undefined
    ? minRampBatch
    : parseInteger(env, 'RAMP_BATCH', minRampBatch, { min: 1 });

  if (rampBatch < minRampBatch) {
    throw new ConfigError(
      `RAMP_BATCH=${rampBatch} is too small for the nominal ${rampSecs}s ramp schedule for ${users} users; ` +
        `minimum required value is ${minRampBatch}.`
    );
  }

  return {
    target: target.replace(/\/+$/, ''),
    users,
    userOffset,
    msgPerMin,
    holdSecs,
    rampSecs,
    rampBatch,
    bodyBytes,
    deliveryTimeoutMs,
    callsPerMin,
    callHoldSecs,
    callAnswerRate,
    groupCallRate,
    groupCallSize,
    maxInFlightMessages: Math.max(users * 2, Math.ceil(users * msgPerMin * deliveryTimeoutMs / 60_000 * 2)),
    maxInFlightCalls: Math.max(1, Math.floor(users / 2)),
    out: env.OUT || defaultOutputPath(now),
  };
}

function createLatencyBucket(sampleLimit = LATENCY_SAMPLE_LIMIT) {
  return { count: 0, sampleLimit, samples: [] };
}

function recordLatency(bucket, value) {
  if (Array.isArray(bucket)) {
    bucket.push(value);
    return;
  }

  bucket.count += 1;
  if (bucket.samples.length < bucket.sampleLimit) {
    bucket.samples.push(value);
    return;
  }

  const index = Math.floor(Math.random() * bucket.count);
  if (index < bucket.sampleLimit) bucket.samples[index] = value;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function summarize(values) {
  const count = Array.isArray(values) ? values.length : values.count;
  const samples = Array.isArray(values) ? values : values.samples;
  if (samples.length === 0) {
    return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: count,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

function emitWithAck(socket, eventName, payload, timeoutMs, onAck, onTimeout) {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    onTimeout?.();
  }, timeoutMs);

  socket.emit(eventName, payload, (ack) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onAck(ack);
  });
}

function addTimer(user, timer) {
  user.timers.push(timer);
  return timer;
}

function clearUserTimers(user) {
  for (const timer of user.timers) clearTimeout(timer);
  user.timers.length = 0;
}

function increment(errors, reason) {
  const key = reason || 'unknown';
  errors[key] = (errors[key] ?? 0) + 1;
}

function phaseFor(timing, now = Date.now()) {
  return timing.rampCompletedAt === null || timing.rampCompletedAt === undefined ||
    now < timing.rampCompletedAt ? 'ramp' : 'steady';
}

function holdDeadline(steadyStartedAt, holdSecs) {
  return steadyStartedAt + holdSecs * 1000;
}

function makeBody(bytes) {
  return 'x'.repeat(bytes);
}

function userIdAt(config, index) {
  return `lt-${config.userOffset + index}`;
}

function peerIndex(index) {
  return index % 2 === 0 ? index + 1 : index - 1;
}

function messageId(userId, sequence) {
  return `${userId}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function extractErrorReason(payload, fallback) {
  if (payload?.error?.code) return String(payload.error.code);
  if (payload?.code) return String(payload.code);
  if (payload?.message) return String(payload.message);
  return fallback;
}

async function createSession(config, userId) {
  const response = await fetch(`${config.target}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, deviceId: `d-${userId}`, idToken: userId }),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON errors are still counted by status below.
  }

  if (response.status === 401) return { ok: false, reason: 'session_401' };
  if (!response.ok) return { ok: false, reason: `session_${response.status}` };
  if (!body?.sessionId) return { ok: false, reason: 'session_invalid' };
  return { ok: true, sessionId: body.sessionId };
}

function connectSocket(io, config, sessionId, userId, onEventError) {
  const socket = io(config.target, {
    auth: { sessionId },
    forceNew: true,
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelayMax: 10_000,
  });

  socket.on(SERVER_EVENTS.SERVER_DRAINING, () => onEventError('server_draining'));
  socket.on(SERVER_EVENTS.SESSION_INVALID, () => onEventError('session_invalid'));
  socket.on(SERVER_EVENTS.SIGNALING_ERROR, (payload) => {
    onEventError(extractErrorReason(payload, 'signaling_error'));
  });
  socket.on('connect_error', (error) => {
    onEventError(error?.message ? `connect_error:${error.message}` : 'connect_error');
  });
  socket.on('disconnect', (reason) => {
    if (reason !== 'io client disconnect') onEventError(`disconnect:${reason}`);
  });
  socket.data = { userId };
  return socket;
}

async function waitForConnect(socket) {
  if (socket.connected) return true;
  return new Promise((resolve) => {
    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
    };
    const onConnect = () => {
      cleanup();
      resolve(true);
    };
    const onConnectError = () => {
      cleanup();
      resolve(false);
    };
    socket.once('connect', onConnect);
    socket.once('connect_error', onConnectError);
  });
}

async function openUser(io, config, index, state, timing) {
  const userId = userIdAt(config, index);
  const session = await createSession(config, userId);
  if (!session.ok) {
    state.connectFail += 1;
    increment(state.errors, session.reason);
    return null;
  }

  const socket = connectSocket(io, config, session.sessionId, userId, (reason) => {
    increment(state.errors, reason);
  });

  if (!(await waitForConnect(socket))) {
    state.connectFail += 1;
    increment(state.errors, 'connect_failed');
    socket.disconnect();
    return null;
  }

  state.connected += 1;
  socket.on(SERVER_EVENTS.MESSAGE_RECEIVED, (payload) => {
    const deliveredId = payload?.message?.messageId;
    const pending = state.inFlight.get(deliveredId);
    if (!pending) return;
    state.inFlight.delete(deliveredId);
    const latency = Date.now() - pending.t0;
    const bucket = pending.phase === 'steady' ? state.deliverySteady : state.deliveryRamp;
    recordLatency(bucket, latency);
  });

  const user = { index, userId, sessionId: session.sessionId, socket, sendSequence: 0, timers: [] };
  state.usersByIndex.set(index, user);
  socket.on(SERVER_EVENTS.CALL_INCOMING, (payload) => {
    handleIncomingCall(config, state, user, payload);
  });
  startSender(config, state, user, timing);
  return user;
}

function startSender(config, state, user, timing) {
  if (config.msgPerMin === 0) return;

  const intervalMs = 60_000 / config.msgPerMin;
  const sendOnce = () => sendMessage(config, state, user, timing);
  const firstDelay = Math.floor(Math.random() * intervalMs);
  const timeout = setTimeout(() => {
    sendOnce();
    addTimer(user, setInterval(sendOnce, intervalMs));
  }, firstDelay);
  addTimer(user, timeout);
}

function sendMessage(config, state, user, timing) {
  if (!user.socket.connected) return;
  if (state.inFlight.size >= config.maxInFlightMessages) {
    increment(state.errors, 'message_backpressure');
    return;
  }

  const id = messageId(user.userId, user.sendSequence++);
  const currentPhase = phaseFor(timing);
  const payload = {
    version: SIGNALING_VERSION,
    recipientId: userIdAt(config, peerIndex(user.index)),
    body: state.body,
    type: 'text',
    messageId: id,
  };
  const t0 = Date.now();
  state.inFlight.set(id, { t0, phase: currentPhase });

  user.socket.emit(CLIENT_EVENTS.MESSAGE_SEND, payload, (ack) => {
    if (!ack?.ok) {
      state.inFlight.delete(id);
      increment(state.errors, extractErrorReason(ack, 'ack_error'));
      return;
    }
    state.sent += 1;
    const latency = Date.now() - t0;
    const bucket = currentPhase === 'steady' ? state.ackSteady : state.ackRamp;
    recordLatency(bucket, latency);
  });
}


function findCallRecord(state, callId) {
  for (const record of state.callStates.values()) {
    if (record.callId === callId) return record;
  }
  return null;
}

function releaseCall(state, key, reason) {
  const record = state.callStates.get(key);
  if (!record) return;
  clearTimeout(record.cleanupTimer);
  state.callStates.delete(key);
  state.busyPairs.delete(record.pairKey);
  for (const participant of record.participants) state.busyUsers.delete(participant.userId);
  if (reason) increment(state.errors, reason);
}

function startCallScheduler(config, state, users, timing) {
  if (config.callsPerMin === 0) return null;

  const callers = users
    .filter((user) => user.index % 2 === 0)
    .filter((user) => user.socket.connected && users.some((peer) => peer.index === peerIndex(user.index)));
  if (callers.length === 0) return null;

  const intervalMs = 60_000 / config.callsPerMin;
  let cursor = 0;
  const sendOnce = () => {
    for (let attempted = 0; attempted < callers.length; attempted += 1) {
      const user = callers[cursor % callers.length];
      cursor += 1;
      if (startScheduledCall(config, state, user, users, timing)) return;
    }
    increment(state.errors, 'call_pair_backpressure');
  };
  const firstDelay = Math.floor(Math.random() * intervalMs);
  const timeout = setTimeout(() => {
    sendOnce();
    state.callTimer = setInterval(sendOnce, intervalMs);
  }, firstDelay);
  state.callTimer = timeout;
  return timeout;
}

function startScheduledCall(config, state, caller, users, timing) {
  if (config.groupCallRate > 0 &&
    (state.callsStarted * config.groupCallRate) % 100 < config.groupCallRate) {
    const group = state.groupPools.find((candidate) =>
      candidate.users.includes(caller) &&
      candidate.users.every((user) => user.socket.connected && !state.busyUsers.has(user.userId))
    );
    if (group && startGroupCall(config, state, group, caller, timing)) return true;
  }
  return startCall(config, state, caller, timing);
}

function callPairKey(left, right) {
  return `${Math.min(left.index, right.index)}:${Math.max(left.index, right.index)}`;
}

function groupPairKeys(participants) {
  const keys = [];
  for (let left = 0; left < participants.length; left += 1) {
    for (let right = left + 1; right < participants.length; right += 1) {
      keys.push(callPairKey(participants[left], participants[right]));
    }
  }
  return keys;
}

function releaseGroupCall(state, record, reason) {
  if (!state.groupCallStates.delete(record.key)) return;
  for (const participant of record.participants) state.busyUsers.delete(participant.userId);
  for (const pairKey of record.pairKeys) state.busyPairs.delete(pairKey);
  if (reason) increment(state.errors, reason);
}

async function postCallAction(config, user, path, body = {}) {
  const response = await fetch(`${config.target}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, sessionId: user.sessionId }),
  });
  let result = null;
  try {
    result = await response.json();
  } catch {
    // Keep the HTTP status as the failure reason when the server returned no JSON.
  }
  return { ok: response.ok, result, status: response.status };
}

async function prepareGroupPools(config, state, users) {
  const connectedUsers = users.filter((user) => user.socket.connected);
  const usersById = new Map(connectedUsers.map((user) => [user.userId, user]));
  for (let offset = 0; offset + config.groupCallSize <= connectedUsers.length; offset += config.groupCallSize) {
    const members = connectedUsers.slice(offset, offset + config.groupCallSize);
    const [creator, ...invitees] = members;
    const created = await postCallAction(config, creator, '/groups', {
      name: `loadrig-${creator.userId}`,
      inviteeIds: invitees.map((user) => user.userId),
    });
    if (!created.ok || !created.result?.group?.conversationId) {
      throw new Error(`group setup failed (${created.status})`);
    }
    const conversationId = created.result.group.conversationId;
    for (const invitation of created.result.invitations ?? []) {
      const invitee = usersById.get(invitation.inviteeId);
      const accepted = invitee && await postCallAction(
        config,
        invitee,
        `/groups/${conversationId}/invitations/${invitation.invitationId}/accept`
      );
      if (!accepted?.ok) throw new Error(`group membership setup failed (${accepted?.status ?? 'missing user'})`);
    }
    state.groupPools.push({ conversationId, users: members });
  }
}

function emitAck(socket, eventName, payload, timeoutMs) {
  return new Promise((resolve) => {
    emitWithAck(socket, eventName, payload, timeoutMs, resolve, () => resolve({ ok: false, error: 'timeout' }));
  });
}

function startGroupCall(config, state, group, caller, timing) {
  const participants = group.users;
  if (state.groupCallStates.size + state.callStates.size >= config.maxInFlightCalls) {
    increment(state.errors, 'call_backpressure');
    return false;
  }
  const pairKeys = groupPairKeys(participants);
  if (participants.some((user) => state.busyUsers.has(user.userId)) ||
    pairKeys.some((key) => state.busyPairs.has(key))) return false;

  const record = {
    key: `group:${state.callsStarted}`,
    participants,
    pairKeys,
    phase: phaseFor(timing),
    callId: null,
  };
  state.callsStarted += 1;
  state.groupCallsStarted += 1;
  state.groupCallStates.set(record.key, record);
  for (const participant of participants) state.busyUsers.add(participant.userId);
  for (const pairKey of pairKeys) state.busyPairs.add(pairKey);

  record.promise = (async () => {
    const created = await emitAck(caller.socket, CLIENT_EVENTS.CONVERSATION_CALL_START, {
      version: SIGNALING_VERSION,
      conversationId: group.conversationId,
      mediaType: 'audio',
    }, config.deliveryTimeoutMs);
    const callId = created?.call?.callId;
    if (!created?.ok || !callId) {
      releaseGroupCall(state, record, extractErrorReason(created, 'group_call_create_error'));
      return;
    }
    record.callId = callId;
    const invitees = participants.filter((user) => user !== caller);
    const inviteeStates = new Map(created.participants.map(({ userId, status }) => [userId, status]));
    state.groupParticipants += participants.length;
    state.maxGroupParticipants = Math.max(state.maxGroupParticipants, participants.length);

    const answerSequence = state.groupParticipantsSeen;
    state.groupParticipantsSeen += invitees.length;
    const joined = [caller];
    for (const [index, participant] of invitees.entries()) {
      if (inviteeStates.get(participant.userId) !== 'ringing') {
        state.groupPeersDeclined += 1;
        continue;
      }
      const shouldJoin = (answerSequence + index) % 100 < config.callAnswerRate;
      const event = shouldJoin
        ? CLIENT_EVENTS.CONVERSATION_CALL_ACCEPT
        : CLIENT_EVENTS.CONVERSATION_CALL_DECLINE;
      const response = await emitAck(participant.socket, event, {
        version: SIGNALING_VERSION,
        callId,
      }, config.deliveryTimeoutMs);
      if (!response?.ok && response?.error?.code === 'group_call_full') {
        state.groupPeersDeclined += 1;
        continue;
      }
      if (!response?.ok) {
        releaseGroupCall(state, record, extractErrorReason(response, 'group_call_participant_error'));
        return;
      }
      if (shouldJoin) joined.push(participant);
      else state.groupPeersDeclined += 1;
    }

    if (joined.length > 1) {
      state.groupMeshExpectedMessages += joined.length * (joined.length - 1);
      for (let left = 0; left < joined.length; left += 1) {
        for (let right = left + 1; right < joined.length; right += 1) {
          const offer = await emitAck(joined[left].socket, CLIENT_EVENTS.RTC_OFFER, {
            version: SIGNALING_VERSION,
            callId,
            peerId: joined[right].userId,
            sdp: { type: 'offer', sdp: 'loadrig-group-offer' },
          }, config.deliveryTimeoutMs);
          if (!offer?.ok) {
            releaseGroupCall(state, record, extractErrorReason(offer, 'group_rtc_offer_error'));
            return;
          }
          state.groupMeshSignalingMessages += 1;
          const answer = await emitAck(joined[right].socket, CLIENT_EVENTS.RTC_ANSWER, {
            version: SIGNALING_VERSION,
            callId,
            peerId: joined[left].userId,
            sdp: { type: 'answer', sdp: 'loadrig-group-answer' },
          }, config.deliveryTimeoutMs);
          if (!answer?.ok) {
            releaseGroupCall(state, record, extractErrorReason(answer, 'group_rtc_answer_error'));
            return;
          }
          state.groupMeshSignalingMessages += 1;
        }
      }
      state.groupCallsInCall += 1;
      await new Promise((resolve) => setTimeout(resolve, config.callHoldSecs * 1000));
      for (const participant of joined) {
        const leftCall = await emitAck(participant.socket, CLIENT_EVENTS.CONVERSATION_CALL_LEAVE, {
          version: SIGNALING_VERSION,
          callId,
        }, config.deliveryTimeoutMs);
        if (!leftCall?.ok) {
          releaseGroupCall(state, record, extractErrorReason(leftCall, 'group_call_leave_error'));
          return;
        }
      }
      state.groupCallsEnded += 1;
    } else {
      state.groupCallsDeclined += 1;
    }
    releaseGroupCall(state, record);
  })().catch((error) => {
    releaseGroupCall(state, record, error?.message ? `group_call_error:${error.message}` : 'group_call_error');
  });
  return true;
}

function startCall(config, state, caller, timing) {
  if (!caller.socket.connected) return false;
  if (state.callStates.size + state.groupCallStates.size >= config.maxInFlightCalls) {
    increment(state.errors, 'call_backpressure');
    return false;
  }

  const calleeIndex = peerIndex(caller.index);
  const pairKey = `${Math.min(caller.index, calleeIndex)}:${Math.max(caller.index, calleeIndex)}`;
  const callee = state.usersByIndex.get(calleeIndex);
  if (!callee || state.busyUsers.has(caller.userId) || state.busyUsers.has(callee.userId)) return false;
  if (state.busyPairs.has(pairKey)) return false;

  const sequence = state.callsStarted;
  const key = `pending:${caller.userId}:${sequence}`;
  const phase = phaseFor(timing);
  const now = Date.now();
  const record = {
    key,
    pairKey,
    participants: [caller, callee],
    sequence,
    phase,
    caller,
    calleeId: callee.userId,
    initiatedAt: now,
    incomingAt: null,
    acceptedAt: null,
    callId: null,
    cleanupTimer: setTimeout(() => releaseCall(state, key), CALL_RING_CLEANUP_MS),
  };
  state.callsStarted += 1;
  state.busyPairs.add(pairKey);
  state.busyUsers.add(caller.userId);
  state.busyUsers.add(callee.userId);
  state.callStates.set(key, record);

  emitWithAck(
    caller.socket,
    CLIENT_EVENTS.CALL_INITIATE,
    { version: SIGNALING_VERSION, calleeId: record.calleeId, mediaType: 'audio' },
    config.deliveryTimeoutMs,
    (ack) => {
      if (!ack?.ok || !ack.call?.callId) {
        releaseCall(state, key, extractErrorReason(ack, 'call_initiate_error'));
        return;
      }
      const current = state.callStates.get(key);
      if (!current) return;
      state.callStates.delete(key);
      clearTimeout(current.cleanupTimer);
      current.callId = ack.call.callId;
      current.key = current.callId;
      current.cleanupTimer = setTimeout(() => releaseCall(state, current.callId), CALL_RING_CLEANUP_MS);
      state.callStates.set(current.callId, current);
    },
    () => releaseCall(state, key, 'call_initiate_timeout')
  );
  return true;
}

function handleIncomingCall(config, state, callee, payload) {
  const callId = payload?.callId;
  if (!callId) return;
  const record = findCallRecord(state, callId);
  if (!record) return;

  record.incomingAt = Date.now();
  if (record.sequence % 100 >= config.callAnswerRate) {
    if (record.sequence % 2 === 0) {
      declineCall(config, state, callee, record);
    } else {
      state.callsTimedOut += 1;
    }
    return;
  }

  acceptCall(config, state, callee, record);
}

function declineCall(config, state, callee, record) {
  emitWithAck(
    callee.socket,
    CLIENT_EVENTS.CALL_DECLINE,
    { version: SIGNALING_VERSION, callId: record.callId },
    config.deliveryTimeoutMs,
    (ack) => {
      if (!ack?.ok) {
        releaseCall(state, record.key, extractErrorReason(ack, 'call_decline_error'));
        return;
      }
      state.callsDeclined += 1;
      releaseCall(state, record.key);
    },
    () => releaseCall(state, record.key, 'call_decline_timeout')
  );
}

function acceptCall(config, state, callee, record) {
  emitWithAck(
    callee.socket,
    CLIENT_EVENTS.CALL_ACCEPT,
    { version: SIGNALING_VERSION, callId: record.callId },
    config.deliveryTimeoutMs,
    (ack) => {
      if (!ack?.ok) {
        releaseCall(state, record.key, extractErrorReason(ack, 'call_accept_error'));
        return;
      }
      record.acceptedAt = Date.now();
      state.callsAccepted += 1;
      recordLatency(record.phase === 'steady' ? state.ringAcceptSteady : state.ringAcceptRamp, record.acceptedAt - record.incomingAt);
      connectCallMedia(config, state, callee, record);
    },
    () => releaseCall(state, record.key, 'call_accept_timeout')
  );
}

function connectCallMedia(config, state, callee, record) {
  emitWithAck(
    record.caller.socket,
    CLIENT_EVENTS.RTC_OFFER,
    {
      version: SIGNALING_VERSION,
      callId: record.callId,
      peerId: record.calleeId,
      sdp: { type: 'offer', sdp: 'loadrig-offer' },
    },
    config.deliveryTimeoutMs,
    (offerAck) => {
      if (!offerAck?.ok) {
        releaseCall(state, record.key, extractErrorReason(offerAck, 'rtc_offer_error'));
        return;
      }
      emitWithAck(
        callee.socket,
        CLIENT_EVENTS.RTC_ANSWER,
        {
          version: SIGNALING_VERSION,
          callId: record.callId,
          peerId: record.caller.userId,
          sdp: { type: 'answer', sdp: 'loadrig-answer' },
        },
        config.deliveryTimeoutMs,
        (answerAck) => {
          if (!answerAck?.ok) {
            releaseCall(state, record.key, extractErrorReason(answerAck, 'rtc_answer_error'));
            return;
          }
          markCallConnected(config, state, record);
        },
        () => releaseCall(state, record.key, 'rtc_answer_timeout')
      );
    },
    () => releaseCall(state, record.key, 'rtc_offer_timeout')
  );
}

function markCallConnected(config, state, record) {
  emitWithAck(
    record.caller.socket,
    CLIENT_EVENTS.CALL_CONNECTED,
    { version: SIGNALING_VERSION, callId: record.callId, iceState: 'connected' },
    config.deliveryTimeoutMs,
    (ack) => {
      if (!ack?.ok) {
        releaseCall(state, record.key, extractErrorReason(ack, 'call_connected_error'));
        return;
      }
      state.callsInCall += 1;
      recordLatency(record.phase === 'steady' ? state.acceptInCallSteady : state.acceptInCallRamp, Date.now() - record.acceptedAt);
      clearTimeout(record.cleanupTimer);
      record.cleanupTimer = setTimeout(() => endCall(config, state, record), config.callHoldSecs * 1000);
    },
    () => releaseCall(state, record.key, 'call_connected_timeout')
  );
}

function endCall(config, state, record) {
  emitWithAck(
    record.caller.socket,
    CLIENT_EVENTS.CALL_END,
    { version: SIGNALING_VERSION, callId: record.callId, reason: 'user_hangup' },
    config.deliveryTimeoutMs,
    (ack) => {
      if (ack?.ok) state.callsEnded += 1;
      releaseCall(state, record.key, ack?.ok ? null : extractErrorReason(ack, 'call_end_error'));
    },
    () => releaseCall(state, record.key, 'call_end_timeout')
  );
}

function sweepDeliveryTimeouts(inFlight, now, timeoutMs, errors) {
  let removed = 0;
  for (const [id, entry] of inFlight) {
    if (now - entry.t0 <= timeoutMs) continue;
    inFlight.delete(id);
    removed += 1;
  }
  if (removed > 0) errors.delivery_timeout = (errors.delivery_timeout ?? 0) + removed;
  return removed;
}

function snapshot(tag, config, state, timing) {
  const phase = phaseFor(timing);
  const line = {
    tag,
    ts: new Date().toISOString(),
    phase,
    connected: state.connected,
    connectFail: state.connectFail,
    sent: state.sent,
    pending: state.inFlight.size,
    ack: summarize(state.ackSteady),
    delivery: summarize(state.deliverySteady),
    ackRamp: summarize(state.ackRamp),
    deliveryRamp: summarize(state.deliveryRamp),
    errors: { ...state.errors },
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
  if (config.callsPerMin > 0) {
    line.calls = {
      started: state.callsStarted,
      accepted: state.callsAccepted,
      declined: state.callsDeclined,
      timedOut: state.callsTimedOut,
      inCall: state.callsInCall,
      ended: state.callsEnded,
      groupStarted: state.groupCallsStarted,
      groupInCall: state.groupCallsInCall,
      groupEnded: state.groupCallsEnded,
      groupDeclined: state.groupCallsDeclined,
      groupPeersDeclined: state.groupPeersDeclined,
      groupParticipants: state.groupParticipants,
      maxGroupParticipants: state.maxGroupParticipants,
      groupMeshSignalingMessages: state.groupMeshSignalingMessages,
      groupMeshExpectedMessages: state.groupMeshExpectedMessages,
      pending: state.callStates.size + state.groupCallStates.size,
    };
    line.ringAccept = summarize(state.ringAcceptSteady);
    line.acceptInCall = summarize(state.acceptInCallSteady);
    line.ringAcceptRamp = summarize(state.ringAcceptRamp);
    line.acceptInCallRamp = summarize(state.acceptInCallRamp);
  }
  return line;
}

function emitLine(stream, line) {
  const text = `${JSON.stringify(line)}\n`;
  process.stdout.write(text);
  stream.write(text);
}

async function waitUntil(deadline) {
  const delay = deadline - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

async function rampUsers(io, config, state, timing, {
  open = openUser,
  waitForDeadline = waitUntil,
} = {}) {
  const openings = [];
  let next = 0;
  let batchIndex = 0;
  while (next < config.users) {
    await waitForDeadline(timing.rampStartedAt + batchIndex * RAMP_BATCH_INTERVAL_MS);
    const batch = [];
    for (let count = 0; count < config.rampBatch && next < config.users; count += 1, next += 1) {
      batch.push(next);
    }
    openings.push(...batch.map((index) => Promise.resolve()
      .then(() => open(io, config, index, state, timing))
      .then((user) => ({ ok: true, user }), (error) => ({ ok: false, error }))));
    batchIndex += 1;
  }
  const results = await Promise.all(openings);
  const failure = results.find((result) => !result.ok);
  if (failure) throw failure.error;
  return results.map((result) => result.user).filter(Boolean);
}

async function closeStream(stream) {
  stream.end();
  await once(stream, 'finish');
}

async function run(config) {
  const { io } = await import('socket.io-client');
  const timing = { rampStartedAt: Date.now(), rampCompletedAt: null };
  const stream = createWriteStream(config.out, { flags: 'a' });
  const state = {
    connected: 0,
    connectFail: 0,
    sent: 0,
    body: makeBody(config.bodyBytes),
    inFlight: new Map(),
    ackSteady: createLatencyBucket(),
    deliverySteady: createLatencyBucket(),
    ackRamp: createLatencyBucket(),
    deliveryRamp: createLatencyBucket(),
    ringAcceptSteady: createLatencyBucket(),
    acceptInCallSteady: createLatencyBucket(),
    ringAcceptRamp: createLatencyBucket(),
    acceptInCallRamp: createLatencyBucket(),
    errors: {},
    callStates: new Map(),
    groupCallStates: new Map(),
    groupPools: [],
    busyUsers: new Set(),
    busyPairs: new Set(),
    usersByIndex: new Map(),
    callsStarted: 0,
    callsAccepted: 0,
    callsDeclined: 0,
    callsTimedOut: 0,
    callsInCall: 0,
    callsEnded: 0,
    groupCallsStarted: 0,
    groupCallsInCall: 0,
    groupCallsEnded: 0,
    groupCallsDeclined: 0,
    groupPeersDeclined: 0,
    groupParticipants: 0,
    groupParticipantsSeen: 0,
    maxGroupParticipants: 0,
    groupMeshSignalingMessages: 0,
    groupMeshExpectedMessages: 0,
    callTimer: null,
  };
  const users = [];
  let finalized = false;

  // Undelivered messages must age out so `pending` remains current queue depth
  // and a lossy run cannot grow memory forever.
  const sweeper = setInterval(() => {
    sweepDeliveryTimeouts(state.inFlight, Date.now(), config.deliveryTimeoutMs, state.errors);
  }, SWEEP_INTERVAL_MS);
  const reporter = setInterval(() => {
    emitLine(stream, snapshot('hold', config, state, timing));
  }, REPORT_INTERVAL_MS);

  async function finalize(exitCode) {
    if (finalized) return;
    finalized = true;
    clearInterval(reporter);
    clearInterval(sweeper);
    if (state.callTimer) clearTimeout(state.callTimer);
    await Promise.all([...state.groupCallStates.values()].map((record) => record.promise));
    sweepDeliveryTimeouts(state.inFlight, Date.now(), config.deliveryTimeoutMs, state.errors);
    for (const user of users) {
      clearUserTimers(user);
      user.socket.disconnect();
    }
    for (const record of state.callStates.values()) clearTimeout(record.cleanupTimer);
    emitLine(stream, snapshot('final', config, state, timing));
    await closeStream(stream);
    process.exitCode = exitCode;
  }

  process.once('SIGINT', () => {
    void finalize(0).then(() => process.exit(0));
  });

  // The default batch paces connection attempts; actual completion defines the ramp boundary.
  users.push(...await rampUsers(io, config, state, timing));
  timing.rampCompletedAt = Date.now();
  if (config.groupCallRate > 0 && config.callsPerMin > 0) {
    await prepareGroupPools(config, state, users);
  }
  startCallScheduler(config, state, users, timing);
  const holdUntil = holdDeadline(Date.now(), config.holdSecs);
  const remainingHoldMs = holdUntil - Date.now();
  if (remainingHoldMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingHoldMs));
  }
  const failed = state.connectFail > 0 || Object.keys(state.errors).length > 0;
  await finalize(failed ? 1 : 0);
}

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  run(config).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  ConfigError,
  createLatencyBucket,
  defaultOutputPath,
  holdDeadline,
  loadConfig,
  phaseFor,
  rampUsers,
  recordLatency,
  summarize,
  sweepDeliveryTimeouts,
};
