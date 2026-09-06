/**
 * Message-store vocabulary: the domain shapes and the store interface.
 *
 * The interface is the seam that let chat history move from MongoDB to
 * Postgres without any caller changing: `createServer` holds a `MessageStore`,
 * not a driver, and the tests exercise the contract rather than a backend.
 */

export type MessageRecord = import('../stores/contracts.ts').MessageRecord;

export type StoredMessage = MessageRecord & {
  type: string;
  attachment: object | null;
  replyTo: string | null;
  reactions: Record<string, string[]>;
  deletedAt: string | null;
  deliveredTo: string[];
  readAt: string | null;
};

export type ConversationSummary = {
  conversationId: string;
  peerId: string;
  lastMessage: StoredMessage;
  unreadCount: number;
};

export type NewMessageInput = Partial<MessageRecord> & {
  senderId: string;
  recipientId: string;
  body: string;
};

export type ListMessagesOptions = {
  conversationId?: string;
  limit?: unknown;
  before?: string;
};

export type SearchMessagesOptions = {
  userId?: string;
  query?: unknown;
  limit?: unknown;
  before?: string;
};

export type ReactToMessageOptions = {
  conversationId?: string;
  messageId?: string;
  userId?: string;
  emoji?: string;
  action?: 'add' | 'remove';
};

export type DeliveryReceiptInput = {
  messageId: string;
  userId: string;
  conversationId?: string;
};

export type MessageStore = {
  type: 'memory' | 'postgres';
  saveMessage: (message: NewMessageInput) => Promise<StoredMessage>;
  listMessages: (opts?: ListMessagesOptions) => Promise<StoredMessage[]>;
  searchMessages: (opts?: SearchMessagesOptions) => Promise<StoredMessage[]>;
  /**
   * `conversationId` is the shard key of the messages collection: supplying it
   * keeps the update single-partition on Cosmos. It stays optional so callers
   * that only hold a message id (and the in-memory store) still work.
   */
  markDelivered: (
    messageId: string,
    userId: string,
    conversationId?: string
  ) => Promise<StoredMessage | null>;
  enqueueDeliveryReceipt?: (receipt: DeliveryReceiptInput) => void;
  flushDeliveryReceipts?: () => Promise<void>;
  listConversations: (userId: string) => Promise<ConversationSummary[]>;
  /**
   * `peerId` saves the store a round trip it would otherwise spend looking the
   * peer up in the conversation index; optional for callers that do not know it.
   */
  markRead: (conversationId: string, userId: string, peerId?: string) => Promise<number>;
  deleteMessage: (
    conversationId: string,
    messageId: string,
    userId: string
  ) => Promise<StoredMessage | null>;
  reactToMessage: (opts?: ReactToMessageOptions) => Promise<StoredMessage | null>;
  close?: () => Promise<void>;
  ready?: () => Promise<unknown>;
};
