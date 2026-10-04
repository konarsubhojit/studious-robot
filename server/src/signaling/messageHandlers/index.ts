import { SIGNALING_VERSION, SUPPORTED_SIGNALING_VERSIONS } from '../../config.ts';
import { deriveConversationId } from '../../messageStore.ts';
import { normaliseId } from '../../lib/normalize.ts';
import { isBlockedAsync } from '../../security.ts';
import { emitToUserSockets } from '../../domain/notifications.ts';
import { invalidateCache, conversationsCachePrefix, messagesCachePrefix } from '../../cache.ts';
import { deleteAttachmentObject, loadR2Config } from '../../attachments.ts';
import { requireSocketSession, validateSignalingVersion, parseInboundPayload, acknowledgeSuccess, acknowledgeError } from '../ack.ts';
import { CLIENT_EVENTS, SERVER_EVENTS, ERROR_CODES, parseEventPayload } from '../../../../shared/index.ts';
import { handleMessageSend } from './send.ts';
import { describeError } from '../../lib/errors.ts';
import { parseClientMessageId, validateBody, validateReactionEmoji } from './validation.ts';
import { deliverMessage } from './delivery.ts';
import { fanoutConversationEvent } from '../../domain/conversationFanout.ts';

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

async function handleGroupMessageDelete(
  socket: import('socket.io').Socket,
  ack: Function | undefined,
  { io, state }: { io: import('socket.io').Server; state: import('../../stores/contracts.ts').ServerState },
  requesterId: string,
  parsed: Record<string, any>
): Promise<boolean> {
  const conversationId = normaliseId(parsed.conversationId);
  if (!conversationId) return false;
  const messageId = parseClientMessageId(parsed.messageId);
  if (!messageId) {
    acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_DELETE, ERROR_CODES.BAD_REQUEST, 'messageId is required', state);
    return true;
  }
  try {
    if (!(await state.conversationStore.getMember(conversationId, requesterId))) {
      acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_DELETE, ERROR_CODES.FORBIDDEN, 'not an active group member', state);
      return true;
    }
    const existing = await state.conversationStore.getMessage(conversationId, messageId);
    if (!existing || existing.deletedAt) {
      acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_DELETE, ERROR_CODES.NOT_FOUND, 'message not found', state);
      return true;
    }
    if (existing.senderId !== requesterId) {
      acknowledgeError(
        socket,
        ack,
        CLIENT_EVENTS.MESSAGE_DELETE,
        ERROR_CODES.FORBIDDEN,
        'you can only delete your own messages',
        state
      );
      return true;
    }
    const result = await state.conversationStore.deleteMessage({
      conversationId,
      messageId,
      userId: requesterId,
    });
    if (!result) {
      acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_DELETE, ERROR_CODES.NOT_FOUND, 'message not found', state);
      return true;
    }
    const r2Config = loadR2Config();
    if (r2Config && existing.attachment?.url) {
      void deleteAttachmentObject({ config: r2Config, url: existing.attachment.url })
        .catch((error) => {
          console.error(
            `[messages] failed to delete group attachment for messageId=${messageId}: ${describeError(error)}`
          );
        });
    }
    await fanoutConversationEvent(io, state, {
      conversationId,
      eventName: SERVER_EVENTS.MESSAGE_DELETED,
      recipientIds: result.recipients,
      payload: {
        version: SIGNALING_VERSION,
        conversationId,
        messageId,
        deletedBy: requesterId,
        message: result.message,
      },
    });
    acknowledgeSuccess(socket, ack, CLIENT_EVENTS.MESSAGE_DELETE, { messageId, conversationId });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'not_member') {
      acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_DELETE, ERROR_CODES.FORBIDDEN, 'not an active group member', state);
    } else {
      console.error(`[messages] failed to delete group message: ${describeError(error)}`);
      acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_DELETE, ERROR_CODES.INTERNAL_ERROR, 'could not delete message', state);
    }
  }
  return true;
}

