import { SIGNALING_VERSION } from '../../config.ts';
import { createMessageRecord, deriveConversationId } from '../../messageStore.ts';
import { normaliseId } from '../../lib/normalize.ts';
import { isBlocked } from '../../security.ts';
import { emitToUserSockets } from '../../domain/notifications.ts';
import { invalidateCache, conversationsCachePrefix, messagesCachePrefix } from '../../cache.ts';
import { acknowledgeError, acknowledgeSuccess, parseInboundPayload } from '../ack.ts';
import { CLIENT_EVENTS, ERROR_CODES, SERVER_EVENTS } from '../../../../shared/index.ts';
import { describeError } from '../../lib/errors.ts';
import { deliverMessage } from './delivery.ts';
import {
  isAttachmentMessageType,
  parseClientMessageId,
  validateAttachment,
  validateBody,
  validateMessageType,
} from './validation.ts';

type MessageSendContext = {
  io: import('socket.io').Server;
  state: import('../../stores/contracts.ts').ServerState;
};

function sameAcceptedSend(
  a: import('../../messageStore.ts').StoredMessage,
  b: import('../../messageStore.ts').StoredMessage
): boolean {
  return (
    a.senderId === b.senderId &&
    a.recipientId === b.recipientId &&
    a.conversationId === b.conversationId &&
    a.body === b.body &&
    a.type === b.type &&
    a.replyTo === b.replyTo &&
    JSON.stringify(a.attachment ?? null) === JSON.stringify(b.attachment ?? null)
  );
}

async function persistAcceptedMessage(
  state: import('../../stores/contracts.ts').ServerState,
  message: import('../../messageStore.ts').StoredMessage,
  recipientWasOnline: boolean
): Promise<{ message: import('../../messageStore.ts').StoredMessage; inserted: boolean; }> {
  const result = state.messageStore.saveMessageWithStatus
    ? await state.messageStore.saveMessageWithStatus(message)
    : { message: await state.messageStore.saveMessage(message), inserted: true };
  const saved = result.message;
  if (!sameAcceptedSend(saved, message)) {
    console.error(
      `[messages] rejected messageId collision messageId=${message.messageId}` +
        ` conversationId=${message.conversationId}`
    );
    throw new Error('messageId already belongs to a different message');
  }
  await invalidateCache(
    state,
    conversationsCachePrefix(message.senderId),
    conversationsCachePrefix(message.recipientId),
    messagesCachePrefix(message.conversationId)
  );
  if (recipientWasOnline && result.inserted) {
    if (typeof state.messageStore.enqueueDeliveryReceipt === 'function') {
      state.messageStore.enqueueDeliveryReceipt({
        messageId: message.messageId,
        userId: message.recipientId,
        conversationId: message.conversationId,
      });
    } else {
      await state.messageStore.markDelivered(
        message.messageId,
        message.recipientId,
        message.conversationId
      );
    }
    await invalidateCache(state, messagesCachePrefix(message.conversationId));
  }
  return result;
}

type SendValidationResult =
  | {
      ok: true;
      recipientId: string;
      messageType: string;
      body: string;
      attachment: import('../../../../shared/signaling/schemas.ts').AttachmentRecord | null;
      replyTo: string | null;
      clientMessageId: string | undefined;
    }
  | { ok: false; code: string; message: string; };

function validateRecipient(
  senderId: string,
  parsed: Record<string, any>
): { ok: true; recipientId: string; } | { ok: false; code: string; message: string; } {
  const recipientId = normaliseId(parsed.recipientId) as string;
  if (recipientId === senderId) {
    return { ok: false, code: ERROR_CODES.BAD_REQUEST, message: 'cannot message yourself' };
  }
  return { ok: true, recipientId };
}

function validateAttachmentPayload(
  messageType: string,
  parsed: Record<string, any>
):
  | {
      ok: true;
      attachment: import('../../../../shared/signaling/schemas.ts').AttachmentRecord | null;
    }
  | { ok: false; code: string; message: string; } {
  const carriesAttachment = isAttachmentMessageType(messageType);
  if (!carriesAttachment) {
    if (parsed.attachment) {
      return {
        ok: false,
        code: ERROR_CODES.BAD_REQUEST,
        message: `${messageType} messages cannot carry an attachment`,
      };
    }
    return { ok: true, attachment: null };
  }

  const validatedAttachment = validateAttachment(messageType, parsed.attachment);
  if (validatedAttachment.error) {
    return { ok: false, code: validatedAttachment.error, message: validatedAttachment.message };
  }

  return { ok: true, attachment: validatedAttachment.attachment ?? null };
}

function validateReplyTo(
  parsed: Record<string, any>
): { ok: true; replyTo: string | null; } | { ok: false; code: string; message: string; } {
  if (parsed.replyTo === undefined || parsed.replyTo === null) {
    return { ok: true, replyTo: null };
  }

  const replyTo = parseClientMessageId(parsed.replyTo);
  if (!replyTo) {
    return { ok: false, code: ERROR_CODES.BAD_REQUEST, message: 'replyTo must be url-safe' };
  }
  return { ok: true, replyTo };
}

