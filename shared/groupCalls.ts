/** Mesh policy applies to the whole current membership, including the initiator. */
export const MAX_GROUP_CALL_PARTICIPANTS = 4;
export const GROUP_CALL_LIMIT_MESSAGE = 'Group calls support up to 4 members, including you. This group is too large to call.';

type Call = {
  callId: string;
  conversationId: string;
  initiatorId: string;
  mediaType: 'audio' | 'video';
  status: 'ringing' | 'active' | 'ended';
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
};
type Participant = { userId: string; status: string; acceptedAt?: string | null; invitedAt?: string };

/** Additive GET /calls entry; no fictitious caller/callee peer for a group. */
export type GroupCallHistoryEntry = Omit<Call, 'status'> & {
  kind: 'group';
  groupName: string;
  callStatus: Call['status'];
  status: 'ringing' | 'active' | 'ended' | 'missed';
  outcome: 'joined' | 'missed' | 'ringing';
};

export function groupCallHistoryEntry(call: Call, participant: Participant, groupName: string): GroupCallHistoryEntry {
  const outcome = callOutcome(call.status, participant);
  return { ...call, kind: 'group', groupName, callStatus: call.status,
    status: outcome === 'missed' ? 'missed' : call.status, outcome };
}

function callOutcome(status: string, participant: Participant): GroupCallHistoryEntry['outcome'] {
  return participant.acceptedAt ? 'joined' :
    status === 'ended' || ['declined', 'left'].includes(participant.status) ? 'missed' : 'ringing';
}

/** Stable timeline identity/order; outcomes update in place rather than adding rows. */
export function groupCallTimelineMessage(
  call: Pick<Call, 'callId' | 'conversationId' | 'initiatorId'> & { status: string; mediaType: string; createdAt?: unknown },
  participant: Participant,
) {
  const outcome = callOutcome(call.status, participant);
  const label = outcome === 'joined' ? 'Joined' : outcome === 'missed' ? 'Missed' : 'Ringing';
  return {
    messageId: call.callId, conversationId: call.conversationId,
    senderId: call.initiatorId, recipientId: call.conversationId,
    body: `Group ${call.mediaType} call · ${label}${call.status === 'ended' ? ' · Ended' : ''}`,
    type: 'system', createdAt: typeof call.createdAt === 'string' ? call.createdAt : participant.invitedAt ?? '',
    attachment: null, replyTo: null,
    reactions: {}, deletedAt: null, deliveredTo: [], readAt: null,
  };
}
