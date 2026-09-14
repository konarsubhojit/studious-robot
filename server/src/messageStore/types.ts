/**
 * Message-store vocabulary: the domain shapes and the store interface.
 *
 * The interface is the seam that let chat history move from MongoDB to
 * Postgres without any caller changing: `createServer` holds a `MessageStore`,
 * not a driver, and the tests exercise the contract rather than a backend.
 */

export type MessageRecord = import('../stores/contracts.ts').MessageRecord;

export type StoredMessage = MessageRecord & {
  createdAt: string;
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
  /** Tie-breaker used with `before` for stable pagination across timestamp ties. */
  beforeMessageId?: string;
  /** Internal API look-ahead reads may ask for one extra row to compute hasMore. */
  withLookahead?: boolean;
};

export type SearchMessagesOptions = {
  userId?: string;
  query?: unknown;
  limit?: unknown;
  before?: string;
  /** Tie-breaker used with `before` for stable pagination across timestamp ties. */
  beforeMessageId?: string;
  /** Internal API look-ahead reads may ask for one extra row to compute hasMore. */
  withLookahead?: boolean;
};

export type ListUserMessagesOptions = {
  userId?: string;
  limit?: unknown;
  before?: string;
  /** Tie-breaker used with `before` for stable export pagination. */
  beforeMessageId?: string;
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
  /**
   * Required: it becomes the leading key column of the eventual `markDelivered`
   * update, without which that update cannot use the primary key. See the note
   * on `markDelivered` below.
   */
  conversationId: string;
};

export type SaveMessageResult = {
  message: StoredMessage;
  inserted: boolean;
};

export type MessageStore = {
  type: 'memory' | 'postgres';
  saveMessage: (message: NewMessageInput) => Promise<StoredMessage>;
  saveMessageWithStatus?: (message: NewMessageInput) => Promise<SaveMessageResult>;
  listMessages: (opts?: ListMessagesOptions) => Promise<StoredMessage[]>;
  getMessage: (conversationId: string, messageId: string) => Promise<StoredMessage | null>;
  searchMessages: (opts?: SearchMessagesOptions) => Promise<StoredMessage[]>;
  /** Bounded export page containing every participant message, including tombstones. */
  listUserMessages?: (opts?: ListUserMessagesOptions) => Promise<StoredMessage[]>;
  /**
   * `conversationId` is the leading column of the Postgres primary key
   * `(conversation_id, message_id)`: supplying it is what lets the update be an
   * index scan. Omitting it leaves `where message_id = $1`, which no index
   * covers, so the Postgres store logs a warning and scans the whole table.
   * It stays optional only so the in-memory store — which looks up a message by
   * id — keeps the same signature; every real caller must pass it, deriving it
   * with `deriveConversationId` if it only holds the two participants.
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
