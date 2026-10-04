import type { AttachmentRecord, ConversationRecord, MessageRecord } from '../../../shared/signaling/schemas';

/**
 * The vocabulary the messaging client is written in: the shapes every
 * messaging module (and `useMessaging` itself) agrees on.
 *
 * They live here rather than in the hook so a pure module can be imported —
 * and unit-tested — without pulling in React, `react-native` or the socket
 * layer. `useMessaging` re-exports all of them, so existing consumers keep
 * importing them from where they always did.
 */

/**
 * A chat message as persisted by the server, plus the client-only fields an
 * optimistic send carries until the server acknowledges it.
 */
export type ChatMessage = Omit<MessageRecord, 'conversationId'> & {
  conversationId?: string | null;
  status?: string;
  peerId?: string;
  localId?: string;
  clientCreatedAt?: string;
  pending?: boolean;
  failed?: boolean;
  syncState?: 'pending' | 'synced' | 'failed';
  uploadState?: 'uploading' | 'failed';
  uploadProgress?: number;
  uploadError?: string | null;
  deliveredTo?: string[];
  readAt?: string | null;
};

/**
 * A message queued for (re)delivery, with the bookkeeping the outbox drain
 * needs: which peer it belongs to, how many sends have been attempted and why
 * the last one failed.
 */
export type OutboxItem = {
  messageId: string;
  clientMessageId?: string;
  recipientId: string;
  conversationId?: string | null;
  /** recipientId remains the local timeline key; it is never emitted for groups. */
  targetKind?: 'group';
  localMock?: boolean;
  body?: string;
  type?: string;
  attachment?: AttachmentRecord | null;
  replyTo?: string | null;
  /** Local-only dependency marker, cleared once replyTo is a persisted id. */
  replyToLocalMessageId?: string;
  createdAt?: string;
  attempts?: number;
  lastAttemptAt?: string | null;
  lastError?: string | null;
  /** Legacy rows without a state remain pending until their attempt budget is exhausted. */
  state?: 'pending' | 'failed';
  /** Persisted wall-clock deadline in milliseconds; null means ready immediately. */
  nextAttemptAt?: number | null;
  /** Local-only upload checkpoint. Signed URLs/credentials never belong here. */
  upload?: {
    uri: string;
    key?: string;
    uploadId?: string;
    partSize?: number;
    parts: { partNumber: number; etag: string; sizeBytes: number }[];
    progress: number;
    completed?: boolean;
  };
  /** Durable cleanup tombstone; hidden from the timeline and never sent. */
  discarded?: boolean;
  /** Final sweep after any pre-discard single-PUT grant and request can expire. */
  cleanupAfter?: number;
};

export type TimelineCursor = {
  before: string;
  beforeType?: 'message' | 'call';
  beforeMessageId?: string;
  beforeCallId?: string;
};
/**
 * Local socket watermark for one conversation. This is not the server's
 * account-global `/messages/sync` cursor, which is an opaque change-log token.
 */
export type SocketMessageCursor = {
  messageCreatedAt: string;
  messageId: string;
};

/**
 * Newest event of a conversation: either a message or a call, as merged by the
 * server (`lastActivity`).
 */
export type CallActivity = {
  type: 'call';
  callId: string;
  conversationId?: string;
  direction: 'incoming' | 'outgoing';
  status: string;
  endReason?: string | null;
  durationSeconds?: number | null;
  createdAt: string;
};

export type ConversationActivity = ChatMessage | CallActivity;

/**
 * One row of the chat list: the peer, the newest message and whether anything
 * in it is still unread.
 */
export type ConversationSummary = {
  conversationId?: string;
  peerId: string;
  lastMessage?: ChatMessage | null;
  lastActivity?: ConversationActivity | null;
  unreadCount?: number;
  group?: ConversationRecord;
  localMock?: boolean;
  left?: boolean;
  readByMember?: Record<string, string>;
};

/** Per-peer message history, newest-first within each peer. */
export type MessagesByPeer = Record<string, ChatMessage[]>;
