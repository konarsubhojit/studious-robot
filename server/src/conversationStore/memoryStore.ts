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

const MAX_GROUP_MEMBERS = 16;

function memberKey(conversationId: string, userId: string): string {
  return JSON.stringify([conversationId, userId]);
}

function messageKey(conversationId: string, messageId: string): string {
  return JSON.stringify([conversationId, messageId]);
}

function callParticipantKey(callId: string, userId: string): string {
  return JSON.stringify([callId, userId]);
}

function createMemoryConversationStore(): ConversationStore {
  const conversations = new Map<string, GroupConversation>();
  const members = new Map<string, ConversationMember>();
  const messages = new Map<string, StoredMessage>();
  const calls = new Map<string, GroupCall>();
  const callParticipants = new Map<string, GroupCallParticipant>();

  function listMembers(conversationId: string): ConversationMember[] {
    return [...members.values()]
      .filter((member) => member.conversationId === conversationId && member.leftAt === null)
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
    const member = members.get(memberKey(conversationId, userId));
    if (!member || member.leftAt !== null) throw new ConversationStoreError('not_member', 'not an active member');
    return member;
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

  function anonymizeMemberships(userId: string, pseudonym: string, now: string): string[] {
    const conversationIds = new Set<string>();
    for (const member of members.values()) {
      if (member.userId !== userId) continue;
      const conversation = conversations.get(member.conversationId);
      if (member.role === 'owner' && member.leftAt === null && conversation) {
        const nextOwner = listMembers(member.conversationId).find(({ userId: id }) => id !== userId);
        if (nextOwner) {
          nextOwner.role = 'owner';
          nextOwner.updatedAt = now;
        } else {
          conversation.deletedAt = now;
        }
      }
      member.leftAt ??= now;
      member.role = 'member';
      member.userId = pseudonym;
      member.updatedAt = now;
      if (conversation) {
        conversation.updatedAt = now;
        conversation.membershipVersion += 1;
        conversationIds.add(conversation.conversationId);
        if (conversation.creatorId === userId) conversation.creatorId = pseudonym;
      }
      members.delete(memberKey(member.conversationId, userId));
      members.set(memberKey(member.conversationId, pseudonym), member);
    }
    return [...conversationIds];
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
    async create({ name, creatorId, inviteeIds }) {
      const memberIds = [creatorId, ...inviteeIds];
      if (memberIds.length < 2) {
        throw new ConversationStoreError('invalid_members', 'a group must have at least two members');
      }
      if (new Set(memberIds).size !== memberIds.length) {
        throw new ConversationStoreError('invalid_members', 'duplicate conversation members');
      }
      if (memberIds.length > MAX_GROUP_MEMBERS) {
        throw new ConversationStoreError('group_full', 'a group can have at most 16 members');
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
      let changedMember: ConversationMember | undefined;
      for (const userId of memberIds) {
        const member: ConversationMember = {
          conversationId: conversation.conversationId,
          userId,
          role: userId === creatorId ? 'owner' : 'member',
          joinedAt: now,
          leftAt: null,
          createdAt: now,
          updatedAt: now,
        };
        members.set(memberKey(conversation.conversationId, userId), member);
        if (userId === creatorId) changedMember = member;
      }
      return change(conversation, changedMember);
    },

    async get(conversationId) {
      const conversation = conversations.get(conversationId);
      return conversation && conversation.deletedAt === null ? snapshot(conversation) : null;
    },

    async getMember(conversationId, userId) {
      const member = members.get(memberKey(conversationId, userId));
      return member && member.leftAt === null ? member : null;
    },

    async listMembers(conversationId) {
      return listMembers(conversationId);
    },

    async listForUser(userId) {
      return [...conversations.values()]
        .filter((conversation) =>
          conversation.deletedAt === null &&
          members.get(memberKey(conversation.conversationId, userId))?.leftAt === null
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
        .slice(0, Math.min(Math.max(Math.floor(limit) || 1, 1), 100));
    },

    async updateName({ conversationId, actorId, name }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.deletedAt !== null) return null;
      const actor = requireActiveMember(conversationId, actorId);
      if (actor.role !== 'owner' && actor.role !== 'admin') {
        throw new ConversationStoreError('forbidden', 'only owners and admins can update the group');
      }
      conversation.name = name;
      conversation.updatedAt = new Date().toISOString();
      conversation.membershipVersion += 1;
      return change(conversation);
    },

    async addMembers({ conversationId, actorId, userIds }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.deletedAt !== null) return null;
      const actor = requireActiveMember(conversationId, actorId);
      if (actor.role !== 'owner' && actor.role !== 'admin') {
        throw new ConversationStoreError('forbidden', 'only owners and admins can manage group members');
      }
      const currentMembers = listMembers(conversationId);
      if (
        userIds.length === 0 ||
        new Set(userIds).size !== userIds.length ||
        userIds.includes(actorId) ||
        userIds.some((userId) => members.has(memberKey(conversationId, userId)))
      ) {
        throw new ConversationStoreError('invalid_members', 'invalid or previously joined group member');
      }
      if (currentMembers.length + userIds.length > MAX_GROUP_MEMBERS) {
        throw new ConversationStoreError('group_full', 'a group can have at most 16 members');
      }
      const now = new Date().toISOString();
      for (const userId of userIds) {
        members.set(memberKey(conversationId, userId), {
          conversationId,
          userId,
          role: 'member',
          joinedAt: now,
          leftAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }
      conversation.updatedAt = now;
      conversation.membershipVersion += 1;
      return change(conversation);
    },

    async removeMember({ conversationId, actorId, userId }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.deletedAt !== null) return null;
      const actor = requireActiveMember(conversationId, actorId);
      const member = requireActiveMember(conversationId, userId);
      if (actor.role !== 'owner' && actor.role !== 'admin') {
        throw new ConversationStoreError('forbidden', 'only owners and admins can manage group members');
      }
      if (member.role === 'owner' || actorId === userId) {
        throw new ConversationStoreError('forbidden', 'the owner cannot be removed');
      }
      const now = new Date().toISOString();
      member.leftAt = now;
      member.updatedAt = now;
      conversation.updatedAt = now;
      conversation.membershipVersion += 1;
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
      const now = new Date().toISOString();
      member.leftAt = now;
      member.updatedAt = now;
      conversation.updatedAt = now;
      conversation.membershipVersion += 1;
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
      let previousOwnerId: string | undefined;
      if (member.role === 'owner') {
        previousOwnerId = userId;
        const nextOwner = listMembers(conversationId)[0];
        if (nextOwner) {
          nextOwner.role = 'owner';
          nextOwner.updatedAt = now;
        } else {
          conversation.deletedAt = now;
        }
      }
      return {
        ...change(conversation, member),
        ...(previousOwnerId ? { previousOwnerId } : {}),
        callChanges,
      };
    },

    async saveMessage(message) {
      requireActiveMember(message.conversationId, message.senderId);
      const key = messageKey(message.conversationId, message.messageId);
      const existing = messages.get(key);
      if (existing) return { message: existing, recipients: recipientsFor(message.conversationId), inserted: false };
      messages.set(key, message);
      return { message, recipients: recipientsFor(message.conversationId), inserted: true };
    },

    async getMessage(conversationId, messageId) {
      return messages.get(messageKey(conversationId, messageId)) ?? null;
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
