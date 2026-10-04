import { SIGNALING_VERSION } from '../../config.ts';
import { createMessageRecord, deriveConversationId } from '../../messageStore.ts';
import { normaliseId } from '../../lib/normalize.ts';
import { isBlockedAsync } from '../../security.ts';
import { emitToUserSockets } from '../../domain/notifications.ts';
import { invalidateCache, conversationsCachePrefix, messagesCachePrefix } from '../../cache.ts';
import { acknowledgeError, acknowledgeSuccess, parseInboundPayload } from '../ack.ts';
import { ATTACHMENT_RECORD_FIELDS, CLIENT_EVENTS, ERROR_CODES, SERVER_EVENTS } from '../../../../shared/index.ts';
import { describeError } from '../../lib/errors.ts';
import { runDetached } from '../../lib/queryTiming.ts';
import { deliverMessage } from './delivery.ts';
import { ConversationStoreError } from '../../conversationStore/types.ts';
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

type MessageTarget = { conversationId: string; recipientId: string; recipientIds: string[]; groupName?: string };

async function resolveMessageTarget(
  state: MessageSendContext['state'],
  senderId: string,
  recipientId: string,
  conversationId: string | null
): Promise<MessageTarget> {
  if (conversationId && !conversationId.includes(':')) {
    const conversation = await state.conversationStore.get(conversationId, senderId);
    if (!conversation) throw new ConversationStoreError('not_member', 'not an active group member');
    return { conversationId, recipientId: conversationId, groupName: conversation.name,
      recipientIds: conversation.memberIds.filter(id => id !== senderId) };
  }
  if (conversationId) {
    const participants = conversationId.split(':');
    recipientId = participants.find(id => id !== senderId) ?? '';
    if (participants.length !== 2 || !participants.includes(senderId) ||
        !recipientId || deriveConversationId(senderId, recipientId) !== conversationId) {
      throw new ConversationStoreError('forbidden', 'not a conversation participant');
    }
  }
  return { conversationId: conversationId ?? deriveConversationId(senderId, recipientId),
    recipientId, recipientIds: [recipientId] };
}

async function saveTargetMessage(
  state: MessageSendContext['state'],
  message: import('../../messageStore.ts').StoredMessage,
  target: { recipientIds: string[]; groupName?: string }
): Promise<import('../../messageStore/types.ts').SaveMessageResult> {
  if (target.groupName !== undefined) {
    const result = await state.conversationStore.saveMessage(message);
    if (!result) throw new ConversationStoreError('not_member', 'not an active group member');
    target.recipientIds = result.recipients.filter(id => id !== message.senderId);
    return result;
  }
  return state.messageStore.saveMessageWithStatus
    ? state.messageStore.saveMessageWithStatus(message)
    : { message: await state.messageStore.saveMessage(message), inserted: true };
}

function sendError(error: unknown, explicitKey: boolean): { code: string; message: string } {
  if (error instanceof ConversationStoreError) return { code: ERROR_CODES.FORBIDDEN, message: error.message };
  if (error instanceof MessageKeyConflictError && explicitKey) {
    return { code: ERROR_CODES.BAD_REQUEST, message: error.message };
  }
  return { code: ERROR_CODES.INTERNAL_ERROR, message: 'message could not be saved' };
}

/**
 * Compare two attachment field values, treating `null` and `undefined` as
 * equivalent for optional fields and doing an element-wise compare for the
 * `waveform` array rather than reference equality.
 */
function attachmentValuesEqual(a: unknown, b: unknown): boolean {
  const normalisedA = a ?? null;
  const normalisedB = b ?? null;
  if (Array.isArray(normalisedA) || Array.isArray(normalisedB)) {
    if (!Array.isArray(normalisedA) || !Array.isArray(normalisedB)) return false;
    if (normalisedA.length !== normalisedB.length) return false;
    return normalisedA.every((value, index) => value === normalisedB[index]);
  }
  return normalisedA === normalisedB;
}

/**
 * Find the first `AttachmentRecord` field that differs between two accepted
 * attachments, or `null` if they represent the same attachment.
 *
 * A `jsonb` round-trip through Postgres normalises key order, so this must
 * compare fields individually rather than via `JSON.stringify` — see the
 * caller for why that distinction matters.
 */
