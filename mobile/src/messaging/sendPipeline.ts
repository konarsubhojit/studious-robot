import { MESSAGE_TYPES, SIGNALING_VERSION } from '../../../shared';
import { byOldestFirst } from './messageIdentity';
import { prependMessage } from './messageHistory';
import type { AttachmentRecord } from '../../../shared/signaling/schemas';
import type { ChatMessage, MessagesByPeer, OutboxItem } from './types';

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
  clientMessageId?: string;
  conversationId?: string | null;
  senderId: string;
  recipientId: string;
  createdAt: string;
  body?: string;
  type?: string;
  attachment?: AttachmentRecord | null;
  replyTo?: string | null;
  replyToLocalMessageId?: string;
  targetKind?: 'group';
  localMock?: boolean;
};

/**
 * The entry a send puts into the local history before anything is emitted, so
 * the message is on screen (as `pending`) whether or not the socket is up.
 */
export function buildOptimisticMessage({
  messageId,
  clientMessageId,
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
    ...(clientMessageId ? { clientMessageId } : {}),
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
    clientCreatedAt: createdAt,
    pending: true,
    syncState: 'pending',
  };
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
  clientMessageId,
  conversationId = null,
  recipientId,
  createdAt,
  body = '',
  type = MESSAGE_TYPES.TEXT,
  attachment = null,
  replyTo = null,
  replyToLocalMessageId,
  targetKind,
  localMock,
}: Omit<OptimisticInput, 'senderId'>): OutboxItem {
  return {
    messageId,
    ...(clientMessageId ? { clientMessageId } : {}),
    conversationId,
    recipientId,
    body,
    type,
    attachment,
    replyTo,
    ...(replyToLocalMessageId ? { replyToLocalMessageId } : {}),
    createdAt,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    ...(targetKind ? { targetKind, localMock: Boolean(localMock) } : {}),
  };
}

/** Direct rows also carry a cached conversationId; only the explicit kind selects group targeting. */
export function outboxSendPayload(item: OutboxItem) {
  if (item.targetKind === 'group' && !item.conversationId) throw new Error('Missing group conversation');
  return {
    version: SIGNALING_VERSION,
    ...(item.targetKind === 'group'
      ? { conversationId: item.conversationId! }
      : { recipientId: item.recipientId }),
    body: item.body ?? '',
    ...(item.type && item.type !== MESSAGE_TYPES.TEXT ? { type: item.type } : {}),
    ...(item.attachment ? { attachment: item.attachment } : {}),
    ...(item.replyTo ? { replyTo: item.replyTo } : {}),
    ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : { messageId: item.messageId }),
  };
}

/** A queued reply cannot emit until its optimistic parent has a server id. */
export function resolveOutboxReply(item: OutboxItem, messages: ChatMessage[], senderId: string): OutboxItem | null {
  if (!item.replyTo) return item;
  const quoted = messages.find(entry => entry.messageId === item.replyTo) ??
    messages.find(entry => entry.senderId === senderId && entry.clientMessageId === item.replyTo);
  if (!quoted && item.replyToLocalMessageId) return null;
  if (quoted && (quoted.syncState === 'pending' || quoted.syncState === 'failed' || quoted.uploadState)) return null;
  if (quoted?.clientMessageId && quoted.messageId === quoted.clientMessageId && quoted.syncState !== 'synced') return null;
  return quoted && (quoted.messageId !== item.replyTo || item.replyToLocalMessageId)
    ? { ...item, replyTo: quoted.messageId, replyToLocalMessageId: undefined } : item;
}

export function optimisticReplyKey(replyTo: string | null, messages: ChatMessage[], senderId: string): string | undefined {
  const quoted = messages.find(entry => entry.senderId === senderId && entry.messageId === replyTo);
  return quoted && (quoted.syncState === 'pending' || quoted.syncState === 'failed' || quoted.uploadState)
    ? quoted.messageId : undefined;
}

/** Called only for an unresolved reply; unknown legacy server references remain sendable. */
export function unavailableReplyReason(item: OutboxItem, messages: ChatMessage[], outbox: OutboxItem[], senderId: string): string | null {
  const key = item.replyToLocalMessageId ?? item.replyTo;
  const parent = messages.find(entry => entry.senderId === senderId &&
    (entry.messageId === key || entry.clientMessageId === key));
  const queued = outbox.find(entry => entry.recipientId === item.recipientId && entry.messageId === key);
  if (parent?.syncState === 'failed' || parent?.uploadState === 'failed' || (queued && !isRetryable(queued))) {
    return 'The message being replied to failed. Retry that message first.';
  }
  return !parent && !queued ? 'The message being replied to is no longer available.' : null;
}

export function withResolvedReplies(outbox: OutboxItem[], localId: string, serverId?: string): OutboxItem[] {
  if (!serverId) return outbox;
  return outbox.map(item => item.replyTo === localId
    ? { ...item, replyTo: serverId, replyToLocalMessageId: undefined } : item);
}

export type OutboxSendResult = boolean | 'waiting' | 'unavailable';

/** Waiting dependencies pause their conversation, not independent conversations. */
export async function drainQueuedMessages(
  queue: OutboxItem[], send: (item: OutboxItem) => Promise<OutboxSendResult>,
): Promise<boolean> {
  const waitingPeers = new Set<string>();
  let allSent = true;
  for (const item of queue) {
    if (waitingPeers.has(item.recipientId)) continue;
    const result = await send(item);
    if (result === true) continue;
    allSent = false;
    if (result === 'waiting') waitingPeers.add(item.recipientId);
    if (result === false) break;
  }
  return allSent;
}

/** The outbox is authoritative even if the UI mirror was interrupted by process death. */
export function restoreOutboxMessages(messages: MessagesByPeer, outbox: OutboxItem[], senderId: string): MessagesByPeer {
  let restored = messages;
  for (const item of outbox) {
    if (restored[item.recipientId]?.some(entry => entry.messageId === item.messageId ||
      (item.clientMessageId && entry.senderId === senderId && entry.clientMessageId === item.clientMessageId))) continue;
    const message = buildOptimisticMessage({
      ...item, senderId, createdAt: item.createdAt ?? new Date(0).toISOString(),
    });
    restored = prependMessage(restored, item.recipientId, isRetryable(item) ? message : asFailed(message));
  }
  return restored;
}

/** The server acknowledged the send: its copy wins, and the bubble stops
 * being pending. */
export function asSent(entry: ChatMessage, confirmed?: ChatMessage | null): ChatMessage {
  const clientCreatedAt = entry.clientCreatedAt ?? validTimestamp(entry.createdAt);
  return {
    ...entry,
    ...(confirmed ?? {}),
    deliveredTo: [...new Set([...(entry.deliveredTo ?? []), ...(confirmed?.deliveredTo ?? [])])],
    readAt: confirmed?.readAt ?? entry.readAt ?? null,
    ...(entry.deletedAt ? { deletedAt: entry.deletedAt, body: '', attachment: null, reactions: {} } : {}),
    ...(clientCreatedAt ? { clientCreatedAt } : {}),
    pending: false,
    failed: false,
    syncState: 'synced',
  };
}

function validTimestamp(value: string | null | undefined): string | undefined {
  return Number.isFinite(Date.parse(value ?? '')) ? value ?? undefined : undefined;
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
