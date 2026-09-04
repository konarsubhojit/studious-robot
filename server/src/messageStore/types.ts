/**
 * Message-store vocabulary: the domain shapes, the store interface, and the
 * *typed* view of the MongoDB surface the store actually uses.
 *
 * The Mongo types here are deliberately structural and minimal rather than the
 * driver's own generics. Before they existed the collection was typed `any`,
 * which made a whole class of error — a misspelled operator, a filter field
 * that does not exist, a result property that is never populated — invisible to
 * the type checker. A narrow structural type restores that checking while still
 * accepting both the real driver's `Collection` and the in-test fake, neither
 * of which is a nominal subtype of the other.
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

/** A stored message as it comes back from the driver, `_id` and all. */
export type MessageDocument = StoredMessage & { _id?: unknown; };

export type ConversationIndexDocument = ConversationSummary & {
  _id?: unknown;
  userId: string;
  updatedAt: string;
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

export type MessageStore = {
  type: 'memory' | 'mongo';
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

// ─── The MongoDB surface this store uses ──────────────────────────────────────

/** A query filter: field name → value or operator expression. */
export type MongoFilter = Record<string, unknown>;

/** An update document, e.g. `{ $set: … }` / `{ $addToSet: … }`. */
export type MongoUpdate = Record<string, unknown>;

/** An index key spec: field name → sort direction. */
export type MongoIndexSpec = Record<string, 1 | -1>;

/** A sort spec: field name → sort direction. */
export type MongoSortSpec = Record<string, 1 | -1>;

/** The counters this store reads off a write result. */
export type MongoWriteResult = {
  upsertedCount?: number;
  modifiedCount?: number;
};

/**
 * `findOneAndUpdate` returns the document directly on driver v6+, and wrapped
 * in `{ value }` on older drivers and on some Cosmos DB responses; both shapes
 * are handled at the call site.
 */
export type MongoFindOneAndUpdateResult =
  | MessageDocument
  | { value?: MessageDocument | null; }
  | null;

/** The cursor methods the store chains onto `find()`. */
export type MongoFindCursor<T = MessageDocument> = {
  sort: (spec: MongoSortSpec) => MongoFindCursor<T>;
  limit: (count: number) => MongoFindCursor<T>;
  toArray: () => Promise<T[]>;
};

/** A Mongo collection, restricted to the operations this store issues. */
export type MongoCollection<T = MessageDocument> = {
  createIndex: (spec: MongoIndexSpec, options?: object) => Promise<unknown>;
  find: (filter: MongoFilter, options?: object) => MongoFindCursor<T>;
  findOne: (filter: MongoFilter) => Promise<T | null>;
  findOneAndUpdate: (
    filter: MongoFilter,
    update: MongoUpdate,
    options?: object
  ) => Promise<MongoFindOneAndUpdateResult>;
  updateOne: (
    filter: MongoFilter,
    update: MongoUpdate,
    options?: object
  ) => Promise<MongoWriteResult>;
  updateMany: (filter: MongoFilter, update: MongoUpdate) => Promise<MongoWriteResult>;
};

export type MessagesCollection = MongoCollection<MessageDocument>;
export type ConversationIndexCollection = MongoCollection<ConversationIndexDocument>;

/**
 * The client surface the store needs: connect, reach a collection, close.
 *
 * The collection is returned as `unknown` deliberately. A client is *injected*
 * — it is either the driver's own `MongoClient` (whose `Collection<Document>`
 * is a generic superset of {@link MessagesCollection}, related to it only
 * structurally) or a test double that implements the subset the case exercises.
 * Neither can be checked against the narrow type at the injection point, so the
 * collection is asserted once, in `createMongoConnector`, and every store call
 * site is then checked against {@link MessagesCollection}.
 *
 * `options`/`s.options` are the driver's (undocumented, hence optional) view of
 * the resolved hosts, read only for a credential-free startup log.
 */
export type MongoClientLike = {
  connect?: () => Promise<unknown>;
  db: (name: string) => { collection: (name: string) => unknown; };
  close: () => Promise<unknown>;
  on?: (event: string, listener: (event: unknown) => void) => unknown;
  options?: { hosts?: unknown; };
  s?: { options?: { hosts?: unknown; }; };
};

/** A live connection: the client, and the collection it resolved to. */
export type MongoConnection = {
  mongoClient: MongoClientLike;
  messages: MessagesCollection;
  conversationIndex: ConversationIndexCollection | null;
};