function differingAttachmentField(
  a: import('../../../../shared/signaling/schemas.ts').AttachmentRecord | null | undefined,
  b: import('../../../../shared/signaling/schemas.ts').AttachmentRecord | null | undefined
): string | null {
  const attachmentA = a ?? null;
  const attachmentB = b ?? null;
  if (attachmentA === null && attachmentB === null) return null;
  if (attachmentA === null || attachmentB === null) return 'attachment';
  for (const field of ATTACHMENT_RECORD_FIELDS) {
    if (!attachmentValuesEqual(attachmentA[field], attachmentB[field])) {
      return `attachment.${field}`;
    }
  }
  return null;
}

/**
 * Find the first field that differs between the message a client submitted
 * and the row already stored under the same retry key, or `null` if they
 * describe the same accepted send (an idempotent retry).
 */
function differingAcceptedSendField(
  a: import('../../messageStore.ts').StoredMessage,
  b: import('../../messageStore.ts').StoredMessage
): string | null {
  if (a.senderId !== b.senderId) return 'senderId';
  if (a.recipientId !== b.recipientId) return 'recipientId';
  if (a.conversationId !== b.conversationId) return 'conversationId';
  // Deletion erased the accepted content. An explicit-key replay must return
  // the tombstone, not resurrect it or fail a lost ack; retained routing/type/
  // reply fields still detect mismatched reuse. Legacy collision rules stay intact.
  if (a.deletedAt && a.clientMessageId && a.clientMessageId === b.clientMessageId) {
    if (a.type !== b.type) return 'type';
    return a.replyTo !== b.replyTo ? 'replyTo' : null;
  }
  if (a.body !== b.body) return 'body';
  if (a.type !== b.type) return 'type';
  if (a.replyTo !== b.replyTo) return 'replyTo';
  return differingAttachmentField(a.attachment, b.attachment);
}

/**
 * Evict the sender's own conversation-list cache entry, fire-and-forget.
 *
 * See the call site in {@link persistAcceptedMessage} for why this is the one
 * invalidation on the send path safe to defer past the ack.
 */
function invalidateSenderConversationsCacheDetached(
  state: import('../../stores/contracts.ts').ServerState,
  senderId: string
): void {
  runDetached(() => invalidateCache(state, conversationsCachePrefix(senderId))).catch(
    (error: unknown) => {
      console.error(`[messages] sender conversations cache invalidation failed: ${describeError(error)}`);
    }
  );
}

async function persistAcceptedMessage(
  state: import('../../stores/contracts.ts').ServerState,
  message: import('../../messageStore.ts').StoredMessage,
  recipientWasOnline: boolean,
  target: { recipientIds: string[]; groupName?: string }
): Promise<{ message: import('../../messageStore.ts').StoredMessage; inserted: boolean; }> {
  const result = await saveTargetMessage(state, message, target);
  const saved = result.message;
  const mismatchedField = differingAcceptedSendField(saved, message);
  if (mismatchedField) {
    console.error(
      `[messages] rejected message key collision messageId=${message.messageId}` +
        ` conversationId=${message.conversationId} field=${mismatchedField}`
    );
    throw new MessageKeyConflictError('message key already belongs to a different message');
  }
  // The sender's own conversation-list entry is evicted off the ack path
  // (fire-and-forget): the sender's copy of this exact message is already
  // embedded in the ack payload the caller sends once this function returns,
  // so nothing the sender's client does *because of* the ack can observe a
  // stale conversation list — a subsequent independent refresh racing the
  // eviction is a sub-30ms window that self-heals via the invalidation
  // marker `writeCachedIfNotInvalidated` already checks.
  //
  // The recipient's conversation-list and this conversation's message-page
  // caches stay on the blocking path: `deliverMessage` (called by our caller
  // right after this returns) notifies the recipient's live sockets, and a
  // recipient client that reacts to that notification with an immediate
  // re-fetch must never be served a cache entry that pre-dates this message.
  if (target.groupName === undefined) invalidateSenderConversationsCacheDetached(state, message.senderId);
  await invalidateCache(
    state,
    ...(target.groupName !== undefined ? [conversationsCachePrefix(message.senderId)] : []),
    ...target.recipientIds.map(conversationsCachePrefix),
    messagesCachePrefix(message.conversationId)
  );
  if (result.inserted) {
    state.telemetry.recordMessagePersisted();
  }
  if (recipientWasOnline && result.inserted && target.groupName === undefined) {
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
    state.telemetry.recordMessageDeliveryMarksIssued();
    // Distinct from the invalidation above: this one reflects the delivery
    // -status write just above it (`deliveredTo`), not the insert. It targets
    // the same `messagesCachePrefix` key but at a later point in this
    // function, after data the cached page includes has changed again, so it
    // is not redundant with the first call and must stay on the blocking path
    // for the same recipient-visibility reason.
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
      legacyMessageId: string | undefined;
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
): { ok: true; clientMessageId: string | undefined; legacyMessageId: string | undefined; } | { ok: false; code: string; message: string; } {
  if (parsed.clientMessageId !== undefined) {
    if (typeof parsed.clientMessageId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.clientMessageId)) {
      return { ok: false, code: ERROR_CODES.BAD_REQUEST, message: 'clientMessageId must be a UUID' };
    }
    return { ok: true, clientMessageId: parsed.clientMessageId.toLowerCase(), legacyMessageId: undefined };
  }
  if (parsed.messageId === undefined) {
    return { ok: true, clientMessageId: undefined, legacyMessageId: undefined };
  }

  const clientMessageId = parseClientMessageId(parsed.messageId);
  if (!clientMessageId) {
    return { ok: false, code: ERROR_CODES.BAD_REQUEST, message: 'messageId must be url-safe' };
  }

  return { ok: true, clientMessageId: undefined, legacyMessageId: clientMessageId };
}

