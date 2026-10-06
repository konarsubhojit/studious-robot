import type { StoredMessage } from '../messageStore/types.ts';
import type { ListMessageChangesOptions, MessageChange, SearchMessagesOptions } from '../messageStore/types.ts';

export type ConversationRole = 'owner' | 'admin' | 'member';

export type GroupConversation = {
  conversationId: string;
  name: string;
  creatorId: string;
  membershipVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type ConversationMember = {
  memberId: string;
  conversationId: string;
  userId: string;
  role: ConversationRole;
  joinedAt: string;
  leftAt: string | null;
  removedAt: string | null;
  departureActorId: string | null;
  departureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GroupInvitation = {
  invitationId: string;
  conversationId: string;
  inviteeId: string;
  issuerId: string;
  membershipVersion: number;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  cancelledAt: string | null;
};

export type GroupMembershipEvent = {
  eventId: string;
  conversationId: string;
  membershipVersion: number;
  event: string;
  actorId: string;
  userId: string | null;
  reason: string | null;
  createdAt: string;
};

export type ConversationSnapshot = {
  conversationId: string;
  name: string;
  creatorId: string;
  ownerId: string;
  memberIds: string[];
  membershipVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type ConversationChange = {
  conversation: ConversationSnapshot;
  members: ConversationMember[];
  changedMember?: ConversationMember;
  previousOwnerId?: string;
  callChanges?: GroupCallChange[];
  invitations?: GroupInvitation[];
};

export type GroupCallParticipant = {
  callId: string;
  userId: string;
  status: 'ringing' | 'accepted' | 'declined' | 'left';
  invitedAt: string;
  acceptedAt: string | null;
  leftAt: string | null;
  updatedAt: string;
};

export type GroupCall = {
  callId: string;
  conversationId: string;
  initiatorId: string;
  mediaType: 'audio' | 'video';
  status: 'ringing' | 'active' | 'ended';
  stateVersion: number;
  ringTimeoutAt: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
};

export type GroupCallChange = {
  call: GroupCall;
  participants: GroupCallParticipant[];
  expired?: boolean;
};

export type ConversationStore = {
  listInvitations: (userId: string) => Promise<GroupInvitation[]>;
  acceptInvitation: (args: { conversationId: string; invitationId: string; userId: string }) => Promise<ConversationChange>;
  cancelInvitation: (args: { conversationId: string; invitationId: string; actorId: string }) => Promise<void>;
  listMembershipEvents: (conversationId: string, userId: string) => Promise<GroupMembershipEvent[]>;
  exportMemberships: (userId: string) => Promise<ConversationMember[]>;
  exportMessages: (args: { userId: string; conversationId: string; limit: number; before?: string; beforeMessageId?: string }) => Promise<StoredMessage[]>;
  setRole: (args: { conversationId: string; actorId: string; userId: string; role: 'admin' | 'member' }) => Promise<ConversationChange>;
  transferOwnership: (args: { conversationId: string; actorId: string; userId: string }) => Promise<ConversationChange>;
  deleteGroup: (conversationId: string, actorId: string) => Promise<void>;
  create: (args: {
    name: string;
    creatorId: string;
    inviteeIds: string[];
  }) => Promise<ConversationChange>;
  get: (conversationId: string, userId?: string) => Promise<ConversationSnapshot | null>;
  getMember: (conversationId: string, userId: string) => Promise<ConversationMember | null>;
  listMembers: (conversationId: string) => Promise<ConversationMember[]>;
  listForUser: (userId: string) => Promise<ConversationSnapshot[]>;
  listMessages: (args: {
    conversationId: string;
    userId: string;
    limit: number;
    before?: string;
    beforeMessageId?: string;
  }) => Promise<StoredMessage[]>;
  searchMessages: (args: SearchMessagesOptions & { userId: string; query: string }) => Promise<StoredMessage[]>;
  listMessageChanges: (args: ListMessageChangesOptions) => Promise<MessageChange[]>;
  markRead: (conversationId: string, userId: string) => Promise<number>;
  markDelivered: (conversationId: string, messageId: string, userId: string) => Promise<StoredMessage | null>;
  updateName: (args: {
    conversationId: string;
    actorId: string;
    name: string;
  }) => Promise<ConversationChange | null>;
  addMembers: (args: {
    conversationId: string;
    actorId: string;
    userIds: string[];
  }) => Promise<ConversationChange | null>;
  removeMember: (args: {
    conversationId: string;
    actorId: string;
    userId: string;
    reason?: string;
  }) => Promise<ConversationChange | null>;
  leave: (args: {
    conversationId: string;
    userId: string;
  }) => Promise<ConversationChange | null>;
  saveMessage: (message: StoredMessage) => Promise<{
    message: StoredMessage;
    recipients: string[];
    inserted: boolean;
  } | null>;
  getMessage: (conversationId: string, messageId: string, userId: string) => Promise<StoredMessage | null>;
  deleteMessage: (args: {
    conversationId: string;
    messageId: string;
    userId: string;
  }) => Promise<{ message: StoredMessage; recipients: string[] } | null>;
  reactToMessage: (args: {
    conversationId: string;
    messageId: string;
    userId: string;
    emoji: string;
    action: 'add' | 'remove';
  }) => Promise<{ message: StoredMessage; recipients: string[] } | null>;
  getCall: (callId: string) => Promise<GroupCallChange | null>;
  listCallHistory: (args: {
    userId: string;
    statusFilter?: string | null;
    limit: number;
    offset?: number;
  }) => Promise<{ calls: import('../../../shared/groupCalls.ts').GroupCallHistoryEntry[]; total: number }>;
  startCall: (args: {
    conversationId: string;
    initiatorId: string;
    mediaType: 'audio' | 'video';
    ringTimeoutMs: number;
    excludedUserIds?: string[];
  }) => Promise<GroupCallChange | null>;
  transitionCall: (args: {
    callId: string;
    userId: string;
    action: 'accept' | 'decline' | 'leave';
  }) => Promise<GroupCallChange | null>;
  expireCall: (callId: string, now?: number) => Promise<GroupCallChange | null>;
  listExpiredCallIds: (now?: number) => Promise<string[]>;
  eraseUserData: (userId: string, pseudonym: string) => Promise<{
    conversationIds: string[];
  }>;
  listAttachmentCleanup: (limit: number, after?: string) => Promise<string[]>;
  acknowledgeAttachmentCleanup: (url: string) => Promise<void>;
  eraseUserMessages: (userId: string, pseudonym: string, limit: number) => Promise<{
    attachmentUrls: string[];
    conversationIds: string[];
    messagesTombstoned: number;
    messagesProcessed: number;
  }>;
};

export class ConversationStoreError extends Error {
  code: 'not_member' | 'forbidden' | 'group_full' | 'group_call_full' | 'invalid_members' | 'invalid_invitation';

  constructor(code: ConversationStoreError['code'], message: string) {
    super(message);
    this.code = code;
  }
}
