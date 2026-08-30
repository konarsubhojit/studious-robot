/**
 * How a timeline entry is identified and ordered.
 *
 * Every other messaging module reconciles by these functions rather than by
 * array position, which is what keeps a server copy and its optimistic local
 * copy converging on one entry instead of two.
 */

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
export function byNewestFirst(a: { createdAt?: string; }, b: { createdAt?: string; }): number {
  return Date.parse(b?.createdAt ?? '') - Date.parse(a?.createdAt ?? '');
}

/**
 * Oldest-first ordering, so queued sends are flushed in composition order.
 */
export function byOldestFirst(a: { createdAt?: string; }, b: { createdAt?: string; }): number {
  return Date.parse(a?.createdAt ?? '') - Date.parse(b?.createdAt ?? '');
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
