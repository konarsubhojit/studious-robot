import { SIGNALING_VERSION } from '../config.ts';
import { MAX_MESSAGE_BODY_LENGTH, deriveConversationId } from '../messageStore.ts';
import { normaliseId } from '../lib/normalize.ts';
import { isBlocked } from '../security.ts';
import { emitToUserSockets } from '../domain/notifications.ts';
import { resolveOfflinePushChannels } from '../lib/state.ts';
import { invalidateCache, conversationsCachePrefix, messagesCachePrefix } from '../cache.ts';
import { pruneDeadDevice } from '../lib/persistence.ts';
import { pushSenders } from '../push.ts';
import { requireSocketSession, validateSignalingVersion, parseInboundPayload, acknowledgeSuccess, acknowledgeError } from './ack.ts';
import { CLIENT_EVENTS, SERVER_EVENTS, ERROR_CODES, DEFAULT_MESSAGE_TYPE, MAX_REACTION_LENGTH, MAX_VOICE_DURATION_MS, MESSAGE_TYPES, describeMessagePreview, isAttachmentMessageType, isSupportedMessageType, parseEventPayload } from '../../../shared/index.ts';
import { isManagedAttachmentUrl, loadR2Config, validateAttachmentRequest } from '../attachments.ts';

/**
 * Text-chat signaling handlers.
 *
 * Follows the same conventions as the `call.*` handlers: a `version` field is
 * required on every payload, acknowledgements use the shared `{ ok, version,
 * event, … }` envelope, and errors reuse the canonical codes (`unauthorized`,
 * `forbidden`, `bad_request`, `unsupported_version`).
 */

/**
 * @param {unknown} error
 * @returns {string} the error message, or a stringified fallback.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate a message body, returning the trimmed text or an error code.
 *
 * @param {unknown} value
 * @param {{ allowEmpty?: boolean }} [options] - An attachment message may carry
 *   an empty body: the caption is optional, the attachment is the content.
 * @returns {{ body: string, error?: undefined, message?: undefined }
 *   | { body?: undefined, error: string, message: string }}
 */
