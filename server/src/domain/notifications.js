// @ts-check
'use strict';

const push = require('../push');
const { SIGNALING_VERSION, CALL_TRANSITION_CHANNEL, TERMINAL_CALL_STATES } = require('../config');
const { resolveReachableChannels, userRoom } = require('../lib/state');
const { describeActiveCallsForUser } = require('./calls');
const { pruneDeadDevice } = require('../lib/persistence');
const { verboseLog } = require('../lib/verbose');
const { CLIENT_EVENTS, SERVER_EVENTS } = require('../../../shared');

const DEFAULT_INCOMING_CALL_ACK_TIMEOUT_MS = 2000;

/**
 * Client-facing call notifications.
 *
 * Translates call-record changes into Socket.IO emits (to the caller/callee
 * user rooms), push fallbacks, telemetry, and cross-instance message-bus
 * broadcasts.  Kept separate from the `calls` state machine so the machine has
 * no Socket.IO dependency.
 *
 * @typedef {import('../stores/contracts').ServerState} ServerState
 * @typedef {import('../stores/contracts').CallRecord} CallRecord
 * @typedef {import('../stores/contracts').IncomingCallPushEntry} IncomingCallPushEntry
 * @typedef {{ type: 'push', deviceId: string, provider: string, pushToken: string }} PushChannel
 */

/**
 * Prune the device row when a push delivery outcome proves its token is dead.
 * Never throws — a failure to prune must not affect the caller's own
 * success/failure handling for the push it just attempted.
 *
 * @param {ServerState} state
 * @param {{ deviceId: string, deadToken?: boolean, reason?: string }} outcome
 * @returns {Promise<void>}
 */
