import type { AttachmentRecord, MessageRecord } from '../../../shared/signaling/schemas';

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
  recipientId: string;
  conversationId?: string | null;
  body?: string;
  type?: string;
  attachment?: AttachmentRecord | null;
  replyTo?: string | null;
  createdAt?: string;
  attempts?: number;
  lastAttemptAt?: string | null;
  lastError?: string | null;
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
};

/** Per-peer message history, newest-first within each peer. */
export type MessagesByPeer = Record<string, ChatMessage[]>;
