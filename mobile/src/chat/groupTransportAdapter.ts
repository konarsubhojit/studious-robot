import { SERVER_EVENTS } from '../../../shared';
import { SERVER_EVENT_SCHEMAS } from '../../../shared/signaling/schemas';
import { logWarn } from '../appLogger';
import type { ConversationRecord } from '../../../shared/signaling/schemas';
import type { ConversationSummary } from '../messaging/types';

export type GroupTransport = 'mock' | 'live';
export const GROUP_TRANSPORT: GroupTransport = process.env.GROUP_TRANSPORT === 'live' ? 'live' : 'mock';

/** The existing lifecycle handlers acknowledge with { conversation }, not a new membership protocol. */
export function conversationAcknowledgement(ack: unknown, updatedBy: string): ConversationRecord {
  const conversation = ack && typeof ack === 'object' ? (ack as { conversation?: unknown }).conversation : undefined;
  return SERVER_EVENT_SCHEMAS[SERVER_EVENTS.CONVERSATION_UPDATED].parse({ conversation, updatedBy }).conversation;
}

/**
 * The group half of `GET /conversations`, or `undefined` when it cannot be
 * trusted. A malformed list is treated exactly like the omitted one: the direct
 * conversations in the same response must still be applied, and the held group
 * rows are kept rather than mistaken for memberships the server dropped.
 */
export function parseGroupList(records: unknown, userId: string): ConversationRecord[] | undefined {
  if (records === undefined) return undefined;
  if (!Array.isArray(records)) {
    logWarn('[Groups] Ignored a malformed group conversation list');
    return undefined;
  }
  const parsed: ConversationRecord[] = [];
  for (const conversation of records) {
    const result = SERVER_EVENT_SCHEMAS[SERVER_EVENTS.CONVERSATION_UPDATED]
      .safeParse({ conversation, updatedBy: userId });
    if (!result.success) {
      logWarn('[Groups] Ignored a malformed group conversation list', { message: result.error.message });
      return undefined;
    }
    parsed.push(result.data.conversation);
  }
  return parsed;
}

/**
 * Fold one server membership snapshot into the chat list, newest first. A
 * snapshot that is not newer than the held one is ignored, so an out-of-order
 * socket event cannot resurrect a membership the user already left.
 */
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

/** GET /conversations contains separate direct summaries and bare group snapshots. */
export function remoteGroupRows(
  records: ConversationRecord[] | undefined, previous: ConversationSummary[], userId: string,
  initialVersions: Map<string, number>,
): ConversationSummary[] {
  const remote = previous.filter(row => row.group && !row.localMock);
  // The server omits this field on a partial group-store failure.
  if (records === undefined) return remote;
  const rows = records.map(group => {
    const existing = remote.find(row => row.conversationId === group.conversationId);
    return applyGroupSnapshot(existing ? [existing] : [], group, userId)[0];
  });
  const ids = new Set(rows.map(row => row.peerId));
  const missing = remote.filter(row => !ids.has(row.peerId)).map(row =>
    initialVersions.get(row.peerId) === row.group!.membershipVersion ? { ...row, left: true, unreadCount: 0 } : row);
  return [...rows, ...missing];
}
