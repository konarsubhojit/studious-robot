import { emitVersionedUserEvent } from './notifications.ts';
import type { ServerState } from './notifications.ts';
import { SERVER_EVENTS } from '../../../shared/index.ts';

const CONVERSATION_FANOUT_CHANNEL = 'signaling:conversation.fanout';
const ALLOWED_FANOUT_EVENTS = new Set<string>([
  SERVER_EVENTS.CONVERSATION_UPDATED,
  SERVER_EVENTS.CONVERSATION_CALL_UPDATED,
  SERVER_EVENTS.MESSAGE_RECEIVED,
  SERVER_EVENTS.MESSAGE_DELETED,
  SERVER_EVENTS.MESSAGE_REACTION,
  SERVER_EVENTS.MESSAGE_TYPING,
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

function emitLocally(io: any, event: ConversationFanout): void {
  if (!isNewCallVersion(io, event)) return;
  const localIo = io.local ?? io;
  for (const userId of new Set(event.recipientIds)) {
    if (typeof userId !== 'string' || userId.length === 0) continue;
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
  if (!state.messageBus) {
    emitLocally(io, event);
    return;
  }
  try {
    await state.messageBus.publish(CONVERSATION_FANOUT_CHANNEL, event);
  } catch (error) {
    console.error(`[conversations] fan-out publish failed: ${error instanceof Error ? error.message : String(error)}`);
    emitLocally(io, event);
  }
}

async function subscribeToConversationFanout(
  io: any,
  state: ServerState
): Promise<(() => Promise<void>) | null> {
  if (!state.messageBus) return null;
  return state.messageBus.subscribe(CONVERSATION_FANOUT_CHANNEL, (message) => {
    const event = parseFanout(message);
    if (event) emitLocally(io, event);
  });
}

export {
  CONVERSATION_FANOUT_CHANNEL,
  fanoutConversationEvent,
  subscribeToConversationFanout,
};