function validateOptionalMessageId(
  parsed: Record<string, any>
): { ok: true; clientMessageId: string | undefined; } | { ok: false; code: string; message: string; } {
  if (parsed.messageId === undefined) {
    return { ok: true, clientMessageId: undefined };
  }

  const clientMessageId = parseClientMessageId(parsed.messageId);
  if (!clientMessageId) {
    return { ok: false, code: ERROR_CODES.BAD_REQUEST, message: 'messageId must be url-safe' };
  }

  return { ok: true, clientMessageId };
}

function validateMessagePayload(
  senderId: string,
  parsed: Record<string, any>
): SendValidationResult {
  const recipient = validateRecipient(senderId, parsed);
  if (!recipient.ok) return recipient;

  const typed = validateMessageType(parsed.type);
  if (typed.error) {
    return { ok: false, code: typed.error, message: typed.message };
  }
  const messageType = typed.type as string;

  const body = validateBody(parsed.body, { allowEmpty: isAttachmentMessageType(messageType) });
  if (body.error) {
    return { ok: false, code: body.error, message: body.message };
  }

  const attachment = validateAttachmentPayload(messageType, parsed);
  if (!attachment.ok) return attachment;

  const reply = validateReplyTo(parsed);
  if (!reply.ok) return reply;

  const messageId = validateOptionalMessageId(parsed);
  if (!messageId.ok) return messageId;

  const messageBody = body.body as string;

  return {
    ok: true,
    recipientId: recipient.recipientId,
    messageType,
    body: messageBody,
    attachment: attachment.attachment,
    replyTo: reply.replyTo,
    clientMessageId: messageId.clientMessageId,
  };
}

function ensureNotBlocked(
  state: import('../../stores/contracts.ts').ServerState,
  senderId: string,
  recipientId: string
): { ok: true; } | { ok: false; code: string; message: string; } {
  if (isBlocked(state.blocks, recipientId, senderId) || isBlocked(state.blocks, senderId, recipientId)) {
    state.auditLog.record({
      event: 'message.blocked',
      actor: senderId,
      target: recipientId,
      outcome: 'rejected',
      details: { via: 'websocket' },
    });
    console.log(`[security] message.blocked senderId=${senderId} recipientId=${recipientId}`);
    return { ok: false, code: ERROR_CODES.FORBIDDEN, message: 'you cannot message this user' };
  }
  return { ok: true };
}

async function handleMessageSend(
  socket: import('socket.io').Socket,
  payload: unknown,
  ack: Function | undefined,
  { io, state }: MessageSendContext
) {
  const senderId = socket.data.identity.userId;
  const parsed = parseInboundPayload(socket, ack, CLIENT_EVENTS.MESSAGE_SEND, payload, state);
  if (!parsed) return;

  const validated = validateMessagePayload(senderId, parsed);
  if (!validated.ok) {
    acknowledgeError(
      socket,
      ack,
      CLIENT_EVENTS.MESSAGE_SEND,
      validated.code,
      validated.message,
      state
    );
    return;
  }

  const blockCheck = ensureNotBlocked(state, senderId, validated.recipientId);
  if (!blockCheck.ok) {
    acknowledgeError(
      socket,
      ack,
      CLIENT_EVENTS.MESSAGE_SEND,
      blockCheck.code,
      blockCheck.message,
      state
    );
    return;
  }

  const message = createMessageRecord({
    conversationId: deriveConversationId(senderId, validated.recipientId),
    senderId,
    recipientId: validated.recipientId,
    body: validated.body,
    type: validated.messageType,
    attachment: validated.attachment,
    replyTo: validated.replyTo,
    messageId: validated.clientMessageId,
  });

  console.log(
    `[messages] message.send messageId=${message.messageId}` +
      ` conversationId=${message.conversationId} senderId=${senderId}`
  );

  const recipientWasOnline = (state.userConnections.get(validated.recipientId)?.size ?? 0) > 0;
  let persisted: { message: import('../../messageStore.ts').StoredMessage; inserted: boolean; };
  try {
    persisted = await persistAcceptedMessage(state, message, recipientWasOnline);
  } catch (error) {
    state.telemetry.recordMessagePersistenceFailure();
    console.error(`[messages] failed to persist accepted message: ${describeError(error)}`);
    acknowledgeError(
      socket,
      ack,
      CLIENT_EVENTS.MESSAGE_SEND,
      ERROR_CODES.INTERNAL_ERROR,
      'message could not be saved',
      state
    );
    return;
  }

  const savedMessage = persisted.message;
  if (persisted.inserted) {
    deliverMessage(io, state, savedMessage);
  }
  acknowledgeSuccess(socket, ack, CLIENT_EVENTS.MESSAGE_SEND, { message: savedMessage });

  const deliveredMessage = recipientWasOnline
    ? { ...savedMessage, deliveredTo: [...new Set([...(savedMessage.deliveredTo ?? []), validated.recipientId])] }
    : savedMessage;

  emitToUserSockets(io, senderId, SERVER_EVENTS.MESSAGE_DELIVERED, {
    version: SIGNALING_VERSION,
    conversationId: savedMessage.conversationId,
    messageId: savedMessage.messageId,
    message: deliveredMessage,
  });
}

export { handleMessageSend };
