import { pushSenders } from '../push.ts';
import { LEGACY_SIGNALING_VERSION, SIGNALING_VERSION, CALL_TRANSITION_CHANNEL, CONNECTED_CALL_STATUS, TERMINAL_CALL_STATES } from '../config.ts';
import { measureSinceAnswered } from '../lib/callLatency.ts';
import { sanitizeForLog } from '../lib/normalize.ts';
import { resolveReachableChannels, userProtocolRoom, userRoom } from '../lib/state.ts';
import { describeActiveCallsForUser } from './calls.ts';
import { pruneDeadDevice } from '../lib/persistence.ts';
import { verboseLog } from '../lib/verbose.ts';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../../shared/index.ts';

const DEFAULT_INCOMING_CALL_ACK_TIMEOUT_MS = 2000;

/**
 * Client-facing call notifications.
 *
 * Translates call-record changes into Socket.IO emits (to the caller/callee
 * user rooms), push fallbacks, telemetry, and cross-instance message-bus
 * broadcasts.  Kept separate from the `calls` state machine so the machine has
 * no Socket.IO dependency.
 */
export type ServerState = import('../stores/contracts.ts').ServerState;
export type CallRecord = import('../stores/contracts.ts').CallRecord;
export type IncomingCallPushEntry = import('../stores/contracts.ts').IncomingCallPushEntry;
export type PushChannel = { type: 'push'; deviceId: string; provider: string; pushToken: string; };

function emitVersionedUserEvent(
  io: any,
  userId: string,
  eventName: string,
  payload: Record<string, unknown>,
  legacyEventName: string = eventName
): void {
  const currentRoom = userProtocolRoom(userId, SIGNALING_VERSION);
  io.to(currentRoom).emit(eventName, { ...payload, version: SIGNALING_VERSION });
  const legacyRoom = io.to(userRoom(userId));
  const legacyPayload = { ...payload, version: LEGACY_SIGNALING_VERSION };
  if (typeof legacyRoom.except === 'function') {
    legacyRoom.except(currentRoom).emit(legacyEventName, legacyPayload);
  } else {
    legacyRoom.emit(legacyEventName, legacyPayload);
  }
}

function emitVersionedCallEvent(
  io: any,
  userId: string,
  eventName: string,
  payload: Record<string, unknown>,
  legacyEventName: string = eventName
): void {
  emitVersionedUserEvent(io, userId, eventName, payload, legacyEventName);
}

function emitCurrentCallEvent(io: any, userId: string, eventName: string, payload: object): void {
  io.to(userProtocolRoom(userId, SIGNALING_VERSION)).emit(eventName, {
    ...payload,
    version: SIGNALING_VERSION,
  });
}

function emitVersionedRtcSignal(
  io: any,
  userId: string,
  eventName: string,
  legacyEventName: string,
  payload: Record<string, unknown>
): void {
  const currentRoom = userProtocolRoom(userId, SIGNALING_VERSION);
  io.to(currentRoom).emit(eventName, { ...payload, version: SIGNALING_VERSION });
  const legacyRoom = io.to(userRoom(userId));
  const { peerId: _peerId, ...legacyPayload } = payload;
  if (typeof legacyRoom.except === 'function') {
    legacyRoom.except(currentRoom).emit(legacyEventName, {
      ...legacyPayload,
      version: LEGACY_SIGNALING_VERSION,
    });
  } else {
    legacyRoom.emit(legacyEventName, {
      ...legacyPayload,
      version: LEGACY_SIGNALING_VERSION,
    });
  }
}

function callWithParticipants(call: CallRecord): CallRecord & {
  participants: { userId: string; state: 'invited' | 'ringing' | 'joined' | 'left' | 'declined' | 'missed' | 'busy' | 'unreachable'; ringTimeoutAt?: string | null; joinedAt?: string | null; leftAt?: string | null; deviceId?: string | null; }[];
} {
  if (call.participants?.length) return { ...call, participants: call.participants };
  const terminal = TERMINAL_CALL_STATES.has(call.status);
  const calleeState = call.status === 'ringing'
    ? 'ringing'
    : call.status === 'declined'
      ? 'declined'
      : terminal
        ? 'left'
        : 'joined';
  return {
    ...call,
    participants: [
      { userId: call.callerId, state: terminal ? 'left' : 'joined' },
      { userId: call.calleeId, state: calleeState },
    ],
  };
}

