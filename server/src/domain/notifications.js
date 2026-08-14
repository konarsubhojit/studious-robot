'use strict';

const push = require('../push');
const { SIGNALING_VERSION, CALL_TRANSITION_CHANNEL } = require('../config');
const { resolveOfflinePushChannels, userRoom } = require('../lib/state');

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
    const pushChannels = resolveOfflinePushChannels(state, call.calleeId);
    for (const channel of pushChannels) {
      push.sendIncomingCallPush(channel, { callId: call.callId, callerId: call.callerId })
        .catch((err) => {
          console.error(
            `[push] Unhandled error for device ${channel.deviceId}: ${err?.message}`,
          );
        });
    }
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
};