async function handleGroupMessageReaction(
  socket: import('socket.io').Socket,
  ack: Function | undefined,
  { io, state }: { io: import('socket.io').Server; state: import('../../stores/contracts.ts').ServerState },
  requesterId: string,
  parsed: Record<string, any>
): Promise<boolean> {
  const conversationId = normaliseId(parsed.conversationId);
  if (!conversationId) return false;
  const messageId = parseClientMessageId(parsed.messageId);
  const emoji = validateReactionEmoji(parsed.emoji);
  if (!messageId || !emoji) {
    acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_REACT, ERROR_CODES.BAD_REQUEST, 'messageId and an emoji are required', state);
    return true;
  }
  try {
    if (!(await state.conversationStore.getMember(conversationId, requesterId))) {
      acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_REACT, ERROR_CODES.FORBIDDEN, 'not an active group member', state);
      return true;
    }
    const result = await state.conversationStore.reactToMessage({
      conversationId,
      messageId,
      userId: requesterId,
      emoji,
      action: parsed.action,
    });
    if (!result) {
      acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_REACT, ERROR_CODES.NOT_FOUND, 'message not found', state);
      return true;
    }
    const envelope = {
      version: SIGNALING_VERSION,
      conversationId,
      messageId,
      reactions: result.message.reactions ?? {},
      actorId: requesterId,
      emoji,
      action: parsed.action,
    };
    await fanoutConversationEvent(io, state, {
      conversationId,
      eventName: SERVER_EVENTS.MESSAGE_REACTION,
      recipientIds: result.recipients,
      payload: envelope,
    });
    acknowledgeSuccess(socket, ack, CLIENT_EVENTS.MESSAGE_REACT, {
      messageId,
      conversationId,
      reactions: envelope.reactions,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'not_member') {
      acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_REACT, ERROR_CODES.FORBIDDEN, 'not an active group member', state);
    } else {
      console.error(`[messages] failed to react to group message: ${describeError(error)}`);
      acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_REACT, ERROR_CODES.INTERNAL_ERROR, 'could not store reaction', state);
    }
  }
  return true;
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
    const rateCheck = await state.messageSendRateLimiter.check(senderId);
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
    const rateCheck = await state.messageSendRateLimiter.check(requesterId);
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

    if (await handleGroupMessageDelete(socket, ack, { io, state }, requesterId, parsed)) return;

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
    const rateCheck = await state.messageSendRateLimiter.check(requesterId);
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

    if (await handleGroupMessageReaction(socket, ack, { io, state }, requesterId, parsed)) return;

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

    if (await isBlockedAsync(state, peerId, requesterId) || await isBlockedAsync(state, requesterId, peerId)) {
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

    // A reaction changes `reactions` on the message, and
    // `ConversationSummary.lastMessage` is a full `StoredMessage` — so a cached
    // conversation list can serve a stale reaction set on the preview for up to
    // the TTL. Both participants' lists are evicted for that reason.
    //
    // Unlike `persistAcceptedMessage` in `send.ts`, which deliberately defers
    // the *sender's* conversation-list eviction off the ack path, both
    // evictions stay on the blocking path here: a reaction ack is not
    // latency-critical in the same way (no message delivery is waiting behind
    // it), and the actor's own ack carries the new reaction set, so keeping the
    // simpler awaited form avoids a detached failure mode for no real gain.
    await invalidateCache(
      state,
      conversationsCachePrefix(requesterId),
      conversationsCachePrefix(peerId),
      messagesCachePrefix(conversationId)
    );

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

  socket.on(CLIENT_EVENTS.MESSAGE_TYPING, async (payload = {}) => {
    if (!socket.data.identity?.sessionId) return;
    const version = (payload as Record<string, unknown>).version;
    if (!SUPPORTED_SIGNALING_VERSIONS.some((supportedVersion) => supportedVersion === version)) {
      return;
    }
    socket.data.signalingVersion = version;

    const parsed = parseEventPayload(CLIENT_EVENTS.MESSAGE_TYPING, payload);
    if (!parsed.success) {
      console.warn(
        `[messages] rejected malformed payload event=${CLIENT_EVENTS.MESSAGE_TYPING}` +
          ` user=${socket.data.identity.userId} reason=${parsed.error.message}`
      );
      return;
    }

    const senderId = socket.data.identity.userId;
    const conversationId = normaliseId(parsed.data.conversationId);
    if (conversationId) {
      try {
        if (!(await state.conversationStore.getMember(conversationId, senderId))) return;
        const members = await state.conversationStore.listMembers(conversationId);
        await fanoutConversationEvent(io, state, {
          conversationId,
          eventName: SERVER_EVENTS.MESSAGE_TYPING,
          recipientIds: members.map(({ userId }) => userId).filter((userId) => userId !== senderId),
          payload: {
            version: SIGNALING_VERSION,
            conversationId,
            senderId,
            isTyping: Boolean(parsed.data.isTyping),
          },
        });
      } catch (error) {
        console.error(`[messages] group typing fan-out failed: ${describeError(error)}`);
      }
      return;
    }
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
