import { SERVER_EVENTS } from '../../../shared';
import { SERVER_EVENT_SCHEMAS } from '../../../shared/signaling/schemas';
import { applyGroupSnapshot } from './groupMockAdapter';
import type { ConversationRecord } from '../../../shared/signaling/schemas';
import type { ConversationSummary } from '../messaging/types';

export type GroupTransport = 'mock' | 'live';
export const GROUP_TRANSPORT: GroupTransport = process.env.GROUP_TRANSPORT === 'live' ? 'live' : 'mock';

/** The existing lifecycle handlers acknowledge with { conversation }, not a new membership protocol. */
export function conversationAcknowledgement(ack: unknown, updatedBy: string): ConversationRecord {
  const conversation = ack && typeof ack === 'object' ? (ack as { conversation?: unknown }).conversation : undefined;
  return SERVER_EVENT_SCHEMAS[SERVER_EVENTS.CONVERSATION_UPDATED].parse({ conversation, updatedBy }).conversation;
}

export function parseGroupList(records: unknown, userId: string): ConversationRecord[] | undefined {
  if (records === undefined) return undefined;
  if (!Array.isArray(records)) throw new Error('Invalid group conversation list');
  return records.map(conversation => SERVER_EVENT_SCHEMAS[SERVER_EVENTS.CONVERSATION_UPDATED]
    .parse({ conversation, updatedBy: userId }).conversation);
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
