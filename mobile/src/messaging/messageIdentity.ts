/**
 * How a timeline entry is identified and ordered.
 *
 * Every other messaging module reconciles by these functions rather than by
 * array position, which is what keeps a server copy and its optimistic local
 * copy converging on one entry instead of two.
 */

import { timestampMs } from '../../../shared/time';

/**
 * Identity of a timeline entry: a message id, or a call id for the call
 * records the unified timeline interleaves with the messages.
 */
export function timelineEntryId(entry: { messageId?: string; callId?: string; }): string | undefined {
  return entry?.messageId ?? entry?.callId;
}

/**
 * Newest-first ordering, matching the server's message ordering.
 */
export function byNewestFirst(
  a: TimelineSortKey,
  b: TimelineSortKey,
): number {
  const aTime = timelineSortTime(a);
  const bTime = timelineSortTime(b);
  const aKnown = Number.isFinite(aTime);
  const bKnown = Number.isFinite(bTime);
  if (aKnown && bKnown && aTime !== bTime) return bTime - aTime;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  const aId = timelineSortId(a);
  const bId = timelineSortId(b);
  if (aId === bId) return 0;
  return aId < bId ? 1 : -1;
}

/** What ordering needs off a timeline entry, message or call. */
type TimelineSortKey = {
  createdAt?: string;
  clientCreatedAt?: string;
  syncState?: string;
  messageId?: string;
  callId?: string;
};

function timelineSortId(entry: { messageId?: string; callId?: string; }): string {
  return entry?.callId ? `call:${entry.callId}` : `message:${entry?.messageId ?? ''}`;
}

function parsedTimestamp(value: string | undefined): number {
  const parsed = timestampMs(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * The instant an entry sorts by.
 *
 * While a send is still `pending` or `failed` it has no server timestamp worth
 * having — `createdAt` is the same locally minted value as `clientCreatedAt` —
 * so the local one is used, and `nextLocalCreatedAt` has already clamped it
 * above the newest known entry so the optimistic bubble appears at the bottom.
 *
 * Once the server has acknowledged it, the server's timestamp wins.  Both
 * participants order the conversation by the same clock that way; taking the
 * later of the two instead meant a device running fast pinned its own messages
 * below everything the server considered newer, and never recovered, because
 * `clientCreatedAt` is deliberately kept across acknowledgement.  It stays as
 * the fallback for an acknowledged entry whose server timestamp is unusable,
 * which is the only case where it is still the better answer.
 */
function timelineSortTime(entry: TimelineSortKey): number {
  const clientCreatedAt = parsedTimestamp(entry?.clientCreatedAt);
  const awaitingServer = entry?.syncState === 'pending' || entry?.syncState === 'failed';
  if (awaitingServer && Number.isFinite(clientCreatedAt)) return clientCreatedAt;
  const createdAt = parsedTimestamp(entry?.createdAt);
  return Number.isFinite(createdAt) ? createdAt : clientCreatedAt;
}

/**
 * Oldest-first ordering, so queued sends are flushed in composition order.
 */
export function byOldestFirst(a: { createdAt?: string; }, b: { createdAt?: string; }): number {
  return timestampMs(a?.createdAt) - timestampMs(b?.createdAt);
}

/**
 * Client-generated message id. The server upserts on
 * `{ conversationId, messageId }`, so this is what makes a replayed send
 * idempotent rather than a duplicate.
 *
 * Not a security token — it only has to be unique — so a `Math.random()`
 * fallback is fine where the runtime has no `crypto.randomUUID`.
 */
export function createMessageId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  const randomHex = (length: number) =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const variant = '89ab'[Math.floor(Math.random() * 4)];
  return (
    `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-` +
    `${variant}${randomHex(3)}-${randomHex(12)}`
  );
}
