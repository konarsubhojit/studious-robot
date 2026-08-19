'use strict';

const { SIGNALING_VERSION } = require('../config');
const { MAX_MESSAGE_BODY_LENGTH, deriveConversationId } = require('../messageStore');
const { normaliseId } = require('../lib/normalize');
const { isBlocked } = require('../security');
const { emitToUserSockets } = require('../domain/notifications');
const { resolveOfflinePushChannels } = require('../lib/state');
const {
  invalidateCache,
  conversationsCachePrefix,
  messagesCachePrefix,
} = require('../cache');
const { pruneDeadDevice } = require('../lib/persistence');
const push = require('../push');
const {
  requireSocketSession,
  validateSignalingVersion,
  parseInboundPayload,
  acknowledgeSuccess,
  acknowledgeError,
} = require('./ack');
const {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  ERROR_CODES,
  parseEventPayload,
} = require('../../../shared');

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
  emitToUserSockets(io, message.recipientId, SERVER_EVENTS.MESSAGE_RECEIVED, envelope);

  // Push fallback for devices the recipient is not currently connected on —
  // decided per device, exactly like the incoming-call fallback.
  const pushChannels = resolveOfflinePushChannels(state, message.recipientId);
  for (const channel of pushChannels) {
    push
      .sendMessagePush(channel, {
        messageId: message.messageId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        preview: message.body,
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
  socket.on(CLIENT_EVENTS.MESSAGE_SEND, async (payload = {}, ack) => {
    if (!requireSocketSession(socket, ack, CLIENT_EVENTS.MESSAGE_SEND)) {
      return;
    }
    if (!validateSignalingVersion(socket, payload, ack, CLIENT_EVENTS.MESSAGE_SEND)) {
      return;
    }

    const senderId = socket.data.identity.userId;
    // Rate limiting runs before schema validation so a flood of malformed
    // payloads is throttled exactly like well-formed ones.
    const rateCheck = state.messageSendRateLimiter.check(senderId);
    if (!rateCheck.allowed) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_SEND,
        ERROR_CODES.RATE_LIMITED,
        'message rate limit exceeded',
        state,
      );
      return;
    }

    const parsed = parseInboundPayload(socket, ack, CLIENT_EVENTS.MESSAGE_SEND, payload, state);
    if (!parsed) return;

    const recipientId = normaliseId(parsed.recipientId);
    if (recipientId === senderId) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_SEND,
        ERROR_CODES.BAD_REQUEST,
        'cannot message yourself',
        state
      );
      return;
    }

    const validated = validateBody(parsed.body);
    if (validated.error) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_SEND,
        validated.error,
        validated.message,
        state
      );
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
        CLIENT_EVENTS.MESSAGE_SEND,
        ERROR_CODES.FORBIDDEN,
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
        // Client-generated id, when the sender supplies one: the store upserts
        // on `{ conversationId, messageId }`, so a send replayed from the
        // sender's durable outbox is stored exactly once.
        messageId: parsed.messageId ? normaliseId(parsed.messageId) : undefined,
      });
    } catch (error) {
      console.error(`[messages] failed to persist message: ${error?.message}`);
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_SEND,
        ERROR_CODES.INTERNAL_ERROR,
        'could not store message',
        state
      );
      return;
    }

    // A client-supplied id that already belongs to a *different* message is not
    // a replay: the store kept the original, so echoing this payload back (or
    // delivering it) would let a sender overwrite what the peer already sees.
    if (message.senderId !== senderId || message.recipientId !== recipientId) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_SEND,
        ERROR_CODES.BAD_REQUEST,
        'messageId already used by another message',
        state
      );
      return;
    }

    // A new message changes both participants' conversation lists and the
    // conversation's first history page: evict before anyone can read them.
    await invalidateCache(
      state,
      conversationsCachePrefix(senderId),
      conversationsCachePrefix(recipientId),
      messagesCachePrefix(message.conversationId)
    );

    console.log(
      `[messages] message.send messageId=${message.messageId}` +
        ` conversationId=${message.conversationId} senderId=${senderId}`
    );

    deliverMessage(io, state, message);
    acknowledgeSuccess(socket, ack, CLIENT_EVENTS.MESSAGE_SEND, { message });

    // A connected recipient received the message on one of their live sockets
    // above, so record the delivery receipt. The sender's UI uses it to move
    // the message's status from "sent" to "delivered".
    let deliveredMessage = message;
    if ((state.userConnections.get(recipientId)?.size ?? 0) > 0) {
      try {
        deliveredMessage =
          (await state.messageStore.markDelivered(message.messageId, recipientId)) ?? message;
        // Delivery receipts change the stored message, so the cached history
        // page for this conversation is now stale.
        await invalidateCache(state, messagesCachePrefix(message.conversationId));
      } catch (error) {
        console.error(`[messages] failed to mark message delivered: ${error?.message}`);
      }
    }

    // Confirm back to the sender that the message left the server.
    emitToUserSockets(io, senderId, SERVER_EVENTS.MESSAGE_DELIVERED, {
      version: SIGNALING_VERSION,
      conversationId: message.conversationId,
      messageId: message.messageId,
      message: deliveredMessage,
    });
  });

  /**
   * `message.typing` — ephemeral, fire-and-forget typing indicator. Not
   * persisted; simply relayed to the recipient's live socket(s) so their chat
   * UI can show/hide a "user is typing…" hint. No ack is sent back since the
   * sender does not need confirmation, matching how a throttled UI event
   * should behave (best-effort, never blocking the composer).
   */
  socket.on(CLIENT_EVENTS.MESSAGE_TYPING, (payload = {}) => {
    if (!socket.data.identity?.sessionId) return;
    if (payload?.version !== SIGNALING_VERSION) return;

    // Fire-and-forget: a malformed indicator is logged and dropped rather than
    // acknowledged, since the sender is not waiting on a reply.
    const parsed = parseEventPayload(CLIENT_EVENTS.MESSAGE_TYPING, payload);
    if (!parsed.success) {
      console.warn(
        `[messages] rejected malformed payload event=${CLIENT_EVENTS.MESSAGE_TYPING}` +
          ` user=${socket.data.identity.userId} reason=${parsed.error.message}`
      );
      return;
    }

    const senderId = socket.data.identity.userId;
    const recipientId = normaliseId(parsed.data.recipientId);
    if (!recipientId || recipientId === senderId) return;

    emitToUserSockets(io, recipientId, SERVER_EVENTS.MESSAGE_TYPING, {
      version: SIGNALING_VERSION,
      conversationId: deriveConversationId(senderId, recipientId),
      senderId,
      isTyping: Boolean(parsed.data.isTyping),
    });
  });
}

module.exports = {
  registerMessageHandlers,
  deliverMessage,
  _validateBody: validateBody,
};