/**
 * Prune the device row when a push delivery outcome proves its token is dead.
 * Never throws — a failure to prune must not affect the caller's own
 * success/failure handling for the push it just attempted.
 */
async function handleDeadTokenOutcome(state: ServerState, outcome: { deviceId: string; deadToken?: boolean; reason?: string; }): Promise<void> {
  if (!outcome?.deadToken) return;
  try {
    await pruneDeadDevice(state.db, state, outcome.deviceId, outcome.reason ?? 'unknown');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[push] failed to prune dead device ${outcome.deviceId}:`, message);
  }
}

/**
 * Emit an event to every socket of a user, on this instance and (with the
 * Redis adapter attached) on every other instance.
 *
 * @param io Socket.IO server.
 */
function emitToUserSockets(io: any, userId: string, eventName: string, payload: object): void {
  if ((payload as { version?: unknown }).version === SIGNALING_VERSION) {
    emitVersionedUserEvent(io, userId, eventName, payload as Record<string, unknown>);
    return;
  }
  // Emit to the user's room: locally this reaches every tracked socket, and
  // with the Redis adapter attached it also reaches the user's sockets on other
  // instances.
  io.to(userRoom(userId)).emit(eventName, payload);
}

function createCallEnvelope(call: CallRecord): { version: number; callId: string; call: CallRecord; } {
  return {
    version: SIGNALING_VERSION,
    callId: call.callId,
    call: callWithParticipants(call),
  };
}

/**
 * @returns the client event for this transition, if any.
 */
function getCallTransitionEventName(status: string, reason: string | null): string | null {
  if (status === 'accepted') {
    return CLIENT_EVENTS.CALL_ACCEPT;
  }
  if (status === 'declined') {
    return CLIENT_EVENTS.CALL_DECLINE;
  }
  if (status === 'ended') {
    return reason === 'cancelled' ? CLIENT_EVENTS.CALL_CANCEL : CLIENT_EVENTS.CALL_END;
  }
  return null;
}

function logIncomingCallPushSkip(call: CallRecord, reason: string, deviceId: string | null = null, details: string = '', userId = call.calleeId): void {
  console.log(
    `[push] Skipped call.incoming callId=${call.callId} user=${userId}` +
      (deviceId ? ` device=${deviceId}` : '') +
      ` reason=${reason}` +
      details
  );
}

function getNoPushChannelReason(state: ServerState, userId: string): 'no_device_row' | 'no_push_token' {
  const deviceIds = state.userDevices.get(userId);
  if (!deviceIds || deviceIds.size === 0) {
    return 'no_device_row';
  }
  return 'no_push_token';
}

function getIncomingCallPushState(state: ServerState): Map<string, IncomingCallPushEntry> {
  if (!state.incomingCallPushState) {
    state.incomingCallPushState = new Map();
  }
  return state.incomingCallPushState;
}

function getIncomingCallPushStateForCall(state: ServerState, callId: string): IncomingCallPushEntry {
  const store = getIncomingCallPushState(state);
  let entry = store.get(callId);
  if (!entry) {
    entry = {
      acknowledgedDeviceIds: new Set(),
      pushedDeviceIds: new Set(),
      cancelledDeviceIds: new Set(),
      ackTimeouts: new Map(),
    };
    store.set(callId, entry);
  }
  return entry;
}

function clearIncomingCallPushState(state: ServerState, callId: string): void {
  const store = getIncomingCallPushState(state);
  const entry = store.get(callId);
  if (!entry) return;
  for (const timeoutId of entry.ackTimeouts.values()) {
    clearTimeout(timeoutId);
  }
  store.delete(callId);
}

function hasIncomingCallPushBeenDispatched(state: ServerState, callId: string, deviceId: string): boolean {
  const entry = getIncomingCallPushStateForCall(state, callId);
  return entry.pushedDeviceIds.has(deviceId);
}

function markIncomingCallPushDispatched(state: ServerState, callId: string, deviceId: string): void {
  const entry = getIncomingCallPushStateForCall(state, callId);
  entry.pushedDeviceIds.add(deviceId);
}

function hasIncomingCallBeenAcknowledged(state: ServerState, callId: string, deviceId: string): boolean {
  const entry = getIncomingCallPushStateForCall(state, callId);
  return entry.acknowledgedDeviceIds.has(deviceId);
}

/**
 * @returns whether the acknowledgement was recorded.
 */
function markIncomingCallAcknowledged(state: ServerState, callId: string | null | undefined, deviceId: string | null | undefined): boolean {
  if (!callId || !deviceId) return false;
  const entry = getIncomingCallPushStateForCall(state, callId);
  entry.acknowledgedDeviceIds.add(deviceId);
  const timeoutId = entry.ackTimeouts.get(deviceId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    entry.ackTimeouts.delete(deviceId);
  }
  return true;
}

/**
 * @param trigger what prompted this (re)push, for the logs.
 */
function attemptIncomingCallPush(state: ServerState, call: CallRecord, channel: PushChannel, trigger: string | null = null, userId = call.calleeId): void {
  if (hasIncomingCallPushBeenDispatched(state, call.callId, channel.deviceId)) {
    logIncomingCallPushSkip(call, 'already_pushed', channel.deviceId, trigger ? ` trigger=${trigger}` : '');
    return;
  }
  markIncomingCallPushDispatched(state, call.callId, channel.deviceId);
  console.log(
    `[push] Attempting call.incoming callId=${call.callId}` +
      ` user=${userId} device=${channel.deviceId} via ${channel.provider}` +
      (trigger ? ` trigger=${trigger}` : '')
  );
  pushSenders
    .sendIncomingCallPush(channel, {
      callId: call.callId,
      mediaType: call.mediaType ?? 'video',
      callerId: call.callerId,
      callerDisplayName: state.users.get(call.callerId)?.displayName,
      ringTimeoutAt: call.participants?.find(({ userId: id }) => id === userId)?.ringTimeoutAt ?? call.ringTimeoutAt ?? null,
    })
    .then((outcome) => handleDeadTokenOutcome(state, outcome))
    .catch((err) => {
      console.error(
        `[push] Failed call.incoming callId=${call.callId}` +
          ` user=${userId} device=${channel.deviceId} error=${err?.message ?? 'unknown'}`
      );
    });
}

function scheduleIncomingCallAckTimeout(state: ServerState, call: CallRecord, deviceId: string, userId = call.calleeId): void {
  const entry = getIncomingCallPushStateForCall(state, call.callId);
  if (entry.ackTimeouts.has(deviceId)) return;
  const configuredTimeoutMs = Number(process.env.INCOMING_CALL_ACK_TIMEOUT_MS);
  const ackTimeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : DEFAULT_INCOMING_CALL_ACK_TIMEOUT_MS;
  const timeoutId = setTimeout(() => {
    entry.ackTimeouts.delete(deviceId);
    if (call.status !== 'ringing' && call.participants?.find(({ userId: id }) => id === userId)?.state !== 'ringing') return;
    if (hasIncomingCallBeenAcknowledged(state, call.callId, deviceId)) return;
    dispatchIncomingCallPushToDevice(state, call, deviceId, 'ack_timeout', {
      allowConnectedDevicePush: true,
    }, userId);
  }, ackTimeoutMs);
  timeoutId.unref?.();
  entry.ackTimeouts.set(deviceId, timeoutId);
}

function dispatchIncomingCallPushes(state: ServerState, call: CallRecord, userId = call.calleeId): void {
  const connections = state.userConnections.get(userId);
  const connectedDeviceIds = new Set(
    Array.from(connections?.values() || [], (connection) => connection.deviceId)
  );
  const pushChannels = resolveReachableChannels(state, userId).filter(
    (channel) => channel.type === 'push'
  );
  verboseLog('push', 'call.incoming.channels_resolved', {
    callId: call.callId,
    calleeId: userId,
    pushChannelCount: pushChannels.length,
    connectedDeviceCount: connectedDeviceIds.size,
  });

  if (pushChannels.length === 0) {
    logIncomingCallPushSkip(call, getNoPushChannelReason(state, userId), null, '', userId);
    return;
  }

  for (const channel of pushChannels) {
    if (connectedDeviceIds.has(channel.deviceId)) {
      logIncomingCallPushSkip(
        call,
        'callee_online',
        channel.deviceId,
        ` activeSockets=${connections?.size ?? 0}`,
        userId
      );
      scheduleIncomingCallAckTimeout(state, call, channel.deviceId, userId);
      continue;
    }

    attemptIncomingCallPush(state, call, channel, null, userId);
  }
}

function findPushChannelForDevice(state: ServerState, userId: string, deviceId: string): PushChannel | null {
  const device = state.devices.get(deviceId);
  if (!device || device.userId !== userId || !device.pushProvider || !device.pushToken) {
    return null;
  }
  return {
    type: 'push',
    deviceId,
    provider: device.pushProvider,
    pushToken: device.pushToken,
  };
}

function hasLiveConnectionForDevice(state: ServerState, userId: string, deviceId: string): boolean {
  const connections = state.userConnections.get(userId);
  if (!connections) return false;
  for (const connection of connections.values()) {
    if (connection.deviceId === deviceId) {
      return true;
    }
  }
  return false;
}

function dispatchIncomingCallPushToDevice(
  state: ServerState,
  call: CallRecord,
  deviceId: string,
  trigger: string,
  { allowConnectedDevicePush = false }: { allowConnectedDevicePush?: boolean; } = {},
  userId = call.calleeId
): void {
  const participant = call.participants?.find(({ userId: id }) => id === userId);
  if (call.status !== 'ringing' && participant?.state !== 'ringing') return;
  const ringTimeoutAt = participant?.ringTimeoutAt ?? call.ringTimeoutAt;
  const ringTimeoutMs = ringTimeoutAt ? new Date(ringTimeoutAt).getTime() : null;
  if (ringTimeoutMs !== null && Number.isNaN(ringTimeoutMs)) {
    logIncomingCallPushSkip(call, 'invalid_ring_timeout', deviceId, '', userId);
    return;
  }
  if (ringTimeoutMs !== null && ringTimeoutMs <= Date.now()) {
    logIncomingCallPushSkip(call, 'ring_timeout_elapsed', deviceId, '', userId);
    return;
  }
  if (hasIncomingCallBeenAcknowledged(state, call.callId, deviceId)) {
    logIncomingCallPushSkip(call, 'ack_received', deviceId, '', userId);
    return;
  }
  if (!allowConnectedDevicePush && hasLiveConnectionForDevice(state, userId, deviceId)) {
    logIncomingCallPushSkip(call, 'callee_online', deviceId, '', userId);
    return;
  }

  const channel = findPushChannelForDevice(state, userId, deviceId);
  if (!channel) {
    logIncomingCallPushSkip(call, 'no_push_token', deviceId, '', userId);
    return;
  }

  attemptIncomingCallPush(state, call, channel, trigger, userId);
}

function notifyRingingCallsForDisconnectedDevice(state: ServerState, userId: string | null | undefined, deviceId: string | null | undefined): void {
  if (!userId || !deviceId) return;
  for (const call of state.calls.values()) {
    if (call.status !== 'ringing' && !call.participants?.some((p) => p.state === 'ringing')) continue;
    if (!call.participants?.some((p) => p.userId === userId && p.state === 'ringing')) continue;
    dispatchIncomingCallPushToDevice(state, call, deviceId, 'socket_disconnected', {}, userId);
  }
}

/**
 * Render the calls that are keeping the callee busy, so a `busy` rejection log
 * names the blocking call instead of only its own callId.
 */
function describeBusyBlockers(state: ServerState, call: CallRecord): string {
  if (call.status !== 'busy') return '';
  const blockers = describeActiveCallsForUser(state, call.calleeId)
    .filter((blocker) => blocker.callId !== call.callId)
    .map(
      (blocker) => `${blocker.callId}:${blocker.status}:${blocker.ageMs}ms:stale${blocker.staleMs}ms`
    );
  return blockers.length > 0 ? ` blockedBy=${blockers.join(',')}` : '';
}

/**
 * How the callee is being reached, from the caller's point of view.
 *
 * The server already decides this — a device with a live socket rings, one
 * without gets a push and has to wake up first — but it kept the distinction to
 * itself, so ten seconds of silence on the offline-callee path read to the
 * caller exactly like a hang.
 *
 * @returns `'ringing'` when a device can ring now, `'push'` when one must wake.
 */
function describeCallDelivery(state: ServerState, call: CallRecord): 'ringing' | 'push' {
  return (state.userConnections.get(call.calleeId)?.size ?? 0) > 0 ? 'ringing' : 'push';
}

/**
 * Tell the caller that the call is ringing, and how it is being delivered.
 *
 * @param io Socket.IO server.
 */
function notifyCallRinging(io: any, state: ServerState, call: CallRecord): void {
  if (call.status !== 'ringing') return;
  emitVersionedCallEvent(io, call.callerId, SERVER_EVENTS.CALL_RINGING, {
    ...createCallEnvelope(call),
    delivery: describeCallDelivery(state, call),
  });
}

/**
 * Re-tell the caller once a pushed device has acknowledged the call: it has
 * woken up, so the call is ringing on it rather than still in transit.
 *
 * Only the callee may say this. The ack carries a client-supplied `callId`, so
 * without the check any authenticated user who learned a live call id could
 * tell its caller that a phone was ringing when nothing was.
 *
 * @param io Socket.IO server.
 * @param userId the acknowledging socket's identity.
 */
function notifyIncomingCallAcknowledged(io: any, state: ServerState, callId: string | null | undefined, userId: string | null | undefined): void {
  if (!callId) return;
  const call = state.calls.get(callId);
  if (!call || call.status !== 'ringing') return;
  if (!userId || !(call.participants?.some((participant) => participant.userId === userId) ?? call.calleeId === userId)) return;
  emitVersionedCallEvent(io, call.callerId, SERVER_EVENTS.CALL_RINGING, {
    ...createCallEnvelope(call),
    delivery: 'ringing',
  });
}

/**
 * @param io Socket.IO server.
 */
function notifyCallCreated(io: any, state: ServerState, call: CallRecord): void {
  state.telemetry.recordCallCreated(call);
  console.log(
    `[signaling] call.created callId=${call.callId} callerId=${call.callerId} calleeIds=${call.participants?.filter((p) => p.userId !== call.callerId).map((p) => p.userId).join(',') ?? call.calleeId} status=${call.status}`
  );
  verboseLog('calls', 'created', {
    callId: call.callId,
    callerId: call.callerId,
    calleeIds: call.participants?.filter((p) => p.userId !== call.callerId).map((p) => p.userId) ?? [call.calleeId],
    status: call.status,
    hasRingTimeout: Boolean(call.ringTimeoutAt),
  });

  const envelope = createCallEnvelope(call);
  if (call.status === 'ringing') {
    const invitees = call.participants?.filter((p) => p.userId !== call.callerId && p.state === 'ringing') ?? [{ userId: call.calleeId }];
    for (const participant of invitees) {
      emitVersionedCallEvent(io, participant.userId, SERVER_EVENTS.CALL_INCOMING, envelope);
      dispatchIncomingCallPushes(state, call, participant.userId);
    }
    notifyCallRinging(io, state, call);
  } else {
    logIncomingCallPushSkip(call, `call_status_${call.status}`, null, describeBusyBlockers(state, call));
    clearIncomingCallPushState(state, call.callId);
  }

  notifyCallTransition(io, state, call, {
    previousStatus: null,
    actor: call.callerId,
    reason: call.endReason,
  });
}

/**
 * Tell every device that was pushed an incoming-call notification for this call
 * that it stopped ringing, so a killed app (no socket, therefore no
 * `call.state_changed`) can dismiss the notification instead of leaving a
 * tappable ghost on screen.
 */
function dispatchCallCancelledPushes(state: ServerState, call: CallRecord, reason: string | null, recipientId?: string): void {
  const entry = getIncomingCallPushState(state).get(call.callId);
  if (!entry || entry.pushedDeviceIds.size === 0) return;
  for (const deviceId of entry.pushedDeviceIds) {
    const owner = state.devices.get(deviceId)?.userId ?? call.calleeId;
    if (recipientId && owner !== recipientId) continue;
    if (entry.cancelledDeviceIds.has(deviceId)) continue;
    entry.cancelledDeviceIds.add(deviceId);
    const channel = findPushChannelForDevice(state, owner, deviceId);
    if (!channel) continue;
    console.log(
      `[push] Attempting call.cancelled callId=${call.callId}` +
        ` user=${owner} device=${deviceId} via ${channel.provider}`
    );
    pushSenders
      .sendCallCancelledPush(channel, { callId: call.callId, reason })
      .then((outcome) => handleDeadTokenOutcome(state, outcome))
      .catch((err) => {
        console.error(
          `[push] Failed call.cancelled callId=${call.callId}` +
            ` user=${owner} device=${deviceId} error=${err?.message ?? 'unknown'}`
        );
      });
  }
}

/**
 * The media-setup elapsed time to attach to a transition log line, if any.
 *
 * Only the two media-setup transitions carry one, and both are measured from
 * the record's shared `answeredAt` rather than a process-local clock — which
 * is what makes the split readable from a single host's journal even when the
 * accept and the connect were handled on different instances. Subtracting the
 * `connecting_media` line's value from the `in_call` line's gives the
 * `connecting_media → in_call` leg.
 *
 * Returns an empty string when the elapsed time is absent or fails the skew
 * bounds: a wrong number in a log line is worse than no number.
 */
function describeMediaSetupElapsed(call: CallRecord, nowMs: number): string {
  if (call.status !== 'connecting_media' && call.status !== CONNECTED_CALL_STATUS) return '';
  const elapsed = measureSinceAnswered(call, nowMs);
  return elapsed.ok ? ` sinceAcceptedMs=${elapsed.elapsedMs}` : '';
}

type CallTransitionContext = {
  previousStatus: string | null;
  actor?: string | null;
  reason?: string | null;
  actorDeviceId?: string | null;
  actorSocketId?: string | null;
  source?: string | null;
};

function updateCallPushState(state: ServerState, call: CallRecord, previousStatus: string | null, reason: string | null): void {
  if (call.status === 'ringing') return;
  if (previousStatus === 'ringing' && TERMINAL_CALL_STATES.has(call.status)) {
    dispatchCallCancelledPushes(state, call, reason ?? call.endReason ?? null);
  }
  const pendingRings = call.participants?.some(({ state: participantState }) =>
    participantState === 'ringing' || participantState === 'invited'
  );
  if (!pendingRings || TERMINAL_CALL_STATES.has(call.status)) clearIncomingCallPushState(state, call.callId);
}

function notifyParticipantChanges(
  io: any,
  state: ServerState,
  call: CallRecord,
  actor: string | null,
  reason: string | null,
  previousStatus: string | null,
  recipients: string[]
): void {
  const participant = call.participants?.find(({ userId }) => userId === actor);
  if (!participant) return;
  if (participant.state === 'declined' || participant.state === 'left' || participant.state === 'missed') {
    dispatchCallCancelledPushes(state, call, reason ?? participant.state, participant.userId);
  }
  if (participant.state === 'joined' && previousStatus !== null) {
    const payload = { callId: call.callId, participantId: participant.userId, state: 'joined' };
    for (const userId of recipients) emitCurrentCallEvent(io, userId, SERVER_EVENTS.CALL_PARTICIPANT_JOINED, payload);
    return;
  }
  if ((participant.state !== 'left' && participant.state !== 'declined' && participant.state !== 'missed') ||
    previousStatus === null || TERMINAL_CALL_STATES.has(call.status)) return;
  const payload = { callId: call.callId, participantId: participant.userId, state: participant.state };
  for (const userId of recipients) emitCurrentCallEvent(io, userId, SERVER_EVENTS.CALL_PARTICIPANT_LEFT, payload);
}

function notifyTerminalParticipantLeaves(io: any, call: CallRecord, recipients: string[]): void {
  const departed = call.participants?.filter(({ state }) =>
    state === 'left' || state === 'declined' || state === 'missed'
  ).map(({ userId: participantId, state }) => ({ participantId, state })) ?? [
    { participantId: call.calleeId, state: call.status === 'declined' ? 'declined' : 'left' },
    { participantId: call.callerId, state: 'left' },
  ];
  for (const participant of departed) {
    for (const userId of recipients) {
      emitCurrentCallEvent(io, userId, SERVER_EVENTS.CALL_PARTICIPANT_LEFT, { callId: call.callId, ...participant });
    }
  }
}

function publishCallTransition(state: ServerState, call: CallRecord, payload: {
  previousStatus: string | null;
  status: string;
  actor: string | null;
  reason: string | null;
}): void {
  if (!state.messageBus || payload.previousStatus === null) return;
  state.messageBus.publish(CALL_TRANSITION_CHANNEL, {
    instanceId: state.instanceId ?? null,
    callId: call.callId,
    ...payload,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[signaling] message bus publish failed: ${message}`);
  });
}