async function handleDeadTokenOutcome(state, outcome) {
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
 * @param {any} io Socket.IO server.
 * @param {string} userId
 * @param {string} eventName
 * @param {object} payload
 * @returns {void}
 */
function emitToUserSockets(io, userId, eventName, payload) {
  // Emit to the user's room: locally this reaches every tracked socket, and
  // with the Redis adapter attached it also reaches the user's sockets on other
  // instances.
  io.to(userRoom(userId)).emit(eventName, payload);
}

/**
 * @param {CallRecord} call
 * @returns {{ version: number, callId: string, call: CallRecord }}
 */
function createCallEnvelope(call) {
  return {
    version: SIGNALING_VERSION,
    callId: call.callId,
    call,
  };
}

/**
 * @param {string} status
 * @param {string|null} reason
 * @returns {string|null} the client event for this transition, if any.
 */
function getCallTransitionEventName(status, reason) {
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

/**
 * @param {CallRecord} call
 * @param {string} reason
 * @param {string|null} [deviceId]
 * @param {string} [details]
 * @returns {void}
 */
function logIncomingCallPushSkip(call, reason, deviceId = null, details = '') {
  console.log(
    `[push] Skipped call.incoming callId=${call.callId} user=${call.calleeId}` +
      (deviceId ? ` device=${deviceId}` : '') +
      ` reason=${reason}` +
      details
  );
}

/**
 * @param {ServerState} state
 * @param {string} userId
 * @returns {'no_device_row'|'no_push_token'}
 */
function getNoPushChannelReason(state, userId) {
  const deviceIds = state.userDevices.get(userId);
  if (!deviceIds || deviceIds.size === 0) {
    return 'no_device_row';
  }
  return 'no_push_token';
}

/**
 * @param {ServerState} state
 * @returns {Map<string, IncomingCallPushEntry>}
 */
function getIncomingCallPushState(state) {
  if (!state.incomingCallPushState) {
    state.incomingCallPushState = new Map();
  }
  return state.incomingCallPushState;
}

/**
 * @param {ServerState} state
 * @param {string} callId
 * @returns {IncomingCallPushEntry}
 */
function getIncomingCallPushStateForCall(state, callId) {
  const store = getIncomingCallPushState(state);
  let entry = store.get(callId);
  if (!entry) {
    entry = {
      acknowledgedDeviceIds: new Set(),
      pushedDeviceIds: new Set(),
      ackTimeouts: new Map(),
    };
    store.set(callId, entry);
  }
  return entry;
}

/**
 * @param {ServerState} state
 * @param {string} callId
 * @returns {void}
 */
function clearIncomingCallPushState(state, callId) {
  const store = getIncomingCallPushState(state);
  const entry = store.get(callId);
  if (!entry) return;
  for (const timeoutId of entry.ackTimeouts.values()) {
    clearTimeout(timeoutId);
  }
  store.delete(callId);
}

/**
 * @param {ServerState} state
 * @param {string} callId
 * @param {string} deviceId
 * @returns {boolean}
 */
function hasIncomingCallPushBeenDispatched(state, callId, deviceId) {
  const entry = getIncomingCallPushStateForCall(state, callId);
  return entry.pushedDeviceIds.has(deviceId);
}

/**
 * @param {ServerState} state
 * @param {string} callId
 * @param {string} deviceId
 * @returns {void}
 */
function markIncomingCallPushDispatched(state, callId, deviceId) {
  const entry = getIncomingCallPushStateForCall(state, callId);
  entry.pushedDeviceIds.add(deviceId);
}

/**
 * @param {ServerState} state
 * @param {string} callId
 * @param {string} deviceId
 * @returns {boolean}
 */
function hasIncomingCallBeenAcknowledged(state, callId, deviceId) {
  const entry = getIncomingCallPushStateForCall(state, callId);
  return entry.acknowledgedDeviceIds.has(deviceId);
}

/**
 * @param {ServerState} state
 * @param {string|null|undefined} callId
 * @param {string|null|undefined} deviceId
 * @returns {boolean} whether the acknowledgement was recorded.
 */
function markIncomingCallAcknowledged(state, callId, deviceId) {
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
 * @param {ServerState} state
 * @param {CallRecord} call
 * @param {PushChannel} channel
 * @param {string|null} [trigger] what prompted this (re)push, for the logs.
 * @returns {void}
 */
function attemptIncomingCallPush(state, call, channel, trigger = null) {
  if (hasIncomingCallPushBeenDispatched(state, call.callId, channel.deviceId)) {
    logIncomingCallPushSkip(call, 'already_pushed', channel.deviceId, trigger ? ` trigger=${trigger}` : '');
    return;
  }
  markIncomingCallPushDispatched(state, call.callId, channel.deviceId);
  console.log(
    `[push] Attempting call.incoming callId=${call.callId}` +
      ` user=${call.calleeId} device=${channel.deviceId} via ${channel.provider}` +
      (trigger ? ` trigger=${trigger}` : '')
  );
  push
    .sendIncomingCallPush(channel, {
      callId: call.callId,
      callerId: call.callerId,
      ringTimeoutAt: call.ringTimeoutAt ?? null,
    })
    .then((outcome) => handleDeadTokenOutcome(state, outcome))
    .catch((err) => {
      console.error(
        `[push] Failed call.incoming callId=${call.callId}` +
          ` user=${call.calleeId} device=${channel.deviceId} error=${err?.message ?? 'unknown'}`
      );
    });
}

/**
 * @param {ServerState} state
 * @param {CallRecord} call
 * @param {string} deviceId
 * @returns {void}
 */
function scheduleIncomingCallAckTimeout(state, call, deviceId) {
  const entry = getIncomingCallPushStateForCall(state, call.callId);
  if (entry.ackTimeouts.has(deviceId)) return;
  const configuredTimeoutMs = Number(process.env.INCOMING_CALL_ACK_TIMEOUT_MS);
  const ackTimeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : DEFAULT_INCOMING_CALL_ACK_TIMEOUT_MS;
  const timeoutId = setTimeout(() => {
    entry.ackTimeouts.delete(deviceId);
    if (call.status !== 'ringing') return;
    if (hasIncomingCallBeenAcknowledged(state, call.callId, deviceId)) return;
    dispatchIncomingCallPushToDevice(state, call, deviceId, 'ack_timeout', {
      allowConnectedDevicePush: true,
    });
  }, ackTimeoutMs);
  timeoutId.unref?.();
  entry.ackTimeouts.set(deviceId, timeoutId);
}

/**
 * @param {ServerState} state
 * @param {CallRecord} call
 * @returns {void}
 */
function dispatchIncomingCallPushes(state, call) {
  const connections = state.userConnections.get(call.calleeId);
  const connectedDeviceIds = new Set(
    Array.from(connections?.values() || [], (connection) => connection.deviceId)
  );
  const pushChannels = resolveReachableChannels(state, call.calleeId).filter(
    (channel) => channel.type === 'push'
  );
  verboseLog('push', 'call.incoming.channels_resolved', {
    callId: call.callId,
    calleeId: call.calleeId,
    pushChannelCount: pushChannels.length,
    connectedDeviceCount: connectedDeviceIds.size,
  });

  if (pushChannels.length === 0) {
    logIncomingCallPushSkip(call, getNoPushChannelReason(state, call.calleeId));
    return;
  }

  for (const channel of pushChannels) {
    if (connectedDeviceIds.has(channel.deviceId)) {
      logIncomingCallPushSkip(
        call,
        'callee_online',
        channel.deviceId,
        ` activeSockets=${connections?.size ?? 0}`
      );
      scheduleIncomingCallAckTimeout(state, call, channel.deviceId);
      continue;
    }

    attemptIncomingCallPush(state, call, channel);
  }
}

/**
 * @param {ServerState} state
 * @param {string} userId
 * @param {string} deviceId
 * @returns {PushChannel|null}
 */
function findPushChannelForDevice(state, userId, deviceId) {
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

/**
 * @param {ServerState} state
 * @param {string} userId
 * @param {string} deviceId
 * @returns {boolean}
 */
function hasLiveConnectionForDevice(state, userId, deviceId) {
  const connections = state.userConnections.get(userId);
  if (!connections) return false;
  for (const connection of connections.values()) {
    if (connection.deviceId === deviceId) {
      return true;
    }
  }
  return false;
}

/**
 * @param {ServerState} state
 * @param {CallRecord} call
 * @param {string} deviceId
 * @param {string} trigger
 * @param {{ allowConnectedDevicePush?: boolean }} [opts]
 * @returns {void}
 */
function dispatchIncomingCallPushToDevice(
  state,
  call,
  deviceId,
  trigger,
  { allowConnectedDevicePush = false } = {}
) {
  if (call.status !== 'ringing') return;
  const ringTimeoutMs = call.ringTimeoutAt ? new Date(call.ringTimeoutAt).getTime() : null;
  if (ringTimeoutMs !== null && Number.isNaN(ringTimeoutMs)) {
    logIncomingCallPushSkip(call, 'invalid_ring_timeout', deviceId);
    return;
  }
  if (ringTimeoutMs !== null && ringTimeoutMs <= Date.now()) {
    logIncomingCallPushSkip(call, 'ring_timeout_elapsed', deviceId);
    return;
  }
  if (hasIncomingCallBeenAcknowledged(state, call.callId, deviceId)) {
    logIncomingCallPushSkip(call, 'ack_received', deviceId);
    return;
  }
  if (!allowConnectedDevicePush && hasLiveConnectionForDevice(state, call.calleeId, deviceId)) {
    logIncomingCallPushSkip(call, 'callee_online', deviceId);
    return;
  }

  const channel = findPushChannelForDevice(state, call.calleeId, deviceId);
  if (!channel) {
    logIncomingCallPushSkip(call, 'no_push_token', deviceId);
    return;
  }

  attemptIncomingCallPush(state, call, channel, trigger);
}

/**
 * @param {ServerState} state
 * @param {string|null|undefined} userId
 * @param {string|null|undefined} deviceId
 * @returns {void}
 */
function notifyRingingCallsForDisconnectedDevice(state, userId, deviceId) {
  if (!userId || !deviceId) return;
  for (const call of state.calls.values()) {
    if (call.calleeId !== userId || call.status !== 'ringing') continue;
    dispatchIncomingCallPushToDevice(state, call, deviceId, 'socket_disconnected');
  }
}

/**
 * Render the calls that are keeping the callee busy, so a `busy` rejection log
 * names the blocking call instead of only its own callId.
 *
 * @param {ServerState} state
 * @param {CallRecord} call
 * @returns {string}
 */
function describeBusyBlockers(state, call) {
  if (call.status !== 'busy') return '';
  const blockers = describeActiveCallsForUser(state, call.calleeId)
    .filter((blocker) => blocker.callId !== call.callId)
    .map((blocker) => `${blocker.callId}:${blocker.status}:${blocker.ageMs}ms`);
  return blockers.length > 0 ? ` blockedBy=${blockers.join(',')}` : '';
}

/**
 * @param {any} io Socket.IO server.
 * @param {ServerState} state
 * @param {CallRecord} call
 * @returns {void}
 */
function notifyCallCreated(io, state, call) {
  state.telemetry.recordCallCreated(call);
  console.log(
    `[signaling] call.created callId=${call.callId} callerId=${call.callerId} calleeId=${call.calleeId} status=${call.status}`
  );
  verboseLog('calls', 'created', {
    callId: call.callId,
    callerId: call.callerId,
    calleeId: call.calleeId,
    status: call.status,
    hasRingTimeout: Boolean(call.ringTimeoutAt),
  });

  const envelope = createCallEnvelope(call);
  if (call.status === 'ringing') {
    emitToUserSockets(io, call.calleeId, SERVER_EVENTS.CALL_INCOMING, envelope);
    emitToUserSockets(io, call.callerId, SERVER_EVENTS.CALL_RINGING, envelope);

    // Push fallback: deliver the incoming call to every registered device that
    // has no live socket of its own.  This is decided per device rather than
    // per user, so a callee who is connected on one device still gets a push on
    // the phone that is asleep in their pocket — the device that has to ring.
    dispatchIncomingCallPushes(state, call);
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
 *
 * @param {ServerState} state
 * @param {CallRecord} call
 * @param {string|null} reason
 * @returns {void}
 */
function dispatchCallCancelledPushes(state, call, reason) {
  const entry = getIncomingCallPushState(state).get(call.callId);
  if (!entry || entry.pushedDeviceIds.size === 0) return;
  for (const deviceId of entry.pushedDeviceIds) {
    const channel = findPushChannelForDevice(state, call.calleeId, deviceId);
    if (!channel) continue;
    console.log(
      `[push] Attempting call.cancelled callId=${call.callId}` +
        ` user=${call.calleeId} device=${deviceId} via ${channel.provider}`
    );
    push
      .sendCallCancelledPush(channel, { callId: call.callId, reason })
      .then((outcome) => handleDeadTokenOutcome(state, outcome))
      .catch((err) => {
        console.error(
          `[push] Failed call.cancelled callId=${call.callId}` +
            ` user=${call.calleeId} device=${deviceId} error=${err?.message ?? 'unknown'}`
        );
      });
  }
}

/**
 * @param {any} io Socket.IO server.
 * @param {ServerState} state
 * @param {CallRecord} call
 * @param {{ previousStatus: string|null, actor?: string|null, reason?: string|null }} transition
 * @returns {void}
 */
function notifyCallTransition(io, state, call, { previousStatus, actor = null, reason = null }) {
  if (call.status !== 'ringing') {
    if (previousStatus === 'ringing' && TERMINAL_CALL_STATES.has(call.status)) {
      dispatchCallCancelledPushes(state, call, reason ?? call.endReason ?? null);
    }
    clearIncomingCallPushState(state, call.callId);
  }
  if (previousStatus !== null) {
    state.telemetry.recordCallTransition(call, previousStatus);
    console.log(
      `[signaling] call.transition callId=${call.callId} ${previousStatus}->${call.status}` +
        (reason ? ` reason=${reason}` : '') +
        (actor ? ` actor=${actor}` : '')
    );
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
    call,
  };
  emitToUserSockets(io, call.callerId, SERVER_EVENTS.CALL_STATE_CHANGED, statePayload);
  emitToUserSockets(io, call.calleeId, SERVER_EVENTS.CALL_STATE_CHANGED, statePayload);

  // Broadcast the transition on the cross-instance bus (best-effort) so other
  // instances / external observers can react to call lifecycle changes. Socket
  // delivery to participants is handled by the Redis adapter above, so bus
  // subscribers must not re-emit to sockets (to avoid duplicate delivery).
  if (state.messageBus && previousStatus !== null) {
    state.messageBus
      .publish(CALL_TRANSITION_CHANNEL, {
        callId: call.callId,
        previousStatus,
        status: call.status,
        actor,
        reason: statePayload.reason,
      })
      .catch((/** @type {unknown} */ error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[signaling] message bus publish failed: ${message}`);
      });
  }

  const eventName = getCallTransitionEventName(call.status, statePayload.reason);
  if (!eventName) {
    return;
  }

  const eventPayload = {
    version: SIGNALING_VERSION,
    callId: call.callId,
    actor,
    reason: statePayload.reason,
    call,
  };
  emitToUserSockets(io, call.callerId, eventName, eventPayload);
  emitToUserSockets(io, call.calleeId, eventName, eventPayload);
}

module.exports = {
  emitToUserSockets,
  createCallEnvelope,
  getCallTransitionEventName,
  markIncomingCallAcknowledged,
  notifyCallCreated,
  notifyCallTransition,
  notifyRingingCallsForDisconnectedDevice,
};