function validateBody(value: unknown, { allowEmpty = false }: { allowEmpty?: boolean; } = {}): { body: string; error?: undefined; message?: undefined; } |
{ body?: undefined; error: string; message: string; } {
  if (typeof value !== 'string') {
    return { error: 'bad_request', message: 'body must be a string' };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 && !allowEmpty) {
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
 * Validate the attachment of a rich message.
 *
 * The MIME allowlist and the size cap are re-checked here, not just at
 * presign time: `POST /attachments/presign` and `message.send` are separate
 * requests, and only the second one decides what the recipient is shown.
 * The URL must be one this deployment handed out — an arbitrary URL would make
 * every recipient fetch a host of the sender's choosing.
 *
 * @param {string} type
 * @param {unknown} rawAttachment
 * @returns {{ attachment: Record<string, any>, error?: undefined, message?: undefined }
 *   | { attachment?: undefined, error: string, message: string }}
 */
function validateAttachment(type: string, rawAttachment: unknown): { attachment: Record<string, any>; error?: undefined; message?: undefined; } |
{ attachment?: undefined; error: string; message: string; } {
  if (!rawAttachment || typeof rawAttachment !== 'object' || Array.isArray(rawAttachment)) {
    return { error: 'bad_request', message: `${type} messages require an attachment` };
  }
  const attachment = (rawAttachment as Record<string, any>);

  const config = loadR2Config();
  if (!config) {
    return { error: 'bad_request', message: 'attachment uploads are not enabled' };
  }
  if (!isManagedAttachmentUrl(config, attachment.url)) {
    return { error: 'bad_request', message: 'attachment.url is not a managed upload' };
  }

  const validated = validateAttachmentRequest({
    type,
    mimeType: attachment.mimeType,
    // A client that omits the size is treated as claiming the cap, so the
    // check below stays a check rather than a formality.
    sizeBytes: Number.isInteger(attachment.sizeBytes) ? attachment.sizeBytes : 1,
  });
  if ('error' in validated) {
    return { error: 'bad_request', message: `attachment: ${validated.error}` };
  }

  const durationMs = attachment.durationMs;
  if (durationMs !== undefined && durationMs !== null) {
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > MAX_VOICE_DURATION_MS) {
      return {
        error: 'bad_request',
        message: `attachment.durationMs must be between 0 and ${MAX_VOICE_DURATION_MS}`,
      };
    }
  }

  return {
    attachment: {
      url: String(attachment.url),
      mimeType: validated.mimeType,
      sizeBytes: Number.isInteger(attachment.sizeBytes) ? attachment.sizeBytes : null,
      name: typeof attachment.name === 'string' ? attachment.name.slice(0, 255) : null,
      width: Number.isInteger(attachment.width) ? attachment.width : null,
      height: Number.isInteger(attachment.height) ? attachment.height : null,
      durationMs: Number.isInteger(durationMs) ? durationMs : null,
      thumbnailUrl: isManagedAttachmentUrl(config, attachment.thumbnailUrl)
        ? attachment.thumbnailUrl
        : null,
    },
  };
}

/**
 * Validate the type of an outbound message.
 *
 * `system` is server-owned, so a client may not claim it; an unknown type is
 * rejected outright (a *stored* message with an unknown type is a different
 * matter — readers render those as a neutral placeholder).
 *
 * @param {unknown} value
 * @returns {{ type: string, error?: undefined, message?: undefined }
 *   | { type?: undefined, error: string, message: string }}
 */
function validateMessageType(value: unknown): { type: string; error?: undefined; message?: undefined; } |
{ type?: undefined; error: string; message: string; } {
  if (value === undefined || value === null) return { type: DEFAULT_MESSAGE_TYPE };
  if (!isSupportedMessageType(value) || value === MESSAGE_TYPES.SYSTEM) {
    return { error: 'bad_request', message: 'unsupported message type' };
  }
  return { type: (value as string) };
}

/**
 * Deliver a saved message to the recipient: over their live sockets, and via
 * push to every registered device that has no socket of its own.
 *
 * @param {import('socket.io').Server} io
 * @param {import('../stores/contracts.ts').ServerState} state
 * @param {import('../stores/contracts.ts').MessageRecord} message
 */
function deliverMessage(io: import('socket.io').Server, state: import('../stores/contracts.ts').ServerState, message: import('../stores/contracts.ts').MessageRecord) {
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
    pushSenders
      .sendMessagePush(channel, {
        messageId: message.messageId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        // "📷 Photo" / "🎤 Voice message" rather than an empty preview for a
        // message whose content is not text.
        preview: describeMessagePreview(message),
      })
      .then((outcome) => {
        if (!outcome?.deadToken) return;
        return pruneDeadDevice(state.db, state, outcome.deviceId, outcome.reason ?? 'unknown');
      })
      .catch((error) => {
        console.error(
          `[messages] Unhandled push error for device ${channel.deviceId}: ${errorMessage(error)}`
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
/**
 * Client-supplied message ids are opaque to the server, but they end up in
 * storage keys and in the log line below, so restrict them to a conservative
 * URL-safe alphabet (a UUID qualifies) rather than accepting any string.
 */
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Normalise and validate a client-supplied message id.
 *
 * @param {unknown} value
 * @returns {string|null} the id, or `null` when it is unusable
 */
function parseClientMessageId(value: unknown): string | null {
  const normalised = normaliseId(value);
  return normalised && CLIENT_MESSAGE_ID_PATTERN.test(normalised) ? normalised : null;
}

/**
 * Reactions are stored as object keys (`reactions[emoji]`), so the accepted
 * alphabet excludes the characters Mongo reserves in field names (`.`, `$`)
 * and anything that is not a symbol/emoji — a reaction is not a second, tiny
 * message body.
 *
 * @param {unknown} value
 * @returns {string|null} the emoji, or `null` when it is unusable.
 */
function validateReactionEmoji(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REACTION_LENGTH) return null;
  // Emoji, their modifiers and the joiners that combine them — nothing else.
  return /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f]+$/u.test(trimmed)
    ? trimmed
    : null;
}

/**
 * Register the text-chat socket handlers on a connected socket.
 *
 * @param {import('socket.io').Socket} socket
 * @param {{ io: import('socket.io').Server,
 *   state: import('../stores/contracts.ts').ServerState }} ctx
 */
function registerMessageHandlers(socket: import('socket.io').Socket, { io, state }: {
        io: import('socket.io').Server;
        state: import('../stores/contracts.ts').ServerState;
    }) {
  socket.on(CLIENT_EVENTS.MESSAGE_SEND, async (payload = {}, /** @type {Function|undefined} */ ack: Function | undefined) => {
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

    // The payload is schema-validated above, so `recipientId` is a
    // non-empty id.
    const recipientId = (normaliseId(parsed.recipientId) as string);
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

    const typed = validateMessageType(parsed.type);
    if (typed.error) {
      acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_SEND, typed.error, typed.message, state);
      return;
    }
    // `typed.error` was handled above, so the type is present here.
    const messageType = (typed.type as string);
    const carriesAttachment = isAttachmentMessageType(messageType);

    const validated = validateBody(parsed.body, { allowEmpty: carriesAttachment });
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

    let attachment = null;
    if (carriesAttachment) {
      const validatedAttachment = validateAttachment(messageType, parsed.attachment);
      if (validatedAttachment.error) {
        acknowledgeError(
          socket,
          ack,
          CLIENT_EVENTS.MESSAGE_SEND,
          validatedAttachment.error,
          validatedAttachment.message,
          state
        );
        return;
      }
      attachment = validatedAttachment.attachment;
    } else if (parsed.attachment) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_SEND,
        ERROR_CODES.BAD_REQUEST,
        `${messageType} messages cannot carry an attachment`,
        state
      );
      return;
    }

    let replyTo = null;
    if (parsed.replyTo !== undefined && parsed.replyTo !== null) {
      replyTo = parseClientMessageId(parsed.replyTo);
      if (!replyTo) {
        acknowledgeError(
          socket,
          ack,
          CLIENT_EVENTS.MESSAGE_SEND,
          ERROR_CODES.BAD_REQUEST,
          'replyTo must be url-safe',
          state
        );
        return;
      }
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

    let clientMessageId;
    if (parsed.messageId !== undefined) {
      clientMessageId = parseClientMessageId(parsed.messageId);
      if (!clientMessageId) {
        acknowledgeError(
          socket,
          ack,
          CLIENT_EVENTS.MESSAGE_SEND,
          ERROR_CODES.BAD_REQUEST,
          'messageId must be url-safe',
          state
        );
        return;
      }
    }

    let message;
    try {
      message = await state.messageStore.saveMessage({
        conversationId: deriveConversationId(senderId, recipientId),
        senderId,
        recipientId,
        body: validated.body,
        type: messageType,
        attachment,
        // The quoted message is *not* required to still exist: a reply
        // outlives the deletion of its parent, which the client renders as
        // "Message deleted" rather than a dangling reference.
        replyTo,
        // Client-generated id, when the sender supplies one: the store upserts
        // on `{ conversationId, messageId }`, so a send replayed from the
        // sender's durable outbox is stored exactly once.
        messageId: clientMessageId,
      });
    } catch (error) {
      console.error(`[messages] failed to persist message: ${errorMessage(error)}`);
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
        console.error(`[messages] failed to mark message delivered: ${errorMessage(error)}`);
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
   * `message.delete` — remove one of the *sender's own* messages from the
   * conversation, for both participants.
   *
   * Authorisation lives in the store: the delete is filtered on `senderId`, so
   * a request for a message the caller did not write matches nothing and is
   * reported as `not_found` rather than silently succeeding.
   */
  socket.on(CLIENT_EVENTS.MESSAGE_DELETE, async (payload = {}, /** @type {Function|undefined} */ ack: Function | undefined) => {
    if (!requireSocketSession(socket, ack, CLIENT_EVENTS.MESSAGE_DELETE)) {
      return;
    }
    if (!validateSignalingVersion(socket, payload, ack, CLIENT_EVENTS.MESSAGE_DELETE)) {
      return;
    }

    const requesterId = socket.data.identity.userId;
    // Deletes are cheap but still writes: rate limit them like sends so a
    // malicious client cannot hammer the store.
    const rateCheck = state.messageSendRateLimiter.check(requesterId);
    if (!rateCheck.allowed) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_DELETE,
        ERROR_CODES.RATE_LIMITED,
        'message rate limit exceeded',
        state
      );
      return;
    }

    const parsed = parseInboundPayload(socket, ack, CLIENT_EVENTS.MESSAGE_DELETE, payload, state);
    if (!parsed) return;

    const peerId = normaliseId(parsed.peerId);
    const messageId = parseClientMessageId(parsed.messageId);
    if (!peerId || peerId === requesterId || !messageId) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_DELETE,
        ERROR_CODES.BAD_REQUEST,
        'peerId and a url-safe messageId are required',
        state
      );
      return;
    }

    const conversationId = deriveConversationId(requesterId, peerId);
    let deleted;
    try {
      deleted = await state.messageStore.deleteMessage(conversationId, messageId, requesterId);
    } catch (error) {
      console.error(`[messages] failed to delete message: ${errorMessage(error)}`);
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_DELETE,
        ERROR_CODES.INTERNAL_ERROR,
        'could not delete message',
        state
      );
      return;
    }

    if (!deleted) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_DELETE,
        ERROR_CODES.NOT_FOUND,
        'message not found',
        state
      );
      return;
    }

    // The conversation list preview and the history page both change.
    await invalidateCache(
      state,
      conversationsCachePrefix(requesterId),
      conversationsCachePrefix(peerId),
      messagesCachePrefix(conversationId)
    );

    console.log(
      `[messages] message.delete messageId=${messageId}` +
        ` conversationId=${conversationId} userId=${requesterId}`
    );

    const envelope = {
      version: SIGNALING_VERSION,
      conversationId,
      messageId,
      deletedBy: requesterId,
      // The tombstone the store left behind: the content is gone, the row
      // remains so a reply quoting it still resolves on both clients.
      message: deleted,
    };
    // Both sides are told, so the message disappears from the peer's open
    // conversation and from the sender's other devices.
    emitToUserSockets(io, peerId, SERVER_EVENTS.MESSAGE_DELETED, envelope);
    emitToUserSockets(io, requesterId, SERVER_EVENTS.MESSAGE_DELETED, envelope);

    acknowledgeSuccess(socket, ack, CLIENT_EVENTS.MESSAGE_DELETE, { messageId, conversationId });
  });

  /**
   * `message.react` — add or remove one emoji reaction on a message in the
   * conversation between the caller and `peerId`.
   *
   * The change is persisted and then fanned out to *both* participants'
   * `user:<userId>` rooms, so every device of every participant converges on
   * the same reaction set — including the reacting user's other devices, which
   * is what makes an optimistic local update safe to reconcile.
   *
   * Idempotent: re-adding a reaction the caller already left (or removing one
   * they never left) is a no-op that still acknowledges successfully, so a
   * retry after a flaky connection cannot toggle the reaction off.
   */
  socket.on(CLIENT_EVENTS.MESSAGE_REACT, async (payload = {}, /** @type {Function|undefined} */ ack: Function | undefined) => {
    if (!requireSocketSession(socket, ack, CLIENT_EVENTS.MESSAGE_REACT)) {
      return;
    }
    if (!validateSignalingVersion(socket, payload, ack, CLIENT_EVENTS.MESSAGE_REACT)) {
      return;
    }

    const requesterId = socket.data.identity.userId;
    const rateCheck = state.messageSendRateLimiter.check(requesterId);
    if (!rateCheck.allowed) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_REACT,
        ERROR_CODES.RATE_LIMITED,
        'message rate limit exceeded',
        state
      );
      return;
    }

    const parsed = parseInboundPayload(socket, ack, CLIENT_EVENTS.MESSAGE_REACT, payload, state);
    if (!parsed) return;

    const peerId = normaliseId(parsed.peerId);
    const messageId = parseClientMessageId(parsed.messageId);
    const emoji = validateReactionEmoji(parsed.emoji);
    if (!peerId || peerId === requesterId || !messageId || !emoji) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_REACT,
        ERROR_CODES.BAD_REQUEST,
        'peerId, a url-safe messageId and an emoji are required',
        state
      );
      return;
    }

    if (
      isBlocked(state.blocks, peerId, requesterId) ||
      isBlocked(state.blocks, requesterId, peerId)
    ) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_REACT,
        ERROR_CODES.FORBIDDEN,
        'you cannot message this user',
        state
      );
      return;
    }

    const conversationId = deriveConversationId(requesterId, peerId);
    let updated;
    try {
      updated = await state.messageStore.reactToMessage({
        conversationId,
        messageId,
        userId: requesterId,
        emoji,
        action: parsed.action,
      });
    } catch (error) {
      console.error(`[messages] failed to persist reaction: ${errorMessage(error)}`);
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_REACT,
        ERROR_CODES.INTERNAL_ERROR,
        'could not store reaction',
        state
      );
      return;
    }

    if (!updated) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_REACT,
        ERROR_CODES.NOT_FOUND,
        'message not found',
        state
      );
      return;
    }

    // The stored message changed, so the cached history page is stale.
    await invalidateCache(state, messagesCachePrefix(conversationId));

    const envelope = {
      version: SIGNALING_VERSION,
      conversationId,
      messageId,
      reactions: updated.reactions ?? {},
      actorId: requesterId,
      emoji,
      action: parsed.action,
    };
    emitToUserSockets(io, peerId, SERVER_EVENTS.MESSAGE_REACTION, envelope);
    emitToUserSockets(io, requesterId, SERVER_EVENTS.MESSAGE_REACTION, envelope);

    acknowledgeSuccess(socket, ack, CLIENT_EVENTS.MESSAGE_REACT, {
      messageId,
      conversationId,
      reactions: envelope.reactions,
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
    if ((payload ?? {} as Record<string, unknown>).version !== SIGNALING_VERSION) {
      return;
    }

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

export {
  registerMessageHandlers,
  deliverMessage,
  validateBody as _validateBody,
  validateReactionEmoji as _validateReactionEmoji,
};
