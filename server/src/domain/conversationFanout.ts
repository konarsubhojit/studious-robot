import { emitVersionedUserEvent } from './notifications.ts';
import type { ServerState } from './notifications.ts';
import { SERVER_EVENTS } from '../../../shared/index.ts';
import { requireGroupMember } from '../conversationStore/authorization.ts';
import { ConversationStoreError } from '../conversationStore/types.ts';

const CONVERSATION_FANOUT_CHANNEL = 'signaling:conversation.fanout';
const ALLOWED_FANOUT_EVENTS = new Set<string>([
  SERVER_EVENTS.CONVERSATION_UPDATED,
  SERVER_EVENTS.CONVERSATION_CALL_UPDATED,
  SERVER_EVENTS.MESSAGE_RECEIVED,
  SERVER_EVENTS.MESSAGE_DELETED,
  SERVER_EVENTS.MESSAGE_REACTION,
  SERVER_EVENTS.MESSAGE_TYPING,
  SERVER_EVENTS.MESSAGE_READ,
]);
const CALL_VERSION_CACHE_LIMIT = 4096;
const callVersionsByServer = new WeakMap<object, Map<string, number>>();

type ConversationFanout = {
  conversationId: string;
  eventName: string;
  payload: object;
  recipientIds: string[];
};

function isNewCallVersion(io: object, event: ConversationFanout): boolean {
  if (event.eventName !== SERVER_EVENTS.CONVERSATION_CALL_UPDATED) return true;
  const payload = event.payload as { call?: { callId?: unknown; stateVersion?: unknown; }; };
  const callId = payload.call?.callId;
  const stateVersion = payload.call?.stateVersion;
  if (typeof callId !== 'string' || typeof stateVersion !== 'number' ||
    !Number.isSafeInteger(stateVersion)) return true;

  let versions = callVersionsByServer.get(io);
  if (!versions) {
    versions = new Map();
    callVersionsByServer.set(io, versions);
  }
  const previous = versions.get(callId);
  if (previous !== undefined && stateVersion <= previous) return false;
  versions.delete(callId);
  versions.set(callId, stateVersion);
  if (versions.size > CALL_VERSION_CACHE_LIMIT) {
    const oldest = versions.keys().next().value;
    if (oldest !== undefined) versions.delete(oldest);
  }
  return true;
}

async function mayDeliver(state: ServerState, event: ConversationFanout, userId: string): Promise<boolean> {
  if (event.eventName === SERVER_EVENTS.CONVERSATION_UPDATED || event.eventName === SERVER_EVENTS.CONVERSATION_CALL_UPDATED) return true;
  try {
    const member = await requireGroupMember(state.conversationStore, event.conversationId, userId);
    const message = (event.payload as { message?: { createdAt?: string } }).message;
    if (message?.createdAt && Date.parse(message.createdAt) < Date.parse(member.joinedAt)) return false;
    const messageId = (event.payload as { messageId?: string }).messageId;
    if (messageId && !(await state.conversationStore.getMessage(event.conversationId, messageId, userId))) return false;
    return true;
  } catch (error) {
    if (!(error instanceof ConversationStoreError)) console.error('[conversations] fan-out authorization unavailable');
    return false;
  }
}

async function emitLocally(io: any, state: ServerState, event: ConversationFanout): Promise<void> {
  if (!isNewCallVersion(io, event)) return;
  const localIo = io.local ?? io;
  for (const userId of new Set(event.recipientIds)) {
    if (typeof userId !== 'string' || userId.length === 0 || !(await mayDeliver(state, event, userId))) continue;
    emitVersionedUserEvent(localIo, userId, event.eventName, event.payload as Record<string, unknown>);
  }
}

function parseFanout(value: unknown): ConversationFanout | null {
  if (typeof value !== 'object' || value === null) return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.conversationId !== 'string' ||
    typeof event.eventName !== 'string' ||
    !ALLOWED_FANOUT_EVENTS.has(event.eventName) ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    !Array.isArray(event.recipientIds) ||
    event.recipientIds.length > 16 ||
    event.recipientIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    return null;
  }
  return event as ConversationFanout;
}

async function fanoutConversationEvent(
  io: any,
  state: ServerState,
  event: ConversationFanout
): Promise<void> {
  if (state.attachAdapter) {
    // Use the adapter's server-to-server channel, not an unchecked client-room
    // broadcast: each receiving instance authorizes against current membership.
    io.serverSideEmit(CONVERSATION_FANOUT_CHANNEL, event);
    await emitLocally(io, state, event);
    return;
  }
  if (!state.messageBus) {
    await emitLocally(io, state, event);
    return;
  }
  try {
    await state.messageBus.publish(CONVERSATION_FANOUT_CHANNEL, event);
  } catch (error) {
    console.error(`[conversations] fan-out publish failed: ${error instanceof Error ? error.message : String(error)}`);
    await emitLocally(io, state, event);
  }
}

async function subscribeToConversationFanout(
  io: any,
  state: ServerState
): Promise<(() => Promise<void>) | null> {
  const receive = (message: unknown) => {
    const event = parseFanout(message);
    if (event) void emitLocally(io, state, event).catch(() => console.error('[conversations] local fan-out failed'));
  };
  if (state.attachAdapter) {
    io.on(CONVERSATION_FANOUT_CHANNEL, receive);
    return async () => { io.off(CONVERSATION_FANOUT_CHANNEL, receive); };
  }
  if (!state.messageBus) return null;
  return state.messageBus.subscribe(CONVERSATION_FANOUT_CHANNEL, receive);
}

export {
  CONVERSATION_FANOUT_CHANNEL,
  fanoutConversationEvent,
  subscribeToConversationFanout,
};
