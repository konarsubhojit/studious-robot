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

    async leave({ conversationId, userId }) {
      const conversation = conversations.get(conversationId);
      if (!conversation || conversation.deletedAt !== null) return null;
      const member = requireActiveMember(conversationId, userId);
      const now = new Date().toISOString();
      member.leftAt = now;
      member.updatedAt = now;
      conversation.updatedAt = now;
      conversation.membershipVersion += 1;
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
      return { ...change(conversation, member), ...(previousOwnerId ? { previousOwnerId } : {}) };
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
      requireActiveMember(conversationId, userId);
      const message = messages.get(messageKey(conversationId, messageId));
      if (!message || message.deletedAt || message.senderId !== userId) return null;
      applyTombstone(message, new Date().toISOString());
      return { message, recipients: recipientsFor(conversationId) };
    },

    async reactToMessage({ conversationId, messageId, userId, emoji, action }) {
      requireActiveMember(conversationId, userId);
      const message = messages.get(messageKey(conversationId, messageId));
      if (!message || message.deletedAt) return null;
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
      const participant = callParticipants.get(callParticipantKey(callId, userId));
      if (!participant) return null;
      const now = new Date().toISOString();
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
      if (action === 'accept') call.status = 'active';
      if (![...callParticipants.values()].some((item) =>
        item.callId === callId && (item.status === 'ringing' || item.status === 'accepted')
      )) {
        call.status = 'ended';
        call.endedAt = now;
      }
      return callChange(call);
    },

    async expireCall(callId) {
      const call = calls.get(callId);
      if (!call || call.status !== 'ringing') return null;
      const now = new Date().toISOString();
      for (const participant of callParticipants.values()) {
        if (participant.callId !== callId || participant.status === 'declined' || participant.status === 'left') continue;
        participant.status = participant.status === 'ringing' ? 'declined' : 'left';
        participant.leftAt = now;
        participant.updatedAt = now;
      }
      call.status = 'ended';
      call.updatedAt = now;
      call.endedAt = now;
      return callChange(call);
    },
  };
}

export { createMemoryConversationStore };
