import { randomUUID } from 'node:crypto';
import { applyReaction, applyTombstone } from '../messageStore/records.ts';
import type { StoredMessage } from '../messageStore/types.ts';
import type {
  ConversationChange,
  ConversationMember,
  ConversationSnapshot,
  ConversationStore,
  GroupCall,
  GroupCallChange,
  GroupCallParticipant,
  GroupConversation,
} from './types.ts';
import { ConversationStoreError } from './types.ts';
import type { GroupInvitation, GroupMembershipEvent } from './types.ts';
import { activeGroupMember, assertActiveGroupMember, INVITATION_TTL_MS, requireGroupAdmin, validateInvitees } from './authorization.ts';
import { attachmentScopeFromKey } from '../attachments.ts';

const MAX_GROUP_MEMBERS = 16;

function messageKey(conversationId: string, messageId: string): string {
  return JSON.stringify([conversationId, messageId]);
}

function callParticipantKey(callId: string, userId: string): string {
  return JSON.stringify([callId, userId]);
}

function createMemoryConversationStore(canInvite: (actorId: string, userId: string) => Promise<boolean> = async () => true): ConversationStore {
  const conversations = new Map<string, GroupConversation>();
  const members = new Map<string, ConversationMember>();
  const messages = new Map<string, StoredMessage>();
  const calls = new Map<string, GroupCall>();
  const callParticipants = new Map<string, GroupCallParticipant>();
  const invitations = new Map<string, GroupInvitation>();
  const events: GroupMembershipEvent[] = [];

  function activityTime(conversation: GroupConversation): string {
    return new Date(Math.max(Date.now(), Date.parse(conversation.updatedAt) + 1)).toISOString();
  }

  function record(conversation: GroupConversation, event: string, actorId: string, userId: string | null = null, reason: string | null = null): void {
    events.push({ eventId: randomUUID(), conversationId: conversation.conversationId,
      membershipVersion: conversation.membershipVersion, event, actorId, userId, reason, createdAt: conversation.updatedAt });
  }

  function join(conversationId: string, userId: string, role: ConversationMember['role'], now: string): ConversationMember {
    const member: ConversationMember = { memberId: randomUUID(), conversationId, userId, role, joinedAt: now,
      leftAt: null, removedAt: null, departureActorId: null, departureReason: null, createdAt: now, updatedAt: now };
    members.set(member.memberId, member);
    return member;
  }

  function invite(conversation: GroupConversation, actorId: string, userIds: string[]): GroupInvitation[] {
    validateInvitees(actorId, userIds);
    if (!userIds.length) throw new ConversationStoreError('invalid_members', 'invitees required');
    if (listMembers(conversation.conversationId).length >= MAX_GROUP_MEMBERS) {
      throw new ConversationStoreError('group_full', 'a group can have at most 16 members');
    }
    const now = activityTime(conversation);
    for (const userId of userIds) {
      if (listMembers(conversation.conversationId).some(member => member.userId === userId) ||
          [...invitations.values()].some(invitation => invitation.conversationId === conversation.conversationId &&
            invitation.inviteeId === userId && !invitation.acceptedAt && !invitation.cancelledAt && Date.parse(invitation.expiresAt) > Date.now())) {
        throw new ConversationStoreError('invalid_members', 'already a member or pending invitee');
      }
    }
    conversation.membershipVersion += 1;
    conversation.updatedAt = now;
    return userIds.map(inviteeId => {
      const invitation: GroupInvitation = { invitationId: randomUUID(), conversationId: conversation.conversationId,
        inviteeId, issuerId: actorId, membershipVersion: conversation.membershipVersion, createdAt: now,
        expiresAt: new Date(Date.parse(now) + INVITATION_TTL_MS).toISOString(), acceptedAt: null, cancelledAt: null };
      invitations.set(invitation.invitationId, invitation);
      record(conversation, 'invited', actorId, inviteeId);
      return invitation;
    });
  }

  function listMembers(conversationId: string): ConversationMember[] {
    return [...members.values()]
      .filter((member) => member.conversationId === conversationId && activeGroupMember(member))
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId));
  }

  function snapshot(conversation: GroupConversation): ConversationSnapshot {
    return {
      conversationId: conversation.conversationId,
      name: conversation.name,
      creatorId: conversation.creatorId,
      ownerId: listMembers(conversation.conversationId).find(({ role }) => role === 'owner')?.userId ??
        conversation.creatorId,
      memberIds: listMembers(conversation.conversationId).map(({ userId }) => userId),
      membershipVersion: conversation.membershipVersion,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  function change(conversation: GroupConversation, changedMember?: ConversationMember): ConversationChange {
    return {
      conversation: snapshot(conversation),
      members: listMembers(conversation.conversationId),
      ...(changedMember ? { changedMember } : {}),
    };
  }

  function requireActiveMember(conversationId: string, userId: string): ConversationMember {
    const conversation = conversations.get(conversationId);
    return assertActiveGroupMember(conversation && !conversation.deletedAt
      ? listMembers(conversationId).find(member => member.userId === userId) : null);
  }

  function recipientsFor(conversationId: string): string[] {
    return listMembers(conversationId).map(({ userId }) => userId);
  }

  function callChange(call: GroupCall): GroupCallChange {
    return {
      call,
      participants: [...callParticipants.values()]
        .filter((participant) => participant.callId === call.callId)
        .sort((a, b) => a.invitedAt.localeCompare(b.invitedAt) || a.userId.localeCompare(b.userId)),
    };
  }

  function eraseMembership(member: ConversationMember, pseudonym: string, now: string): void {
    const conversation = conversations.get(member.conversationId);
    const departedAt = conversation ? activityTime(conversation) : now;
    const userId = member.userId;
    if (member.role === 'owner' && activeGroupMember(member) && conversation) {
      const nextOwner = listMembers(member.conversationId).find(({ userId: id }) => id !== userId);
      if (nextOwner) {
        nextOwner.role = 'owner';
        nextOwner.updatedAt = now;
      } else {
        conversation.deletedAt = now;
      }
    }
    member.leftAt ??= departedAt;
    member.departureActorId ??= pseudonym;
    member.departureReason ??= 'account_erasure';
    member.role = 'member';
    member.userId = pseudonym;
    member.updatedAt = departedAt;
    if (conversation) {
      conversation.updatedAt = departedAt;
      conversation.membershipVersion += 1;
      if (conversation.creatorId === userId) conversation.creatorId = pseudonym;
      record(conversation, 'erased', pseudonym, pseudonym, 'account_erasure');
    }
  }

  function anonymizeInvitationsAndEvents(userId: string, pseudonym: string, now: string): void {
    for (const invitation of invitations.values()) {
      if (invitation.inviteeId !== userId && invitation.issuerId !== userId) continue;
      if (!invitation.acceptedAt) invitation.cancelledAt ??= now;
      if (invitation.inviteeId === userId) invitation.inviteeId = pseudonym;
      if (invitation.issuerId === userId) invitation.issuerId = pseudonym;
    }
    anonymizeEvents(userId, pseudonym);
    for (const member of members.values()) {
      if (member.departureActorId === userId) member.departureActorId = pseudonym;
    }
  }

  function anonymizeEvents(userId: string, pseudonym: string): void {
    for (const event of events) {
      if (event.actorId === userId) event.actorId = pseudonym;
      if (event.userId === userId) event.userId = pseudonym;
    }
  }

  function collectEmptyGroup(conversationId: string, erasingUserId: string): void {
    if (listMembers(conversationId).length) return;
    conversations.delete(conversationId);
    for (const [id, member] of members) if (member.conversationId === conversationId) members.delete(id);
    for (const [id, invitation] of invitations) if (invitation.conversationId === conversationId) invitations.delete(id);
    for (let i = events.length - 1; i >= 0; i--) if (events[i].conversationId === conversationId) events.splice(i, 1);
    for (const [id, row] of messages) {
      if (row.conversationId === conversationId && row.senderId !== erasingUserId) messages.delete(id);
    }
    // Own message batches remain until attachment cleanup has processed them.
    collectGroupCalls(conversationId);
  }

  function collectGroupCalls(conversationId: string): void {
    const callIds = new Set([...calls.values()].filter(call => call.conversationId === conversationId).map(call => call.callId));
    callIds.forEach(id => calls.delete(id));
    for (const [id, participant] of callParticipants) if (callIds.has(participant.callId)) callParticipants.delete(id);
  }

  function anonymizeMemberships(userId: string, pseudonym: string, now: string): string[] {
    const affected = [...members.values()].filter(member => member.userId === userId);
    const conversationIds = new Set(affected.map(member => member.conversationId));
    for (const member of affected) eraseMembership(member, pseudonym, now);
    anonymizeInvitationsAndEvents(userId, pseudonym, now);
    for (const conversationId of conversationIds) collectEmptyGroup(conversationId, userId);
    return [...conversationIds];
  }

  function eraseReactions(userId: string): void {
    for (const message of messages.values()) {
      const reactions = Object.entries(message.reactions ?? {}).map(([emoji, ids]) =>
        [emoji, ids.filter(id => id !== userId)] as const);
      message.reactions = Object.fromEntries(reactions.filter(([, ids]) => ids.length > 0));
    }
  }

  function anonymizeCalls(userId: string, pseudonym: string, now: string): void {
    const affectedCalls = new Set<string>();
    for (const call of calls.values()) {
      if (call.initiatorId !== userId) continue;
      call.initiatorId = pseudonym;
      affectedCalls.add(call.callId);
    }
    const renamedParticipants = [...callParticipants.values()]
      .filter(({ userId: participantId }) => participantId === userId);
    for (const participant of renamedParticipants) {
      if (participant.status === 'ringing' || participant.status === 'accepted') {
        participant.status = 'left';
        participant.leftAt = now;
        participant.updatedAt = now;
      }
      affectedCalls.add(participant.callId);
      callParticipants.delete(callParticipantKey(participant.callId, userId));
      participant.userId = pseudonym;
      callParticipants.set(callParticipantKey(participant.callId, pseudonym), participant);
    }
    for (const callId of affectedCalls) {
      const call = calls.get(callId);
      if (!call) continue;
      const hasActiveParticipant = [...callParticipants.values()].some((participant) =>
        participant.callId === callId &&
        (participant.status === 'ringing' || participant.status === 'accepted')
      );
      if (!hasActiveParticipant) {
        call.status = 'ended';
        call.endedAt = now;
      }
      call.updatedAt = now;
      call.stateVersion += 1;
    }
  }

  return {
    async listInvitations(userId) {
      const now = new Date().toISOString();
      return [...invitations.values()].filter(invitation => invitation.inviteeId === userId &&
        !invitation.acceptedAt && !invitation.cancelledAt && invitation.expiresAt > now);
    },

    async acceptInvitation({ conversationId, invitationId, userId }) {
      const invitation = invitations.get(invitationId);
      const conversation = conversations.get(conversationId);
      const now = conversation ? activityTime(conversation) : new Date().toISOString();
      if (!conversation || conversation.deletedAt || !invitation || invitation.conversationId !== conversationId ||
          invitation.inviteeId !== userId || invitation.acceptedAt || invitation.cancelledAt || Date.parse(invitation.expiresAt) <= Date.now()) {
        throw new ConversationStoreError('invalid_invitation', 'invitation unavailable');
      }
      if (listMembers(conversationId).some(member => member.userId === userId)) {
        throw new ConversationStoreError('invalid_members', 'already an active member');
      }
      if (listMembers(conversationId).length >= MAX_GROUP_MEMBERS) {
        throw new ConversationStoreError('group_full', 'a group can have at most 16 members');
      }
      invitation.acceptedAt = now;
      const member = join(conversationId, userId, 'member', now);
      conversation.membershipVersion += 1;
      conversation.updatedAt = now;
      record(conversation, 'accepted', userId, userId);
      return change(conversation, member);
    },

    async cancelInvitation({ conversationId, invitationId, actorId }) {
      requireGroupAdmin(requireActiveMember(conversationId, actorId));
      const invitation = invitations.get(invitationId);
      if (!invitation || invitation.conversationId !== conversationId || invitation.acceptedAt || invitation.cancelledAt) {
        throw new ConversationStoreError('invalid_invitation', 'invitation unavailable');
      }
      invitation.cancelledAt = new Date().toISOString();
      const conversation = conversations.get(conversationId)!;
      conversation.membershipVersion += 1;
      conversation.updatedAt = activityTime(conversation);
      record(conversation, 'invitation_cancelled', actorId, invitation.inviteeId);
    },

    async listMembershipEvents(conversationId, userId) {
      const member = requireActiveMember(conversationId, userId);
      return events.filter(event => event.conversationId === conversationId && event.createdAt >= member.joinedAt);
    },

    async exportMemberships(userId) {
      return [...members.values()].filter(member => member.userId === userId);
    },

    async exportMessages({ userId, conversationId, limit, before, beforeMessageId }) {
      return [...messages.values()].filter(message => message.senderId === userId && message.conversationId === conversationId &&
        (!before || message.createdAt < before || (message.createdAt === before && Boolean(beforeMessageId) && message.messageId < beforeMessageId!)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.messageId.localeCompare(a.messageId))
        .slice(0, Math.min(Math.max(Math.floor(limit) || 1, 1), 101));
    },

    async setRole({ conversationId, actorId, userId, role }) {
      const actor = requireActiveMember(conversationId, actorId);
      const member = requireActiveMember(conversationId, userId);
      if (actor.role !== 'owner' || member.role === 'owner') throw new ConversationStoreError('forbidden', 'only owner may change non-owner roles');
      member.role = role;
      member.updatedAt = new Date().toISOString();
      const conversation = conversations.get(conversationId)!;
      conversation.membershipVersion += 1;
      conversation.updatedAt = activityTime(conversation);
      record(conversation, 'role_changed', actorId, userId, role);
      return change(conversation, member);
    },

    async transferOwnership({ conversationId, actorId, userId }) {
      const actor = requireActiveMember(conversationId, actorId);
      const member = requireActiveMember(conversationId, userId);
      if (actor.role !== 'owner' || member.role !== 'admin') throw new ConversationStoreError('forbidden', 'ownership requires an active admin');
      actor.role = 'admin';
      member.role = 'owner';
      const conversation = conversations.get(conversationId)!;
      conversation.membershipVersion += 1;
      conversation.updatedAt = activityTime(conversation);
      actor.updatedAt = member.updatedAt = conversation.updatedAt;
      record(conversation, 'ownership_transferred', actorId, userId);
      return change(conversation, member);
    },

    async deleteGroup(conversationId, actorId) {
      const actor = requireActiveMember(conversationId, actorId);
      if (actor.role !== 'owner' || listMembers(conversationId).length !== 1) {
        throw new ConversationStoreError('forbidden', 'only owner may delete a group without other members');
      }
      const conversation = conversations.get(conversationId)!;
      const now = activityTime(conversation);
      actor.leftAt = now;
      actor.departureActorId = actorId;
      actor.departureReason = 'group_deleted';
      conversation.deletedAt = now;
      conversation.updatedAt = now;
      conversation.membershipVersion += 1;
      for (const invitation of invitations.values()) {
        if (invitation.conversationId === conversationId && !invitation.acceptedAt) invitation.cancelledAt ??= now;
      }
      record(conversation, 'deleted', actorId, actorId);
    },

    async create({ name, creatorId, inviteeIds }) {
      validateInvitees(creatorId, inviteeIds);
      for (const userId of inviteeIds) if (!(await canInvite(creatorId, userId))) {
        throw new ConversationStoreError('forbidden', 'blocked accounts cannot be invited');
      }
      const now = new Date().toISOString();
      const conversation: GroupConversation = {
        conversationId: randomUUID(),
        name,
        creatorId,
        membershipVersion: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      conversations.set(conversation.conversationId, conversation);
      const changedMember = join(conversation.conversationId, creatorId, 'owner', now);
      record(conversation, 'created', creatorId, creatorId);
      const issued = inviteeIds.length ? invite(conversation, creatorId, inviteeIds) : [];
      return { ...change(conversation, changedMember), invitations: issued };
    },

    async get(conversationId, userId) {
      if (userId) requireActiveMember(conversationId, userId);
      const conversation = conversations.get(conversationId);
      return conversation && conversation.deletedAt === null ? snapshot(conversation) : null;
    },

    async getMember(conversationId, userId) {
      const conversation = conversations.get(conversationId);
      return conversation && !conversation.deletedAt
        ? listMembers(conversationId).find(member => member.userId === userId) ?? null : null;
    },

    async listMembers(conversationId) {
      return listMembers(conversationId);
    },

    async listForUser(userId) {
      return [...conversations.values()]
        .filter((conversation) =>
          conversation.deletedAt === null &&
          listMembers(conversation.conversationId).some(member => member.userId === userId)
        )
        .map(snapshot)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async listMessages({ conversationId, userId, limit, before, beforeMessageId }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.deletedAt !== null) {
        throw new ConversationStoreError('not_member', 'not an active member');
      }
      const member = requireActiveMember(conversationId, userId);
      return [...messages.values()]
        .filter((message) =>
          message.conversationId === conversationId &&
          Date.parse(message.createdAt) >= Date.parse(member.joinedAt) &&
          (!before ||
            message.createdAt < before ||
            (Boolean(beforeMessageId) &&
              message.createdAt === before &&
              message.messageId < beforeMessageId!))
        )
        .sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.messageId.localeCompare(a.messageId)
        )
        .slice(0, Math.min(Math.max(Math.floor(limit) || 1, 1), 101));
    },

    async searchMessages({ conversationId, userId, query, limit, before, beforeMessageId }) {
      const member = requireActiveMember(conversationId, userId);
      return [...messages.values()].filter(message => message.conversationId === conversationId && !message.deletedAt &&
        Date.parse(message.createdAt) >= Date.parse(member.joinedAt) && message.body.toLowerCase().includes(query.toLowerCase()) &&
        (!before || message.createdAt < before || (Boolean(beforeMessageId) && message.createdAt === before && message.messageId < beforeMessageId!)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.messageId.localeCompare(a.messageId))
        .slice(0, Math.min(Math.max(Math.floor(limit) || 1, 1), 101));
    },

    async updateName({ conversationId, actorId, name }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.deletedAt !== null) return null;
      const actor = requireActiveMember(conversationId, actorId);
      requireGroupAdmin(actor);
      conversation.name = name;
      conversation.updatedAt = activityTime(conversation);
      conversation.membershipVersion += 1;
      record(conversation, 'renamed', actorId);
      return change(conversation);
    },

    async addMembers({ conversationId, actorId, userIds }) {
      validateInvitees(actorId, userIds);
      for (const userId of userIds) if (!(await canInvite(actorId, userId))) {
        throw new ConversationStoreError('forbidden', 'blocked accounts cannot be invited');
      }
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.deletedAt !== null) return null;
      const actor = requireActiveMember(conversationId, actorId);
      requireGroupAdmin(actor);
      const issued = invite(conversation, actorId, userIds);
      return { ...change(conversation), invitations: issued };
    },

    async removeMember({ conversationId, actorId, userId, reason }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.deletedAt !== null) return null;
      const actor = requireActiveMember(conversationId, actorId);
      const member = requireActiveMember(conversationId, userId);
      requireGroupAdmin(actor);
      if (member.role === 'owner' || actorId === userId) {
        throw new ConversationStoreError('forbidden', 'the owner cannot be removed');
      }
      const now = activityTime(conversation);
      member.leftAt = now;
      member.removedAt = now;
      member.departureActorId = actorId;
      member.departureReason = reason ?? 'removed';
      member.updatedAt = now;
      conversation.updatedAt = now;
      conversation.membershipVersion += 1;
      record(conversation, 'removed', actorId, userId, member.departureReason);
      const callChanges: GroupCallChange[] = [];
      for (const participant of callParticipants.values()) {
        if (participant.userId !== userId || (participant.status !== 'ringing' && participant.status !== 'accepted')) continue;
        const call = calls.get(participant.callId);
        if (!call || call.conversationId !== conversationId || call.status === 'ended') continue;
        participant.status = 'left';
        participant.leftAt = now;
        participant.updatedAt = now;
        if (![...callParticipants.values()].some((item) =>
          item.callId === call.callId && (item.status === 'ringing' || item.status === 'accepted')
        )) {
          call.status = 'ended';
          call.endedAt = now;
        }
        call.updatedAt = now;
        call.stateVersion += 1;
        callChanges.push(callChange(call));
      }
      return { ...change(conversation, member), callChanges };
    },

    async leave({ conversationId, userId }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.deletedAt !== null) return null;
      const member = requireActiveMember(conversationId, userId);
      if (member.role === 'owner') throw new ConversationStoreError('forbidden', 'transfer ownership before leaving');
      const now = activityTime(conversation);
      member.leftAt = now;
      member.departureActorId = userId;
      member.departureReason = 'left';
      member.updatedAt = now;
      conversation.updatedAt = now;
      conversation.membershipVersion += 1;
      record(conversation, 'left', userId, userId, 'left');
      const callChanges: GroupCallChange[] = [];
      for (const participant of callParticipants.values()) {
        if (
          participant.userId !== userId ||
          (participant.status !== 'ringing' && participant.status !== 'accepted')
        ) continue;
        const call = calls.get(participant.callId);
        if (!call || call.conversationId !== conversationId || call.status === 'ended') continue;
        participant.status = 'left';
        participant.leftAt = now;
        participant.updatedAt = now;
        if (![...callParticipants.values()].some((item) =>
          item.callId === call.callId &&
          (item.status === 'ringing' || item.status === 'accepted')
        )) {
          call.status = 'ended';
          call.endedAt = now;
        }
        call.updatedAt = now;
        call.stateVersion += 1;
        callChanges.push(callChange(call));
      }
      return {
        ...change(conversation, member),
        callChanges,
      };
    },

    async saveMessage(message) {
      const member = requireActiveMember(message.conversationId, message.senderId);
      if (message.attachment && attachmentScopeFromKey(message.attachment.url) !== `group_${message.conversationId}`) {
        throw new ConversationStoreError('forbidden', 'attachment must belong to this group');
      }
      if (message.replyTo) {
        const parent = messages.get(messageKey(message.conversationId, message.replyTo));
        if (!parent || Date.parse(parent.createdAt) < Date.parse(member.joinedAt)) {
          throw new ConversationStoreError('forbidden', 'reply is outside membership interval');
        }
      }
      const key = messageKey(message.conversationId, message.messageId);
      const existing = (message.clientMessageId
        ? [...messages.values()].find(candidate => candidate.senderId === message.senderId &&
          candidate.clientMessageId === message.clientMessageId)
        : undefined) ?? messages.get(key);
      if (existing) {
        if (existing.conversationId !== message.conversationId || Date.parse(existing.createdAt) < Date.parse(member.joinedAt)) {
          throw new ConversationStoreError('forbidden', 'message is outside membership interval');
        }
        return { message: existing, recipients: recipientsFor(message.conversationId), inserted: false };
      }
      const conversation = conversations.get(message.conversationId)!;
      message.createdAt = activityTime(conversation);
      conversation.updatedAt = message.createdAt;
      messages.set(key, message);
      return { message, recipients: recipientsFor(message.conversationId), inserted: true };
    },

    async getMessage(conversationId, messageId, userId) {
      const member = requireActiveMember(conversationId, userId);
      const message = messages.get(messageKey(conversationId, messageId));
      return message && Date.parse(message.createdAt) >= Date.parse(member.joinedAt) ? message : null;
    },

    async deleteMessage({ conversationId, messageId, userId }) {
      const member = requireActiveMember(conversationId, userId);
      const message = messages.get(messageKey(conversationId, messageId));
      if (!message || Date.parse(message.createdAt) < Date.parse(member.joinedAt) ||
          message.deletedAt || message.senderId !== userId) return null;
      applyTombstone(message, new Date().toISOString());
      return { message, recipients: recipientsFor(conversationId) };
    },

    async reactToMessage({ conversationId, messageId, userId, emoji, action }) {
      const member = requireActiveMember(conversationId, userId);
      const message = messages.get(messageKey(conversationId, messageId));
      if (!message || Date.parse(message.createdAt) < Date.parse(member.joinedAt) || message.deletedAt) return null;
      message.reactions = applyReaction(message.reactions ?? {}, emoji, userId, action);
      return { message, recipients: recipientsFor(conversationId) };
    },

    async startCall({ conversationId, initiatorId, mediaType, ringTimeoutMs, excludedUserIds = [] }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.deletedAt !== null) return null;
      requireActiveMember(conversationId, initiatorId);
      const excluded = new Set(excludedUserIds);
      const invitees = listMembers(conversationId)
        .filter(({ userId }) => userId !== initiatorId && !excluded.has(userId));
      if (invitees.length === 0) return null;
      const now = new Date().toISOString();
      const call: GroupCall = {
        callId: randomUUID(),
        conversationId,
        initiatorId,
        mediaType,
        status: 'ringing',
        stateVersion: 1,
        ringTimeoutAt: new Date(Date.now() + ringTimeoutMs).toISOString(),
        createdAt: now,
        updatedAt: now,
        endedAt: null,
      };
      calls.set(call.callId, call);
      for (const userId of [initiatorId, ...invitees.map(({ userId }) => userId)]) {
        callParticipants.set(callParticipantKey(call.callId, userId), {
          callId: call.callId,
          userId,
          status: userId === initiatorId ? 'accepted' : 'ringing',
          invitedAt: now,
          acceptedAt: userId === initiatorId ? now : null,
          leftAt: null,
          updatedAt: now,
        });
      }
      return callChange(call);
    },

    async transitionCall({ callId, userId, action }) {
      const call = calls.get(callId);
      if (!call || call.status === 'ended') return null;
      requireActiveMember(call.conversationId, userId);
      const now = new Date().toISOString();
      const participant = callParticipants.get(callParticipantKey(callId, userId));
      if (!participant) return null;
      if (
        participant.status === 'ringing' &&
        call.ringTimeoutAt !== null &&
        Date.parse(call.ringTimeoutAt) <= Date.parse(now)
      ) {
        const expired = await this.expireCall(callId);
        return expired ? { ...expired, expired: true } : null;
      }
      if (action === 'accept' && participant.status === 'ringing') {
        participant.status = 'accepted';
        participant.acceptedAt = now;
      } else if (action === 'decline' && participant.status === 'ringing') {
        participant.status = 'declined';
        participant.leftAt = now;
      } else if (action === 'leave' && (participant.status === 'ringing' || participant.status === 'accepted')) {
        participant.status = 'left';
        participant.leftAt = now;
      } else {
        return callChange(call);
      }
      participant.updatedAt = now;
      call.updatedAt = now;
      call.stateVersion += 1;
      if (action === 'accept') call.status = 'active';
      if (![...callParticipants.values()].some((item) =>
        item.callId === callId && (item.status === 'ringing' || item.status === 'accepted')
      )) {
        call.status = 'ended';
        call.endedAt = now;
      }
      return callChange(call);
    },

    async expireCall(callId, nowMs = Date.now()) {
      const call = calls.get(callId);
      if (
        !call ||
        (call.status !== 'ringing' && call.status !== 'active') ||
        !call.ringTimeoutAt ||
        Date.parse(call.ringTimeoutAt) > nowMs
      ) return null;
      if (![...callParticipants.values()].some((participant) =>
        participant.callId === callId && participant.status === 'ringing'
      )) return null;
      const now = new Date(nowMs).toISOString();
      for (const participant of callParticipants.values()) {
        if (participant.callId !== callId || participant.status !== 'ringing') continue;
        participant.status = 'declined';
        participant.leftAt = now;
        participant.updatedAt = now;
      }
      if (call.status === 'ringing') {
        for (const participant of callParticipants.values()) {
          if (participant.callId !== callId || participant.status !== 'accepted') continue;
          participant.status = 'left';
          participant.leftAt = now;
          participant.updatedAt = now;
        }
        call.status = 'ended';
      } else if (![...callParticipants.values()].some((participant) =>
        participant.callId === callId && participant.status === 'accepted'
      )) {
        call.status = 'ended';
      }
      call.updatedAt = now;
      if (call.status === 'ended') call.endedAt = now;
      call.stateVersion += 1;
      return callChange(call);
    },

    async listExpiredCallIds(now = Date.now()) {
      return [...calls.values()]
        .filter((call) =>
          (call.status === 'ringing' || call.status === 'active') &&
          call.ringTimeoutAt !== null &&
          Date.parse(call.ringTimeoutAt) <= now &&
          [...callParticipants.values()].some((participant) =>
            participant.callId === call.callId && participant.status === 'ringing'
          )
        )
        .map(({ callId }) => callId);
    },

    async eraseUserData(userId, pseudonym) {
      const now = new Date().toISOString();
      const conversationIds = anonymizeMemberships(userId, pseudonym, now);
      eraseReactions(userId);
      anonymizeCalls(userId, pseudonym, now);
      return { conversationIds };
    },

    async eraseUserMessages(userId, pseudonym, limit) {
      const now = new Date().toISOString();
      const batch = Math.min(Math.max(Math.floor(limit) || 1, 1), 500);
      const attachmentUrls: string[] = [];
      const conversationIds = new Set<string>();
      let messagesTombstoned = 0;
      const page = [...messages.values()]
        .filter(({ senderId }) => senderId === userId)
        .slice(0, batch);
      for (const message of page) {
        conversationIds.add(message.conversationId);
        if (!message.deletedAt) {
          messagesTombstoned += 1;
          const url = (message.attachment as { url?: unknown } | null)?.url;
          if (typeof url === 'string') attachmentUrls.push(url);
          applyTombstone(message, now);
        }
        message.senderId = pseudonym;
        if (!conversations.has(message.conversationId)) messages.delete(messageKey(message.conversationId, message.messageId));
      }
      return {
        attachmentUrls,
        conversationIds: [...conversationIds],
        messagesTombstoned,
        messagesProcessed: page.length,
      };
    },
  };
}

export { createMemoryConversationStore };