function logField(name: string, value: string | null | undefined): string {
  return value ? ` ${name}=${sanitizeForLog(value)}` : '';
}

function formatCallTransitionLog(
  state: ServerState,
  call: CallRecord,
  context: CallTransitionContext
): string {
  return (
    `[signaling] call.transition callId=${sanitizeForLog(call.callId)}` +
    ` ${context.previousStatus}->${call.status}` +
    logField('reason', context.reason) +
    logField('actor', context.actor) +
    logField('actorDevice', context.actorDeviceId) +
    logField('actorSocket', context.actorSocketId) +
    logField('source', context.source) +
    logField('instance', state.instanceId) +
    describeMediaSetupElapsed(call, Date.now())
  );
}

/**
 * @param io Socket.IO server.
 */
function notifyCallTransition(io: any, state: ServerState, call: CallRecord, {
  previousStatus,
  actor = null,
  reason = null,
  actorDeviceId = null,
  actorSocketId = null,
  source = null,
}: {
  previousStatus: string | null;
  actor?: string | null;
  reason?: string | null;
  actorDeviceId?: string | null;
  actorSocketId?: string | null;
  source?: string | null;
}): void {
  updateCallPushState(state, call, previousStatus, reason);
  if (previousStatus !== null && previousStatus !== call.status) {
    state.telemetry.recordCallTransition(call, previousStatus);
    console.log(formatCallTransitionLog(state, call, {
      previousStatus,
      actor,
      reason,
      actorDeviceId,
      actorSocketId,
      source,
    }));
    verboseLog('calls', 'transition', {
      callId: call.callId,
      previousStatus,
      status: call.status,
      reason,
      actor,
    });
  }

  const statePayload = {
    version: SIGNALING_VERSION,
    callId: call.callId,
    previousStatus,
    status: call.status,
    actor,
    reason: reason ?? call.endReason ?? null,
    call: callWithParticipants(call),
  };
  const recipients = Array.from(new Set(call.participants?.map(({ userId }) => userId) ?? [call.callerId, call.calleeId]));
  for (const userId of recipients) emitVersionedCallEvent(io, userId, SERVER_EVENTS.CALL_STATE_CHANGED, statePayload);
  notifyParticipantChanges(io, state, call, actor, reason, previousStatus, recipients);
  if (TERMINAL_CALL_STATES.has(call.status)) notifyTerminalParticipantLeaves(io, call, recipients);

  // Broadcast the transition on the cross-instance bus (best-effort) so other
  // instances / external observers can react to call lifecycle changes. Socket
  // delivery to participants is handled by the Redis adapter above, so bus
  // subscribers must not re-emit to sockets (to avoid duplicate delivery).
  publishCallTransition(state, call, {
    previousStatus,
    status: call.status,
    actor,
    reason: statePayload.reason,
  });

  const eventName = getCallTransitionEventName(call.status, statePayload.reason);
  if (!eventName) {
    return;
  }

  const eventPayload = {
    version: SIGNALING_VERSION,
    callId: call.callId,
    actor,
    reason: statePayload.reason,
    call: callWithParticipants(call),
  };
  for (const userId of recipients) emitVersionedCallEvent(io, userId, eventName, eventPayload);
}

export {
  clearIncomingCallPushState,
  emitToUserSockets,
  emitCurrentCallEvent,
  emitVersionedCallEvent,
  emitVersionedUserEvent,
  emitVersionedRtcSignal,
  createCallEnvelope,
  callWithParticipants,
  getCallTransitionEventName,
  markIncomingCallAcknowledged,
  notifyCallCreated,
  notifyIncomingCallAcknowledged,
  notifyCallTransition,
  notifyRingingCallsForDisconnectedDevice,
};
