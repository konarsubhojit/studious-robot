import { SIGNALING_VERSION } from '../config.ts';
import { fanoutConversationEvent } from '../domain/conversationFanout.ts';
import { normaliseId } from '../lib/normalize.ts';
import { isBlocked } from '../security.ts';
import { ConversationStoreError } from '../conversationStore.ts';
import { CLIENT_EVENTS, SERVER_EVENTS, ERROR_CODES } from '../../../shared/index.ts';
import { acknowledgeError, acknowledgeSuccess, parseInboundPayload, requireSocketSession, validateSignalingVersion } from './ack.ts';

function rejectStoreError(
  socket: import('socket.io').Socket,
  ack: Function | undefined,
  eventName: string,
  error: unknown,
  state: import('../stores/contracts.ts').ServerState
): boolean {
  if (!(error instanceof ConversationStoreError)) return false;
  const code = error.code === 'not_member' ? ERROR_CODES.FORBIDDEN :
    error.code === 'forbidden' ? ERROR_CODES.FORBIDDEN :
      ERROR_CODES.BAD_REQUEST;
  acknowledgeError(socket, ack, eventName, code, error.message, state);
  return true;
}

function registerConversationHandlers(
  socket: import('socket.io').Socket,
  { io, state, ringingTimeoutMs }: {
    io: import('socket.io').Server;
    state: import('../stores/contracts.ts').ServerState;
    ringingTimeoutMs: number;
  }
): void {
  socket.on(CLIENT_EVENTS.CONVERSATION_CREATE, async (payload = {}, ack) => {
    const eventName = CLIENT_EVENTS.CONVERSATION_CREATE;
    if (!requireSocketSession(socket, ack, eventName)) return;
    if (!validateSignalingVersion(socket, payload, ack, eventName)) return;
    const parsed = parseInboundPayload(socket, ack, eventName, payload, state);
    if (!parsed) return;
    const creatorId = socket.data.identity.userId;
    const inviteeIds = (parsed.inviteeIds as unknown[])
      .map((id) => normaliseId(id))
      .filter((id): id is string => Boolean(id));
    if (
      inviteeIds.length !== parsed.inviteeIds.length ||
      inviteeIds.includes(creatorId) ||
      new Set(inviteeIds).size !== inviteeIds.length ||
      inviteeIds.length === 0 ||
      inviteeIds.length > 15
    ) {
      acknowledgeError(socket, ack, eventName, ERROR_CODES.BAD_REQUEST, 'invalid group members', state);
      return;
    }
    if (inviteeIds.some((userId) =>
      isBlocked(state.blocks, userId, creatorId) || isBlocked(state.blocks, creatorId, userId)
    )) {
      acknowledgeError(socket, ack, eventName, ERROR_CODES.FORBIDDEN, 'you cannot add a blocked user', state);
      return;
    }
    try {
      const result = await state.conversationStore.create({
        name: parsed.name,
        creatorId,
        inviteeIds,
      });
      for (const member of result.members) {
        state.auditLog.record({
          event: 'conversation.membership.created',
          actor: creatorId,
          target: member.userId,
          outcome: 'success',
          details: { conversationId: result.conversation.conversationId, role: member.role },
        });
      }
      await fanoutConversationEvent(io, state, {
        conversationId: result.conversation.conversationId,
        eventName: SERVER_EVENTS.CONVERSATION_UPDATED,
        recipientIds: result.conversation.memberIds,
        payload: {
          version: SIGNALING_VERSION,
          conversation: result.conversation,
          updatedBy: creatorId,
        },
      });
      acknowledgeSuccess(socket, ack, eventName, { conversation: result.conversation });
    } catch (error) {
      if (rejectStoreError(socket, ack, eventName, error, state)) return;
      console.error(`[conversations] create failed: ${error instanceof Error ? error.message : String(error)}`);
      acknowledgeError(socket, ack, eventName, ERROR_CODES.INTERNAL_ERROR, 'could not create group', state);
    }
  });

  socket.on(CLIENT_EVENTS.CONVERSATION_UPDATE, async (payload = {}, ack) => {
    const eventName = CLIENT_EVENTS.CONVERSATION_UPDATE;
    if (!requireSocketSession(socket, ack, eventName)) return;
    if (!validateSignalingVersion(socket, payload, ack, eventName)) return;
    const parsed = parseInboundPayload(socket, ack, eventName, payload, state);
    if (!parsed) return;
    const actorId = socket.data.identity.userId;
    const conversationId = normaliseId(parsed.conversationId);
    if (!conversationId) {
      acknowledgeError(socket, ack, eventName, ERROR_CODES.BAD_REQUEST, 'conversationId is required', state);
      return;
    }
    try {
      const result = await state.conversationStore.updateName({
        conversationId,
        actorId,
        name: parsed.name,
      });
      if (!result) {
        acknowledgeError(socket, ack, eventName, ERROR_CODES.NOT_FOUND, 'group not found', state);
        return;
      }
      state.auditLog.record({
        event: 'conversation.updated',
        actor: actorId,
        target: conversationId,
        outcome: 'success',
        details: { name: result.conversation.name },
      });
      await fanoutConversationEvent(io, state, {
        conversationId,
        eventName: SERVER_EVENTS.CONVERSATION_UPDATED,
        recipientIds: result.conversation.memberIds,
        payload: {
          version: SIGNALING_VERSION,
          conversation: result.conversation,
          updatedBy: actorId,
        },
      });
      acknowledgeSuccess(socket, ack, eventName, { conversation: result.conversation });
    } catch (error) {
      if (rejectStoreError(socket, ack, eventName, error, state)) return;
      console.error(`[conversations] update failed: ${error instanceof Error ? error.message : String(error)}`);
      acknowledgeError(socket, ack, eventName, ERROR_CODES.INTERNAL_ERROR, 'could not update group', state);
    }
  });

  socket.on(CLIENT_EVENTS.CONVERSATION_MEMBER_ADD, async (payload = {}, ack) => {
    const eventName = CLIENT_EVENTS.CONVERSATION_MEMBER_ADD;
    if (!requireSocketSession(socket, ack, eventName)) return;
    if (!validateSignalingVersion(socket, payload, ack, eventName)) return;
    const parsed = parseInboundPayload(socket, ack, eventName, payload, state);
    if (!parsed) return;
    const actorId = socket.data.identity.userId;
    const conversationId = normaliseId(parsed.conversationId);
    const userIds = (parsed.userIds as unknown[]).map((id) => normaliseId(id)).filter((id): id is string => Boolean(id));
    if (!conversationId || userIds.length !== parsed.userIds.length || userIds.length > 15 ||
        userIds.includes(actorId) || new Set(userIds).size !== userIds.length) {
      acknowledgeError(socket, ack, eventName, ERROR_CODES.BAD_REQUEST, 'invalid group members', state);
      return;
    }
    if (userIds.some((userId) =>
      isBlocked(state.blocks, userId, actorId) || isBlocked(state.blocks, actorId, userId)
    )) {
      acknowledgeError(socket, ack, eventName, ERROR_CODES.FORBIDDEN, 'you cannot add a blocked user', state);
      return;
    }
    try {
      const result = await state.conversationStore.addMembers({ conversationId, actorId, userIds });
      if (!result) {
        acknowledgeError(socket, ack, eventName, ERROR_CODES.NOT_FOUND, 'group not found', state);
        return;
      }
      for (const userId of userIds) {
        state.auditLog.record({
          event: 'conversation.membership.created',
          actor: actorId,
          target: userId,
          outcome: 'success',
          details: { conversationId, role: 'member' },
        });
      }
      await fanoutConversationEvent(io, state, {
        conversationId,
        eventName: SERVER_EVENTS.CONVERSATION_UPDATED,
        recipientIds: result.conversation.memberIds,
        payload: { version: SIGNALING_VERSION, conversation: result.conversation, updatedBy: actorId },
      });
      acknowledgeSuccess(socket, ack, eventName, { conversation: result.conversation });
    } catch (error) {
      if (rejectStoreError(socket, ack, eventName, error, state)) return;
      console.error(`[conversations] add members failed: ${error instanceof Error ? error.message : String(error)}`);
      acknowledgeError(socket, ack, eventName, ERROR_CODES.INTERNAL_ERROR, 'could not add group members', state);
    }
  });

  socket.on(CLIENT_EVENTS.CONVERSATION_MEMBER_REMOVE, async (payload = {}, ack) => {
    const eventName = CLIENT_EVENTS.CONVERSATION_MEMBER_REMOVE;
    if (!requireSocketSession(socket, ack, eventName)) return;
    if (!validateSignalingVersion(socket, payload, ack, eventName)) return;
    const parsed = parseInboundPayload(socket, ack, eventName, payload, state);
    if (!parsed) return;
    const actorId = socket.data.identity.userId;
    const conversationId = normaliseId(parsed.conversationId);
    const userId = normaliseId(parsed.userId);
    if (!conversationId || !userId) {
      acknowledgeError(socket, ack, eventName, ERROR_CODES.BAD_REQUEST, 'conversationId and userId are required', state);
      return;
    }
    try {
      const result = await state.conversationStore.removeMember({ conversationId, actorId, userId });
      if (!result) {
        acknowledgeError(socket, ack, eventName, ERROR_CODES.NOT_FOUND, 'group not found', state);
        return;
      }
      state.auditLog.record({
        event: 'conversation.membership.removed',
        actor: actorId,
        target: userId,
        outcome: 'success',
        details: { conversationId },
      });
      await fanoutConversationEvent(io, state, {
        conversationId,
        eventName: SERVER_EVENTS.CONVERSATION_UPDATED,
        recipientIds: [...result.conversation.memberIds, userId],
        payload: { version: SIGNALING_VERSION, conversation: result.conversation, updatedBy: actorId },
      });
      for (const callChange of result.callChanges ?? []) {
        await fanoutConversationEvent(io, state, {
          conversationId,
          eventName: SERVER_EVENTS.CONVERSATION_CALL_UPDATED,
          recipientIds: callChange.participants.map(({ userId: participantId }) => participantId),
          payload: {
            version: SIGNALING_VERSION,
            conversationId,
            callId: callChange.call.callId,
            call: callChange.call,
            participants: callChange.participants,
          },
        });
      }
      acknowledgeSuccess(socket, ack, eventName, { conversation: result.conversation });
    } catch (error) {
      if (rejectStoreError(socket, ack, eventName, error, state)) return;
      console.error(`[conversations] remove member failed: ${error instanceof Error ? error.message : String(error)}`);
      acknowledgeError(socket, ack, eventName, ERROR_CODES.INTERNAL_ERROR, 'could not remove group member', state);
    }
  });

  socket.on(CLIENT_EVENTS.CONVERSATION_LEAVE, async (payload = {}, ack) => {
    const eventName = CLIENT_EVENTS.CONVERSATION_LEAVE;
    if (!requireSocketSession(socket, ack, eventName)) return;
    if (!validateSignalingVersion(socket, payload, ack, eventName)) return;
    const parsed = parseInboundPayload(socket, ack, eventName, payload, state);
    if (!parsed) return;
    const userId = socket.data.identity.userId;
    const conversationId = normaliseId(parsed.conversationId);
    if (!conversationId) {
      acknowledgeError(socket, ack, eventName, ERROR_CODES.BAD_REQUEST, 'conversationId is required', state);
      return;
    }
    try {
      const result = await state.conversationStore.leave({ conversationId, userId });
      if (!result) {
        acknowledgeError(socket, ack, eventName, ERROR_CODES.NOT_FOUND, 'group not found', state);
        return;
      }
      state.auditLog.record({
        event: 'conversation.membership.left',
        actor: userId,
        target: conversationId,
        outcome: 'success',
      });
      if (result.previousOwnerId) {
        state.auditLog.record({
          event: 'conversation.membership.owner_transferred',
          actor: userId,
          target: result.conversation.memberIds[0] ?? null,
          outcome: 'success',
          details: { conversationId },
        });
      }
      await fanoutConversationEvent(io, state, {
        conversationId,
        eventName: SERVER_EVENTS.CONVERSATION_UPDATED,
        recipientIds: result.conversation.memberIds,
        payload: {
          version: SIGNALING_VERSION,
          conversation: result.conversation,
          updatedBy: userId,
        },
      });
      for (const callChange of result.callChanges ?? []) {
        await fanoutConversationEvent(io, state, {
          conversationId,
          eventName: SERVER_EVENTS.CONVERSATION_CALL_UPDATED,
          recipientIds: callChange.participants.map(({ userId: participantId }) => participantId),
          payload: {
            version: SIGNALING_VERSION,
            conversationId,
            callId: callChange.call.callId,
            call: callChange.call,
            participants: callChange.participants,
          },
        });
      }
      acknowledgeSuccess(socket, ack, eventName, { conversation: result.conversation });
    } catch (error) {
      if (rejectStoreError(socket, ack, eventName, error, state)) return;
      console.error(`[conversations] leave failed: ${error instanceof Error ? error.message : String(error)}`);
      acknowledgeError(socket, ack, eventName, ERROR_CODES.INTERNAL_ERROR, 'could not leave group', state);
    }
  });

  socket.on(CLIENT_EVENTS.CONVERSATION_CALL_START, async (payload = {}, ack) => {
    const eventName = CLIENT_EVENTS.CONVERSATION_CALL_START;
    if (!requireSocketSession(socket, ack, eventName)) return;
    if (!validateSignalingVersion(socket, payload, ack, eventName)) return;
    const parsed = parseInboundPayload(socket, ack, eventName, payload, state);
    if (!parsed) return;
    const conversationId = normaliseId(parsed.conversationId);
    const initiatorId = socket.data.identity.userId;
    if (!conversationId) {
      acknowledgeError(socket, ack, eventName, ERROR_CODES.BAD_REQUEST, 'conversationId is required', state);
      return;
    }
    const rateCheck = state.callInitRateLimiter.check(initiatorId);
    if (!rateCheck.allowed) {
      acknowledgeError(socket, ack, eventName, ERROR_CODES.RATE_LIMITED, 'too many call attempts', state);
      return;
    }
    try {
      const members = await state.conversationStore.listMembers(conversationId);
      const excludedUserIds = members
        .filter(({ userId }) =>
          userId !== initiatorId &&
          (isBlocked(state.blocks, userId, initiatorId) || isBlocked(state.blocks, initiatorId, userId))
        )
        .map(({ userId }) => userId);
      const change = await state.conversationStore.startCall({
        conversationId,
        initiatorId,
        mediaType: parsed.mediaType ?? 'video',
        ringTimeoutMs: ringingTimeoutMs,
        excludedUserIds,
      });
      if (!change) {
        acknowledgeError(socket, ack, eventName, ERROR_CODES.NOT_FOUND, 'group not found or has no reachable members', state);
        return;
      }
      state.auditLog.record({
        event: 'conversation.call.started',
        actor: initiatorId,
        target: conversationId,
        outcome: 'success',
        details: { callId: change.call.callId },
      });
      const payload = {
        version: SIGNALING_VERSION,
        conversationId,
        callId: change.call.callId,
        call: change.call,
        participants: change.participants,
      };
      await fanoutConversationEvent(io, state, {
        conversationId,
        eventName: SERVER_EVENTS.CONVERSATION_CALL_UPDATED,
        recipientIds: change.participants.map(({ userId }) => userId),
        payload,
      });
      acknowledgeSuccess(socket, ack, eventName, { call: change.call, participants: change.participants });
    } catch (error) {
      if (rejectStoreError(socket, ack, eventName, error, state)) return;
      console.error(`[conversations] group call start failed: ${error instanceof Error ? error.message : String(error)}`);
      acknowledgeError(socket, ack, eventName, ERROR_CODES.INTERNAL_ERROR, 'could not start group call', state);
    }
  });

  const groupCallTransitions = [
    [CLIENT_EVENTS.CONVERSATION_CALL_ACCEPT, 'accept'],
    [CLIENT_EVENTS.CONVERSATION_CALL_DECLINE, 'decline'],
    [CLIENT_EVENTS.CONVERSATION_CALL_LEAVE, 'leave'],
  ] as const;
  for (const [eventName, action] of groupCallTransitions) {
    socket.on(eventName, async (payload = {}, ack) => {
      if (!requireSocketSession(socket, ack, eventName)) return;
      if (!validateSignalingVersion(socket, payload, ack, eventName)) return;
      const parsed = parseInboundPayload(socket, ack, eventName, payload, state);
      if (!parsed) return;
      const callId = normaliseId(parsed.callId);
      if (!callId) {
        acknowledgeError(socket, ack, eventName, ERROR_CODES.BAD_REQUEST, 'callId is required', state);
        return;
      }
      const actorId = socket.data.identity.userId;
      try {
        const change = await state.conversationStore.transitionCall({ callId, userId: actorId, action });
        if (!change) {
          acknowledgeError(socket, ack, eventName, ERROR_CODES.NOT_FOUND, 'group call not found', state);
          return;
        }
        if (change.expired) {
          await fanoutConversationEvent(io, state, {
            conversationId: change.call.conversationId,
            eventName: SERVER_EVENTS.CONVERSATION_CALL_UPDATED,
            recipientIds: change.participants.map(({ userId }) => userId),
            payload: {
              version: SIGNALING_VERSION,
              conversationId: change.call.conversationId,
              callId,
              call: change.call,
              participants: change.participants,
            },
          });
          acknowledgeError(socket, ack, eventName, ERROR_CODES.BAD_REQUEST, 'group call expired', state);
          return;
        }
        state.auditLog.record({
          event: `conversation.call.${action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'left'}`,
          actor: actorId,
          target: change.call.conversationId,
          outcome: 'success',
          details: { callId },
        });
        await fanoutConversationEvent(io, state, {
          conversationId: change.call.conversationId,
          eventName: SERVER_EVENTS.CONVERSATION_CALL_UPDATED,
          recipientIds: change.participants.map(({ userId }) => userId),
          payload: {
            version: SIGNALING_VERSION,
            conversationId: change.call.conversationId,
            callId,
            call: change.call,
            participants: change.participants,
          },
        });
        acknowledgeSuccess(socket, ack, eventName, { call: change.call, participants: change.participants });
      } catch (error) {
        if (rejectStoreError(socket, ack, eventName, error, state)) return;
        console.error(`[conversations] group call transition failed: ${error instanceof Error ? error.message : String(error)}`);
        acknowledgeError(socket, ack, eventName, ERROR_CODES.INTERNAL_ERROR, 'could not update group call', state);
      }
    });
  }
}

export { registerConversationHandlers };