function validateMessagePayload(
  senderId: string,
  parsed: Record<string, any>
): SendValidationResult {
  const conversationId = normaliseId(parsed.conversationId);
  const recipient = conversationId
    ? { ok: true as const, recipientId: conversationId }
    : validateRecipient(senderId, parsed);
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
    legacyMessageId: messageId.legacyMessageId,
  };
}

async function ensureNotBlocked(
  state: import('../../stores/contracts.ts').ServerState,
  senderId: string,
  recipientId: string
): Promise<{ ok: true; } | { ok: false; code: string; message: string; }> {
  if (await isBlockedAsync(state, recipientId, senderId) || await isBlockedAsync(state, senderId, recipientId)) {
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

  let target: MessageTarget;
  try {
    target = await resolveMessageTarget(state, senderId, validated.recipientId, normaliseId(parsed.conversationId));
  } catch (error) {
    const failure = sendError(error, false);
    acknowledgeError(socket, ack, CLIENT_EVENTS.MESSAGE_SEND, failure.code, failure.message, state);
    return;
  }

  const blockCheck = target.groupName !== undefined ? { ok: true as const }
    : await ensureNotBlocked(state, senderId, target.recipientId);
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
    conversationId: target.conversationId,
    senderId,
    recipientId: target.recipientId,
    body: validated.body,
    type: validated.messageType,
    attachment: validated.attachment,
    replyTo: validated.replyTo,
    messageId: validated.legacyMessageId,
    clientMessageId: validated.clientMessageId,
  });

  console.log(
    `[messages] message.send messageId=${message.messageId}` +
      ` conversationId=${message.conversationId} senderId=${senderId}`
  );

  const recipientWasOnline = (state.userConnections.get(target.recipientId)?.size ?? 0) > 0;
  let persisted: { message: import('../../messageStore.ts').StoredMessage; inserted: boolean; };
  try {
    persisted = await persistAcceptedMessage(state, message, recipientWasOnline, target);
  } catch (error) {
    state.telemetry.recordMessagePersistenceFailure();
    console.error(`[messages] failed to persist accepted message: ${describeError(error)}`);
    const failure = sendError(error, Boolean(message.clientMessageId) || target.groupName !== undefined);
    acknowledgeError(
      socket,
      ack,
      CLIENT_EVENTS.MESSAGE_SEND,
      failure.code,
      failure.message,
      state
    );
    return;
  }

  const savedMessage = persisted.message;
  if (persisted.inserted) {
    await deliverMessage(io, state, savedMessage, target)
      .catch(error => console.error(`[messages] notification failed: ${describeError(error)}`));
  }
  acknowledgeSuccess(socket, ack, CLIENT_EVENTS.MESSAGE_SEND, { message: savedMessage });

  const deliveredMessage = recipientWasOnline && target.groupName === undefined
    ? { ...savedMessage, deliveredTo: [...new Set([...savedMessage.deliveredTo, target.recipientId])] }
    : savedMessage;

  emitToUserSockets(io, senderId, SERVER_EVENTS.MESSAGE_DELIVERED, {
    version: SIGNALING_VERSION,
    conversationId: savedMessage.conversationId,
    messageId: savedMessage.messageId,
    message: deliveredMessage,
  });
}

export { handleMessageSend };

class MessageKeyConflictError extends Error {}
