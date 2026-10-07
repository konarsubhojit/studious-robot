import { ConversationStoreError, type ConversationMember, type ConversationStore } from './types.ts';
import { GROUP_CALL_LIMIT_MESSAGE, MAX_GROUP_CALL_PARTICIPANTS } from '../../../shared/groupCalls.ts';

/** The sole group access predicate. Blocks and delivery rooms are not authority. */
export function activeGroupMember(member: ConversationMember | null | undefined): member is ConversationMember {
  return Boolean(member && member.leftAt === null && member.removedAt === null);
}

export function assertActiveGroupMember(member: ConversationMember | null | undefined): ConversationMember {
  if (!activeGroupMember(member)) throw new ConversationStoreError('not_member', 'not an active member');
  return member;
}

export async function requireGroupMember(store: ConversationStore, groupId: string, userId: string): Promise<ConversationMember> {
  return assertActiveGroupMember(await store.getMember(groupId, userId));
}

export function requireGroupAdmin(member: ConversationMember): void {
  if (member.role !== 'owner' && member.role !== 'admin') {
    throw new ConversationStoreError('forbidden', 'only owners and admins may manage groups');
  }
}

export function validateInvitees(actorId: string, userIds: string[]): void {
  if (userIds.length > 15 || new Set(userIds).size !== userIds.length || userIds.includes(actorId) ||
      userIds.some(id => !id || id.length > 128)) {
    throw new ConversationStoreError('invalid_members', 'invalid invitees');
  }
}

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function assertGroupCallMembership(members: ConversationMember[], excludedUserIds: string[]): void {
  if (members.length > MAX_GROUP_CALL_PARTICIPANTS) {
    throw new ConversationStoreError('group_call_full', GROUP_CALL_LIMIT_MESSAGE);
  }
  const excluded = new Set(excludedUserIds);
  if (members.some(({ userId }) => excluded.has(userId))) {
    throw new ConversationStoreError('forbidden', 'All current members must be reachable to start a group call');
  }
}
