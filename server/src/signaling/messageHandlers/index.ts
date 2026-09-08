import { SIGNALING_VERSION } from '../../config.ts';
import { deriveConversationId } from '../../messageStore.ts';
import { normaliseId } from '../../lib/normalize.ts';
import { isBlocked } from '../../security.ts';
import { emitToUserSockets } from '../../domain/notifications.ts';
import { invalidateCache, conversationsCachePrefix, messagesCachePrefix } from '../../cache.ts';
import { deleteAttachmentObject, loadR2Config } from '../../attachments.ts';
import { requireSocketSession, validateSignalingVersion, parseInboundPayload, acknowledgeSuccess, acknowledgeError } from '../ack.ts';
import { CLIENT_EVENTS, SERVER_EVENTS, ERROR_CODES, parseEventPayload } from '../../../../shared/index.ts';
import { handleMessageSend } from './send.ts';
import { describeError } from '../../lib/errors.ts';
import { parseClientMessageId, validateBody, validateReactionEmoji } from './validation.ts';
import { deliverMessage } from './delivery.ts';

async function ensureCanDeleteMessage(
  state: import('../../stores/contracts.ts').ServerState,
  requesterId: string,
  conversationId: string,
  messageId: string
): Promise<{ ok: true; attachmentUrl: unknown; } | { ok: false; code: string; message: string; }> {
  const existing = await state.messageStore.getMessage(conversationId, messageId);
  if (!existing || existing.deletedAt) {
    return { ok: false, code: ERROR_CODES.NOT_FOUND, message: 'message not found' };
  }
  if (existing.senderId !== requesterId) {
    return {
      ok: false,
      code: ERROR_CODES.FORBIDDEN,
      message: 'you can only delete your own messages',
    };
  }
  return { ok: true, attachmentUrl: existing.attachment?.url };
}

function registerMessageHandlers(
  socket: import('socket.io').Socket,
  { io, state }: { io: import('socket.io').Server; state: import('../../stores/contracts.ts').ServerState; }
) {
  socket.on(CLIENT_EVENTS.MESSAGE_SEND, async (payload = {}, ack: Function | undefined) => {
    if (!requireSocketSession(socket, ack, CLIENT_EVENTS.MESSAGE_SEND)) {
      return;
    }
    if (!validateSignalingVersion(socket, payload, ack, CLIENT_EVENTS.MESSAGE_SEND)) {
      return;
    }
    const senderId = socket.data.identity.userId;
    const rateCheck = state.messageSendRateLimiter.check(senderId);
    if (!rateCheck.allowed) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_SEND,
        ERROR_CODES.RATE_LIMITED,
        'message rate limit exceeded',
        state
      );
      return;
    }
    await handleMessageSend(socket, payload, ack, { io, state });
  });

  socket.on(CLIENT_EVENTS.MESSAGE_DELETE, async (payload = {}, ack: Function | undefined) => {
    if (!requireSocketSession(socket, ack, CLIENT_EVENTS.MESSAGE_DELETE)) {
      return;
    }
    if (!validateSignalingVersion(socket, payload, ack, CLIENT_EVENTS.MESSAGE_DELETE)) {
      return;
    }

    const requesterId = socket.data.identity.userId;
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
    let entitlement: Awaited<ReturnType<typeof ensureCanDeleteMessage>>;
    try {
      entitlement = await ensureCanDeleteMessage(
        state,
        requesterId,
        conversationId,
        messageId
      );
      if (!entitlement.ok) {
        acknowledgeError(
          socket,
          ack,
          CLIENT_EVENTS.MESSAGE_DELETE,
          entitlement.code,
          entitlement.message,
          state
        );
        return;
      }
    } catch (error) {
      console.error(`[messages] failed to verify delete entitlement: ${describeError(error)}`);
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_DELETE,
        ERROR_CODES.INTERNAL_ERROR,
        'could not verify delete entitlement',
        state
      );
      return;
    }

    let deleted;
    try {
      deleted = await state.messageStore.deleteMessage(conversationId, messageId, requesterId);
    } catch (error) {
      console.error(`[messages] failed to delete message: ${describeError(error)}`);
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

    const r2Config = loadR2Config();
    if (r2Config && entitlement.attachmentUrl) {
      void deleteAttachmentObject({ config: r2Config, url: entitlement.attachmentUrl })
        .then((removed) => {
          if (!removed) {
            console.error(`[messages] failed to delete attachment for messageId=${messageId}`);
          }
        })
        .catch((error) => {
          console.error(
            `[messages] failed to delete attachment for messageId=${messageId}: ${describeError(error)}`
          );
        });
    }

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
      message: deleted,
    };
    emitToUserSockets(io, peerId, SERVER_EVENTS.MESSAGE_DELETED, envelope);
    emitToUserSockets(io, requesterId, SERVER_EVENTS.MESSAGE_DELETED, envelope);

    acknowledgeSuccess(socket, ack, CLIENT_EVENTS.MESSAGE_DELETE, { messageId, conversationId });
  });

  socket.on(CLIENT_EVENTS.MESSAGE_REACT, async (payload = {}, ack: Function | undefined) => {
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

    if (isBlocked(state.blocks, peerId, requesterId) || isBlocked(state.blocks, requesterId, peerId)) {
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
      console.error(`[messages] failed to persist reaction: ${describeError(error)}`);
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

  socket.on(CLIENT_EVENTS.MESSAGE_TYPING, (payload = {}) => {
    if (!socket.data.identity?.sessionId) return;
    if ((payload as Record<string, unknown>).version !== SIGNALING_VERSION) {
      return;
    }

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
  deliverMessage,
  registerMessageHandlers,
  validateBody as _validateBody,
  validateReactionEmoji as _validateReactionEmoji,
};
