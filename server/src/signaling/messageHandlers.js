'use strict';

const { SIGNALING_VERSION } = require('../config');
const { MAX_MESSAGE_BODY_LENGTH, deriveConversationId } = require('../messageStore');
const { normaliseId } = require('../lib/normalize');
const { isBlocked } = require('../security');
const { emitToUserSockets } = require('../domain/notifications');
const { resolveOfflinePushChannels } = require('../lib/state');
const { pruneDeadDevice } = require('../lib/persistence');
const push = require('../push');
const {
  requireSocketSession,
  validateSignalingVersion,
  acknowledgeSuccess,
  acknowledgeError,
} = require('./ack');

/**
 * Text-chat signaling handlers.
 *
 * Follows the same conventions as the `call.*` handlers: a `version` field is
 * required on every payload, acknowledgements use the shared `{ ok, version,
 * event, … }` envelope, and errors reuse the canonical codes (`unauthorized`,
 * `forbidden`, `bad_request`, `unsupported_version`).
 */

/**
 * Validate a message body, returning the trimmed text or an error code.
 *
 * @param {unknown} value
 * @returns {{ body: string } | { error: string, message: string }}
 */
function validateBody(value) {
  if (typeof value !== 'string') {
    return { error: 'bad_request', message: 'body must be a string' };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { error: 'bad_request', message: 'body must not be empty' };
  }
  if (trimmed.length > MAX_MESSAGE_BODY_LENGTH) {
    return {
      error: 'bad_request',
      message: `body must be at most ${MAX_MESSAGE_BODY_LENGTH} characters`,
    };
  }
  return { body: trimmed };
}

/**
 * Deliver a saved message to the recipient: over their live sockets, and via
 * push to every registered device that has no socket of its own.
 *
 * @param {import('socket.io').Server} io
 * @param {object} state
 * @param {object} message
 */
function deliverMessage(io, state, message) {
  const envelope = {
    version: SIGNALING_VERSION,
    conversationId: message.conversationId,
    message,
  };
  emitToUserSockets(io, message.recipientId, 'message.received', envelope);

  // Push fallback for devices the recipient is not currently connected on —
  // decided per device, exactly like the incoming-call fallback.
  const pushChannels = resolveOfflinePushChannels(state, message.recipientId);
  for (const channel of pushChannels) {
    push
      .sendMessagePush(channel, {
        messageId: message.messageId,
        conversationId: message.conversationId,
        senderId: message.senderId,
      })
      .then((outcome) => {
        if (!outcome?.deadToken) return;
        return pruneDeadDevice(state.db, state, outcome.deviceId, outcome.reason ?? 'unknown');
      })
      .catch((error) => {
        console.error(
          `[messages] Unhandled push error for device ${channel.deviceId}: ${error?.message}`
        );
      });
  }
}

/**
 * Register the `message.*` socket handlers for one connection.
 *
 * @param {import('socket.io').Socket} socket
 * @param {{ io: object, state: object }} ctx
 */
function registerMessageHandlers(socket, { io, state }) {
  socket.on('message.send', async (payload = {}, ack) => {
    if (!requireSocketSession(socket, ack, 'message.send')) {
      return;
    }
    if (!validateSignalingVersion(socket, payload, ack, 'message.send')) {
      return;
    }

    const senderId = socket.data.identity.userId;
    const rateCheck = state.messageSendRateLimiter.check(senderId);
    if (!rateCheck.allowed) {
      acknowledgeError(
        socket,
        ack,
        'message.send',
        'rate_limited',
        'message rate limit exceeded',
        state,
      );
      return;
    }
    const recipientId = normaliseId(payload.recipientId);
    if (!recipientId) {
      acknowledgeError(
        socket,
        ack,
        'message.send',
        'bad_request',
        'recipientId is required',
        state
      );
      return;
    }
    if (recipientId === senderId) {
      acknowledgeError(
        socket,
        ack,
        'message.send',
        'bad_request',
        'cannot message yourself',
        state
      );
      return;
    }

    const validated = validateBody(payload.body);
    if (validated.error) {
      acknowledgeError(socket, ack, 'message.send', validated.error, validated.message, state);
      return;
    }

    // Blocklist: reject when either party has blocked the other, matching the
    // visibility rules already applied by GET /users.
    if (
      isBlocked(state.blocks, recipientId, senderId) ||
      isBlocked(state.blocks, senderId, recipientId)
    ) {
      state.auditLog.record({
        event: 'message.blocked',
        actor: senderId,
        target: recipientId,
        outcome: 'rejected',
        details: { via: 'websocket' },
      });
      console.log(`[security] message.blocked senderId=${senderId} recipientId=${recipientId}`);
      acknowledgeError(
        socket,
        ack,
        'message.send',
        'forbidden',
        'you cannot message this user',
        state
      );
      return;
    }

    let message;
    try {
      message = await state.messageStore.saveMessage({
        conversationId: deriveConversationId(senderId, recipientId),
        senderId,
        recipientId,
        body: validated.body,
      });
    } catch (error) {
      console.error(`[messages] failed to persist message: ${error?.message}`);
      acknowledgeError(
        socket,
        ack,
        'message.send',
        'internal_error',
        'could not store message',
        state
      );
      return;
    }

    console.log(
      `[messages] message.send messageId=${message.messageId}` +
        ` conversationId=${message.conversationId} senderId=${senderId}`
    );

    deliverMessage(io, state, message);
    acknowledgeSuccess(socket, ack, 'message.send', { message });

    // Confirm back to the sender that the message left the server.
    emitToUserSockets(io, senderId, 'message.delivered', {
      version: SIGNALING_VERSION,
      conversationId: message.conversationId,
      messageId: message.messageId,
      message,
    });
  });

  /**
   * `message.typing` — ephemeral, fire-and-forget typing indicator. Not
   * persisted; simply relayed to the recipient's live socket(s) so their chat
   * UI can show/hide a "user is typing…" hint. No ack is sent back since the
   * sender does not need confirmation, matching how a throttled UI event
   * should behave (best-effort, never blocking the composer).
   */
  socket.on('message.typing', (payload = {}) => {
    if (!socket.data.identity?.sessionId) return;
    if (payload?.version !== SIGNALING_VERSION) return;

    const senderId = socket.data.identity.userId;
    const recipientId = normaliseId(payload.recipientId);
    if (!recipientId || recipientId === senderId) return;

    emitToUserSockets(io, recipientId, 'message.typing', {
      version: SIGNALING_VERSION,
      conversationId: deriveConversationId(senderId, recipientId),
      senderId,
      isTyping: Boolean(payload.isTyping),
    });
  });
}

module.exports = {
  registerMessageHandlers,
  deliverMessage,
  _validateBody: validateBody,
};
