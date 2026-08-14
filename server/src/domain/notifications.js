'use strict';

const push = require('../push');
const { SIGNALING_VERSION, CALL_TRANSITION_CHANNEL } = require('../config');
const { resolveReachableChannels, userRoom } = require('../lib/state');

/**
 * Client-facing call notifications.
 *
 * Translates call-record changes into Socket.IO emits (to the caller/callee
 * user rooms), push fallbacks, telemetry, and cross-instance message-bus
 * broadcasts.  Kept separate from the `calls` state machine so the machine has
 * no Socket.IO dependency.
 */

function emitToUserSockets(io, userId, eventName, payload) {
  // Emit to the user's room: locally this reaches every tracked socket, and
  // with the Redis adapter attached it also reaches the user's sockets on other
  // instances.
  io.to(userRoom(userId)).emit(eventName, payload);
}

function createCallEnvelope(call) {
  return {
    version: SIGNALING_VERSION,
    callId: call.callId,
    call,
  };
}

function getCallTransitionEventName(status, reason) {
  if (status === 'accepted') {
    return 'call.accept';
  }
  if (status === 'declined') {
    return 'call.decline';
  }
  if (status === 'ended') {
    return reason === 'cancelled' ? 'call.cancel' : 'call.end';
  }
  return null;
}

function logIncomingCallPushSkip(call, reason, deviceId = null, details = '') {
  console.log(
    `[push] Skipped call.incoming callId=${call.callId} user=${call.calleeId}` +
    (deviceId ? ` device=${deviceId}` : '') +
    ` reason=${reason}` +
    details,
  );
}

function getNoPushChannelReason(state, userId) {
  const deviceIds = state.userDevices.get(userId);
  if (!deviceIds || deviceIds.size === 0) {
    return 'no_device_row';
  }
  return 'no_push_token';
}

function dispatchIncomingCallPushes(state, call) {
  const connections = state.userConnections.get(call.calleeId);
  const connectedDeviceIds = new Set(
    Array.from(connections?.values() || [], (connection) => connection.deviceId),
  );
  const pushChannels = resolveReachableChannels(state, call.calleeId)
    .filter((channel) => channel.type === 'push');

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
        ` activeSockets=${connections?.size ?? 0}`,
      );
      continue;
    }

    console.log(
      `[push] Attempting call.incoming callId=${call.callId}` +
      ` user=${call.calleeId} device=${channel.deviceId} via ${channel.provider}`,
    );
    push.sendIncomingCallPush(channel, { callId: call.callId, callerId: call.callerId })
      .catch((err) => {
        console.error(
          `[push] Failed call.incoming callId=${call.callId}` +
          ` user=${call.calleeId} device=${channel.deviceId} error=${err?.message ?? 'unknown'}`,
        );
      });
  }
}

function findPushChannelForDevice(state, userId, deviceId) {
  const device = state.devices.get(deviceId);
  if (
    !device ||
    device.userId !== userId ||
    !device.pushProvider ||
    !device.pushToken
  ) {
    return null;
  }
  return {
    type: 'push',
    deviceId,
    provider: device.pushProvider,
    pushToken: device.pushToken,
  };
}

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

function dispatchIncomingCallPushToDevice(state, call, deviceId, trigger) {
  if (call.status !== 'ringing') return;
  if (call.ringTimeoutAt && new Date(call.ringTimeoutAt).getTime() <= Date.now()) {
    logIncomingCallPushSkip(call, 'ring_timeout_elapsed', deviceId);
    return;
  }
  if (hasLiveConnectionForDevice(state, call.calleeId, deviceId)) {
    logIncomingCallPushSkip(call, 'callee_online', deviceId);
    return;
  }

  const channel = findPushChannelForDevice(state, call.calleeId, deviceId);
  if (!channel) {
    logIncomingCallPushSkip(call, 'no_push_token', deviceId);
    return;
  }

  console.log(
    `[push] Attempting call.incoming callId=${call.callId}` +
    ` user=${call.calleeId} device=${channel.deviceId} via ${channel.provider}` +
    (trigger ? ` trigger=${trigger}` : ''),
  );
  push.sendIncomingCallPush(channel, { callId: call.callId, callerId: call.callerId })
    .catch((err) => {
      console.error(
        `[push] Failed call.incoming callId=${call.callId}` +
        ` user=${call.calleeId} device=${channel.deviceId} error=${err?.message ?? 'unknown'}`,
      );
    });
}

function notifyRingingCallsForDisconnectedDevice(state, userId, deviceId) {
  if (!userId || !deviceId) return;
  for (const call of state.calls.values()) {
    if (call.calleeId !== userId || call.status !== 'ringing') continue;
    dispatchIncomingCallPushToDevice(state, call, deviceId, 'socket_disconnected');
  }
}

function notifyCallCreated(io, state, call) {
  state.telemetry.recordCallCreated(call);
  console.log(
    `[signaling] call.created callId=${call.callId} callerId=${call.callerId} calleeId=${call.calleeId} status=${call.status}`,
  );

  const envelope = createCallEnvelope(call);
  if (call.status === 'ringing') {
    emitToUserSockets(io, call.calleeId, 'call.incoming', envelope);
    emitToUserSockets(io, call.callerId, 'call.ringing', envelope);

    // Push fallback: deliver the incoming call to every registered device that
    // has no live socket of its own.  This is decided per device rather than
    // per user, so a callee who is connected on one device still gets a push on
    // the phone that is asleep in their pocket — the device that has to ring.
    dispatchIncomingCallPushes(state, call);
  } else {
    const reason = call.status === 'unreachable'
      ? getNoPushChannelReason(state, call.calleeId)
      : `call_status_${call.status}`;
    logIncomingCallPushSkip(call, reason);
  }

  notifyCallTransition(io, state, call, {
    previousStatus: null,
    actor: call.callerId,
    reason: call.endReason,
  });
}

function notifyCallTransition(io, state, call, { previousStatus, actor = null, reason = null }) {
  if (previousStatus !== null) {
    state.telemetry.recordCallTransition(call, previousStatus);
    console.log(
      `[signaling] call.transition callId=${call.callId} ${previousStatus}->${call.status}` +
      (reason ? ` reason=${reason}` : '') +
      (actor ? ` actor=${actor}` : ''),
    );
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
  emitToUserSockets(io, call.callerId, 'call.state_changed', statePayload);
  emitToUserSockets(io, call.calleeId, 'call.state_changed', statePayload);

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
      .catch((error) => {
        console.error(`[signaling] message bus publish failed: ${error?.message}`);
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
  notifyCallCreated,
  notifyCallTransition,
  notifyRingingCallsForDisconnectedDevice,
};
