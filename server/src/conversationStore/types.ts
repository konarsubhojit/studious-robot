import type { StoredMessage } from '../messageStore/types.ts';

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
  conversationId: string;
  userId: string;
  role: ConversationRole;
  joinedAt: string;
  leftAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConversationSnapshot = {
  conversationId: string;
  name: string;
  creatorId: string;
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
  create: (args: {
    name: string;
    creatorId: string;
    inviteeIds: string[];
  }) => Promise<ConversationChange>;
  get: (conversationId: string) => Promise<ConversationSnapshot | null>;
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
  updateName: (args: {
    conversationId: string;
    actorId: string;
    name: string;
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
  getMessage: (conversationId: string, messageId: string) => Promise<StoredMessage | null>;
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
  eraseUserMessages: (userId: string, pseudonym: string, limit: number) => Promise<{
    attachmentUrls: string[];
    conversationIds: string[];
    messagesTombstoned: number;
    messagesProcessed: number;
  }>;
};

export class ConversationStoreError extends Error {
  code: 'not_member' | 'forbidden' | 'group_full' | 'invalid_members';

  constructor(code: ConversationStoreError['code'], message: string) {
    super(message);
    this.code = code;
  }
}
