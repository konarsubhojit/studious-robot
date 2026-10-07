import { SIGNALING_VERSION } from '../../config.ts';
import { emitToUserSockets } from '../../domain/notifications.ts';
import { resolveOfflinePushChannels, userRoom } from '../../lib/state.ts';
import { pruneDeadDevice } from '../../lib/persistence.ts';
import { pushSenders } from '../../push.ts';
import { describeError } from '../../lib/errors.ts';
import { describeMessagePreview, SERVER_EVENTS } from '../../../../shared/index.ts';
import { fanoutConversationEvent } from '../../domain/conversationFanout.ts';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { devices } from '../../../db/schema.ts';
import { invalidateCache, messagesCachePrefix } from '../../cache.ts';
import { ConversationStoreError } from '../../conversationStore/types.ts';
import { isBlockedAsync } from '../../security.ts';

async function groupPushChannels(state: import('../../stores/contracts.ts').ServerState, userId: string) {
  if (!state.db) return resolveOfflinePushChannels(state, userId).slice(0, 1);
  const rows = await state.db.select().from(devices).where(and(eq(devices.userId, userId),
    isNotNull(devices.pushProvider), isNotNull(devices.pushToken)))
    .orderBy(desc(sql`coalesce(${devices.lastRegisteredAt}, ${devices.updatedAt})`), desc(devices.deviceId))
    .limit(1);
  return rows.map(row => ({
    type: 'push' as const, deviceId: row.deviceId, provider: row.pushProvider!, pushToken: row.pushToken!,
  }));
}

async function onlineGroupMembers(io: import('socket.io').Server, recipientIds: string[]): Promise<Set<string> | null> {
  if (!recipientIds.length) return new Set();
  try {
    const sockets = await io.in(recipientIds.map(userRoom)).fetchSockets();
    return new Set(sockets.map(socket => socket.data.identity?.userId).filter(Boolean));
  } catch (error) {
    // Do not turn an adapter outage into a push amplification storm.
    console.error(`[messages] group presence lookup failed: ${describeError(error)}`);
    return null;
  }
}

function pushMessage(
  state: import('../../stores/contracts.ts').ServerState,
  channel: import('../../lib/state.ts').PushChannel,
  message: import('../../stores/contracts.ts').MessageRecord,
  groupName?: string
): void {
  pushSenders.sendMessagePush(channel, {
    messageId: message.messageId,
    conversationId: message.conversationId,
    senderId: message.senderId,
    senderDisplayName: state.users.get(message.senderId)?.displayName,
    groupName,
    preview: describeMessagePreview(message),
  }).then(outcome => {
    if (!outcome?.deadToken) return;
    return pruneDeadDevice(state.db, state, outcome.deviceId, outcome.reason ?? 'unknown');
  }).catch(error => {
    console.error(`[messages] Unhandled push error for device ${channel.deviceId}: ${describeError(error)}`);
  });
}

async function notifyMember(
  state: import('../../stores/contracts.ts').ServerState,
  message: import('../../stores/contracts.ts').MessageRecord,
  userId: string,
  onlineMembers: Set<string>,
  groupName?: string
): Promise<void> {
  if (groupName !== undefined) {
    try {
      if (!(await state.conversationStore.getMessage(message.conversationId, message.messageId, userId))) return;
    } catch (error) {
      if (!(error instanceof ConversationStoreError)) throw error;
      return;
    }
  }
  if (groupName !== undefined && onlineMembers.has(userId)) {
    await state.conversationStore.markDelivered(message.conversationId, message.messageId, userId)
      .catch(error => console.error(`[messages] group delivery receipt failed: ${describeError(error)}`));
    return;
  }
  if (groupName !== undefined && await isBlockedAsync(state, userId, message.senderId)) return;
  // Registrations on another VM need not be in this process's hot maps.
  const pushChannels = groupName !== undefined
    ? await groupPushChannels(state, userId) : resolveOfflinePushChannels(state, userId);
  for (const channel of pushChannels) pushMessage(state, channel, message, groupName);
}

async function deliverMessage(
  io: import('socket.io').Server,
  state: import('../../stores/contracts.ts').ServerState,
  message: import('../../stores/contracts.ts').MessageRecord,
  target: { recipientIds: string[]; groupName?: string } = { recipientIds: [message.recipientId] }
) {
  const envelope = {
    version: SIGNALING_VERSION,
    conversationId: message.conversationId,
    message,
  };
  const recipientIds = [...new Set(target.recipientIds)].filter(id => id !== message.senderId);
  const isGroup = target.groupName !== undefined;
  if (isGroup) {
    await fanoutConversationEvent(io, state, { conversationId: message.conversationId,
      eventName: SERVER_EVENTS.MESSAGE_RECEIVED, payload: envelope, recipientIds });
  } else {
    for (const userId of recipientIds) {
      emitToUserSockets(io, userId, SERVER_EVENTS.MESSAGE_RECEIVED, envelope);
    }
  }

  const onlineMembers = isGroup ? await onlineGroupMembers(io, recipientIds) : new Set<string>();
  if (!onlineMembers) return;
  for (const userId of recipientIds) {
    await notifyMember(state, message, userId, onlineMembers, target.groupName)
      .catch(error => console.error(`[messages] notification failed for member ${userId}: ${describeError(error)}`));
  }
  if (isGroup && onlineMembers.size) await invalidateCache(state, messagesCachePrefix(message.conversationId));
}

export { deliverMessage };
