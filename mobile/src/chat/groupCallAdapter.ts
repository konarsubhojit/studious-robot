import { CLIENT_EVENTS, parseEventPayload, SERVER_EVENTS, SIGNALING_VERSION } from '../../../shared';
import { SERVER_EVENT_SCHEMAS } from '../../../shared/signaling/schemas';
import type { ConversationSummary } from '../messaging/types';

const snapshotSchema = SERVER_EVENT_SCHEMAS[SERVER_EVENTS.CONVERSATION_CALL_UPDATED];
export type GroupCallSnapshot = ReturnType<typeof snapshotSchema.parse>;
export type GroupCallAction = 'accept' | 'decline' | 'leave';
const transitionEvents = {
  accept: CLIENT_EVENTS.CONVERSATION_CALL_ACCEPT,
  decline: CLIENT_EVENTS.CONVERSATION_CALL_DECLINE,
  leave: CLIENT_EVENTS.CONVERSATION_CALL_LEAVE,
};

/** Only lifecycle signaling is defined. Muting and media never enter these payloads. */
export function groupCallRequest(action: 'start' | GroupCallAction, id: string, mediaType: 'audio' | 'video' = 'audio') {
  const event = action === 'start' ? CLIENT_EVENTS.CONVERSATION_CALL_START : transitionEvents[action];
  const payload = action === 'start'
    ? { version: SIGNALING_VERSION, conversationId: id, mediaType }
    : { version: SIGNALING_VERSION, callId: id };
  const result = parseEventPayload(event, payload, 'client');
  if (!result.success) throw new Error(result.error.message);
  return { event, payload };
}

export function parseGroupCallSnapshot(payload: unknown): GroupCallSnapshot {
  const snapshot = snapshotSchema.parse(payload);
  if (snapshot.callId !== snapshot.call.callId || snapshot.conversationId !== snapshot.call.conversationId ||
      snapshot.participants.some(person => person.callId !== snapshot.callId) ||
      new Set(snapshot.participants.map(person => person.userId)).size !== snapshot.participants.length) {
    throw new Error('Inconsistent group call snapshot');
  }
  return snapshot;
}

/** Existing call handlers acknowledge { call, participants }; validate it as the same snapshot. */
export function groupCallAcknowledgement(ack: unknown): GroupCallSnapshot {
  const result = (ack && typeof ack === 'object' ? ack : {}) as {
    call?: { callId?: unknown; conversationId?: unknown }; participants?: unknown;
  };
  return parseGroupCallSnapshot({
    version: SIGNALING_VERSION, callId: result.call?.callId, conversationId: result.call?.conversationId,
    call: result.call, participants: result.participants,
  });
}
/** A local mock produces the exact server snapshot, rather than a separate participant protocol. */
export function startMockGroupCall(
  row: ConversationSummary, userId: string, callId: string, mediaType: 'audio' | 'video', now: string,
): GroupCallSnapshot {
  if (!row.localMock || row.left || !row.group?.memberIds.includes(userId)) throw new Error('You are not a local group member');
  groupCallRequest('start', row.group.conversationId, mediaType);
  return parseGroupCallSnapshot({
    version: SIGNALING_VERSION, conversationId: row.group.conversationId, callId,
    call: { callId, conversationId: row.group.conversationId, initiatorId: userId, mediaType,
      status: 'ringing', stateVersion: 1, ringTimeoutAt: null },
    participants: row.group.memberIds.map(id => ({
      callId, userId: id, status: id === userId ? 'accepted' : 'ringing', invitedAt: now,
      acceptedAt: id === userId ? now : null, leftAt: null,
    })),
  });
}

export function transitionMockGroupCall(
  snapshot: GroupCallSnapshot, userId: string, action: GroupCallAction, now: string,
): GroupCallSnapshot {
  groupCallRequest(action, snapshot.callId);
  const person = snapshot.participants.find(entry => entry.userId === userId);
  if (snapshot.call.status === 'ended' || !person) throw new Error('Group call is unavailable');
  if (action === 'leave' ? person.status !== 'accepted' : person.status !== 'ringing') {
    throw new Error('This participant cannot perform that call action');
  }
  let participants = snapshot.participants.map(entry => entry !== person ? entry : {
    ...entry, status: action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'left',
    ...(action === 'accept' ? { acceptedAt: now } : {}),
    ...(action === 'leave' ? { leftAt: now } : {}),
  });
  const ended = !participants.some(entry => entry.status === 'accepted');
  if (ended) participants = participants.map(entry => entry.status === 'ringing' ? { ...entry, status: 'declined' } : entry);
  return parseGroupCallSnapshot({
    ...snapshot,
    call: { ...snapshot.call, stateVersion: snapshot.call.stateVersion + 1,
      status: ended ? 'ended' : action === 'accept' ? 'active' : snapshot.call.status },
    participants,
  });
}
