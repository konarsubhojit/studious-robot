import { CLIENT_EVENTS, parseEventPayload, SIGNALING_VERSION } from '../../../shared';
import type { ConversationRecord } from '../../../shared/signaling/schemas';
import type { ChatMessage, ConversationSummary, OutboxItem } from '../messaging/types';
import { outboxSendPayload } from '../messaging/sendPipeline';

/** Local-only behavior. Nothing here owns a socket, media stream, or invented wire event. */
function validate(event: string, payload: object) {
  const result = parseEventPayload(event, payload, 'client');
  if (!result.success) throw new Error(result.error.message);
}

export function createMockGroup(
  creatorId: string, name: string, inviteeIds: string[], conversationId: string,
): ConversationSummary {
  const ids = [...new Set(inviteeIds)].filter(id => id !== creatorId);
  validate(CLIENT_EVENTS.CONVERSATION_CREATE, { version: SIGNALING_VERSION, name, inviteeIds: ids });
  if (!creatorId || ids.length < 2) throw new Error('Select at least two other people');
  return {
    peerId: conversationId, conversationId, unreadCount: 0, localMock: true,
    group: { conversationId, name: name.trim(), creatorId, memberIds: [creatorId, ...ids], membershipVersion: 1 },
  };
}

export type GroupMemberAction = { type: 'add'; userIds: string[] } | { type: 'remove'; userId: string };

export function mutateMockMembers(row: ConversationSummary, actorId: string, action: GroupMemberAction): ConversationSummary {
  const group = row.group;
  if (!row.localMock || !group || row.left || group.creatorId !== actorId || !group.memberIds.includes(actorId)) {
    throw new Error('Only the group admin can manage members in a local preview');
  }
  const memberIds = action.type === 'add'
    ? [...new Set([...group.memberIds, ...action.userIds.map(id => id.trim()).filter(Boolean)])]
    : group.memberIds.filter(id => id !== action.userId);
  if (action.type === 'remove' && action.userId === group.creatorId) throw new Error('The admin cannot be removed; use Leave group');
  return { ...row, group: { ...group, memberIds, membershipVersion: group.membershipVersion + 1 } };
}

export function renameMockGroup(row: ConversationSummary, actorId: string, name: string): ConversationSummary {
  if (!row.group || row.left || row.group.creatorId !== actorId) throw new Error('Only the admin can rename this group');
  validate(CLIENT_EVENTS.CONVERSATION_UPDATE, { version: SIGNALING_VERSION, conversationId: row.group.conversationId, name });
  return { ...row, group: { ...row.group, name: name.trim(), membershipVersion: row.group.membershipVersion + 1 } };
}

export function leaveMockGroup(row: ConversationSummary, actorId: string): ConversationSummary {
  if (!row.group || !row.group.memberIds.includes(actorId)) throw new Error('You are not a member');
  validate(CLIENT_EVENTS.CONVERSATION_LEAVE, { version: SIGNALING_VERSION, conversationId: row.group.conversationId });
  return {
    ...row, left: true, unreadCount: 0,
    group: { ...row.group, memberIds: row.group.memberIds.filter(id => id !== actorId), membershipVersion: row.group.membershipVersion + 1 },
  };
}

export function sendMockGroup(row: ConversationSummary | undefined, item: OutboxItem, senderId: string): ChatMessage {
  validate(CLIENT_EVENTS.MESSAGE_SEND, outboxSendPayload(item));
  if (!row?.localMock || row.left || !row.group?.memberIds.includes(senderId)) throw new Error('You are no longer a group member');
  return {
    messageId: item.messageId, conversationId: row.group.conversationId,
    senderId, recipientId: row.peerId, body: item.body ?? '', type: item.type,
    attachment: item.attachment, replyTo: item.replyTo, createdAt: item.createdAt,
  };
}

export function applyGroupSnapshot(
  rows: ConversationSummary[], group: ConversationRecord, currentUserId: string,
): ConversationSummary[] {
  const existing = rows.find(row => row.conversationId === group.conversationId && row.group);
  if (existing && existing.group!.membershipVersion >= group.membershipVersion) return rows;
  const row: ConversationSummary = {
    ...existing, peerId: existing?.peerId ?? group.conversationId, conversationId: group.conversationId,
    group, localMock: false, left: !group.memberIds.includes(currentUserId),
    unreadCount: group.memberIds.includes(currentUserId) ? existing?.unreadCount ?? 0 : 0,
  };
  return [row, ...rows.filter(entry => entry !== existing)];
}
