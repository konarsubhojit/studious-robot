import { MESSAGE_TYPES } from '../../../shared';
import { byOldestFirst } from './messageIdentity';
import type { AttachmentRecord } from '../../../shared/signaling/schemas';
import type { ChatMessage, OutboxItem } from './types';

/**
 * The send pipeline's pure half: what an optimistic message looks like, what
 * the durable outbox looks like after each step, and how each step is
 * reflected on the message the user can see.
 *
 * The load-bearing property here is that a retry reuses the *original*
 * message identity: none of these transforms mints a new `messageId`, so a
 * late-succeeding original send resolves to the same server row as the retry
 * rather than duplicating it.
 */

/** How many send attempts a queued message gets before it is marked failed
 * and left for the user to retry or delete explicitly. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** First outbox drain retry delay; doubles per attempt up to the cap. */
export const OUTBOX_BASE_RETRY_MS = 1000;
/** Ceiling for the exponential backoff between outbox drains. */
export const OUTBOX_MAX_RETRY_MS = 60_000;

/**
 * True while a queued message may still be sent automatically.
 */
export function isRetryable(item: OutboxItem): boolean {
  return (item?.attempts ?? 0) < OUTBOX_MAX_ATTEMPTS;
}

/**
 * Bounded exponential backoff for the next drain, jittered across the second
 * half of the window so many clients coming back online together do not retry
 * in lockstep.
 *
 * @param attempt how many drains have already been scheduled
 * @param jitter 0..1; injectable so the schedule is testable
 */
export function nextDrainDelayMs(attempt: number, jitter: number = Math.random()): number {
  const ceiling = Math.min(OUTBOX_BASE_RETRY_MS * 2 ** attempt, OUTBOX_MAX_RETRY_MS);
  return ceiling / 2 + jitter * (ceiling / 2);
}

/**
 * The queue a drain should work through: only what may still be sent
 * automatically, oldest first so queued sends keep their composition order.
 */
export function drainOrder(outbox: OutboxItem[]): OutboxItem[] {
  return [...outbox.filter(isRetryable)].sort(byOldestFirst);
}

/** The outbox without a given message — it is delivered, discarded or failed
 * its upload, and must never be replayed. */
export function withoutMessage(outbox: OutboxItem[], messageId: string): OutboxItem[] {
  return outbox.filter(item => item.messageId !== messageId);
}

/** Record a failed attempt against a queued message. */
export function withAttemptRecorded(
  outbox: OutboxItem[],
  messageId: string,
  { attempts, lastError, lastAttemptAt }: {
    attempts: number;
    lastError?: string | null;
    lastAttemptAt: string;
  },
): OutboxItem[] {
  return outbox.map(queued =>
    queued.messageId === messageId
      ? { ...queued, attempts, lastAttemptAt, lastError: lastError ?? null }
      : queued,
  );
}

/** Give a message whose automatic retries were exhausted a fresh budget. */
export function withAttemptsReset(outbox: OutboxItem[], messageId: string): OutboxItem[] {
  return outbox.map(item =>
    item.messageId === messageId ? { ...item, attempts: 0, lastError: null } : item,
  );
}

type OptimisticInput = {
  messageId: string;
  conversationId?: string | null;
  senderId: string;
  recipientId: string;
  createdAt: string;
  body?: string;
  type?: string;
  attachment?: AttachmentRecord | null;
  replyTo?: string | null;
};

/**
 * The entry a send puts into the local history before anything is emitted, so
 * the message is on screen (as `pending`) whether or not the socket is up.
 */
export function buildOptimisticMessage({
  messageId,
  conversationId = null,
  senderId,
  recipientId,
  createdAt,
  body = '',
  type = MESSAGE_TYPES.TEXT,
  attachment = null,
  replyTo = null,
}: OptimisticInput): ChatMessage {
  return {
    messageId,
    conversationId,
    senderId,
    recipientId,
    body,
    type,
    attachment,
    replyTo,
    reactions: {},
    deletedAt: null,
    createdAt,
    deliveredTo: [],
    readAt: null,
    pending: true,
    syncState: 'pending',
  } as ChatMessage;
}

/**
 * The entry an attachment send puts into the local history *before* the blob
 * has been uploaded: the same optimistic message, plus the per-bubble upload
 * state the progress ring and the retry affordance read.
 */
export function buildUploadingMessage(input: OptimisticInput): ChatMessage {
  return {
    ...buildOptimisticMessage(input),
    failed: false,
    uploadState: 'uploading',
    uploadProgress: 0,
    uploadError: null,
  };
}

/**
 * The durable row for a send, written before the emit so a message composed
 * offline — or caught by the app being killed mid-send — is replayed.
 */
export function buildOutboxItem({
  messageId,
  conversationId = null,
  recipientId,
  createdAt,
  body = '',
  type = MESSAGE_TYPES.TEXT,
  attachment = null,
  replyTo = null,
}: Omit<OptimisticInput, 'senderId'>): OutboxItem {
  return {
    messageId,
    conversationId,
    recipientId,
    body,
    type,
    attachment,
    replyTo,
    createdAt,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  };
}

/** The server acknowledged the send: its copy wins, and the bubble stops
 * being pending. */
export function asSent(entry: ChatMessage, confirmed?: ChatMessage | null): ChatMessage {
  return {
    ...entry,
    ...(confirmed ?? {}),
    pending: false,
    failed: false,
    syncState: 'synced',
  };
}

/** Out of automatic retries: the bubble is surfaced as failed so the user can
 * retry or delete it explicitly. */
export function asFailed(entry: ChatMessage): ChatMessage {
  return { ...entry, pending: false, failed: true, syncState: 'failed' };
}

/** Back in the queue, under the same message identity. */
export function asQueued(entry: ChatMessage): ChatMessage {
  return { ...entry, pending: true, failed: false, syncState: 'pending' };
}

/** Upload progress for the bubble's ring, clamped to 0..1 so a bogus
 * content-length cannot drive it out of range. */
export function withUploadProgress(entry: ChatMessage, progress: number): ChatMessage {
  const bounded = Math.max(0, Math.min(1, Number(progress) || 0));
  return { ...entry, uploadState: 'uploading', uploadProgress: bounded };
}

/** The blob is stored: the bubble drops its upload state and becomes an
 * ordinary queued send carrying the uploaded attachment. */
export function asUploaded(entry: ChatMessage, attachment: AttachmentRecord): ChatMessage {
  return {
    ...asQueued(entry),
    attachment,
    uploadState: undefined,
    uploadProgress: undefined,
    uploadError: null,
  };
}

/** The upload was cancelled or failed. The bubble stays, in a failed state:
 * it must never silently vanish. */
export function asUploadFailed(entry: ChatMessage, error: string | null = null): ChatMessage {
  return { ...asFailed(entry), uploadState: 'failed', uploadError: error };
}
