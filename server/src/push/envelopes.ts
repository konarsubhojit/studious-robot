/**
 * Envelope construction: what a notification *says*, independent of how it
 * travels.
 *
 * Every function here is pure (`resolveCallTtlSeconds` reads the clock, and
 * nothing else does I/O), so the shape of every push the server can send is
 * assertable without a network, a provider or a device.
 */

import type {
  CallCancelledPushData,
  CallPushData,
  MessagePushData,
  PushEnvelope,
} from './types.ts';

/**
 * Fallback lifetime of a call push when the call record carries no
 * `ringTimeoutAt`.  Matches the default server ring window
 * (`DEFAULT_RINGING_TIMEOUT_MS`) so a push can never outlive the ring — see
 * {@link resolveCallTtlSeconds}.
 */
const INCOMING_CALL_TTL_SECONDS = 120;

/**
 * Lifetime of a `call.cancelled` push.  Short: it is only useful while the
 * stale incoming-call notification is still on screen, and a device that was
 * offline for a minute never showed one.
 */
const CANCELLED_CALL_TTL_SECONDS = 60;

/**
 * Maximum number of characters of a message body carried in a push payload.
 * Long messages are truncated so the notification stays a preview and the
 * payload stays well inside the provider size limits.
 */
const MESSAGE_PREVIEW_MAX_LENGTH = 120;

/**
 * Derive the push time-to-live from the time left in the ring window.
 *
 * A late-delivered call push must never ring a call that has already timed
 * out, so the TTL tracks the *remaining* ring time rather than a fixed value:
 * a push handed to the provider 100s into a 120s ring window expires in 20s,
 * exactly when the call does.  Falls back to
 * {@link INCOMING_CALL_TTL_SECONDS} when the caller supplied no timeout.
 *
 * @param ringTimeoutAt - ISO 8601 ring deadline.
 * @returns TTL in seconds (at least 1).
 */
export function resolveCallTtlSeconds(ringTimeoutAt: string | null | undefined): number {
  if (!ringTimeoutAt) return INCOMING_CALL_TTL_SECONDS;
  const deadlineMs = new Date(ringTimeoutAt).getTime();
  if (!Number.isFinite(deadlineMs)) return INCOMING_CALL_TTL_SECONDS;
  return Math.max(1, Math.ceil((deadlineMs - Date.now()) / 1000));
}

/**
 * Describe an incoming call as a transport-neutral push envelope.
 */
export function buildCallEnvelope(callData: CallPushData): PushEnvelope {
  return {
    type: 'call.incoming',
    ttlSeconds: resolveCallTtlSeconds(callData.ringTimeoutAt),
    title: 'Incoming call',
    body: `Call from ${callData.callerId}`,
    deepLink: `wetalk://call/${callData.callId}`,
    data: {
      callId: callData.callId,
      callerId: callData.callerId,
    },
  };
}

/**
 * Describe a received text message as a transport-neutral push envelope.
 *
 * The title is the sender and the body a preview of what they wrote, because
 * the client renders this notification itself: message pushes are data-only
 * (see `buildDataBlock`), so whatever is not in `data` cannot be shown.
 *
 * @param messageData
 */
export function buildMessageEnvelope(messageData: MessagePushData): PushEnvelope {
  const preview =
    typeof messageData.preview === 'string' ? messageData.preview.trim().replace(/\s+/g, ' ') : '';
  const truncated =
    preview.length > MESSAGE_PREVIEW_MAX_LENGTH
      ? `${preview.slice(0, MESSAGE_PREVIEW_MAX_LENGTH - 1)}…`
      : preview;
  return {
    type: 'message.received',
    title: messageData.senderId,
    body: truncated || 'Sent you a message',
    deepLink: `wetalk://chat/${messageData.conversationId}`,
    data: {
      messageId: messageData.messageId,
      conversationId: messageData.conversationId,
      senderId: messageData.senderId,
    },
  };
}

/**
 * Describe a call that stopped ringing as a transport-neutral push envelope.
 *
 * Sent so a killed app — which has no socket and therefore never sees
 * `call.state_changed` — can dismiss the incoming-call notification it is
 * still showing for a call nobody can answer any more.
 */
export function buildCallCancelledEnvelope(callData: CallCancelledPushData): PushEnvelope {
  return {
    type: 'call.cancelled',
    ttlSeconds: CANCELLED_CALL_TTL_SECONDS,
    title: 'Call ended',
    body: 'The call is no longer ringing',
    deepLink: `wetalk://call/${callData.callId}`,
    data: {
      callId: callData.callId,
      reason: callData.reason || 'ended',
    },
  };
}
