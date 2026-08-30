/**
 * Pure message-record logic: identity, timestamps, and the three in-place
 * transformations a stored message can undergo.
 *
 * None of this touches a database, which is the point — a tombstone that keeps
 * a reaction, or a reaction that toggles instead of converging, is a bug that
 * should be catchable without a store at all.
 */

import { randomUUID } from 'crypto';
import { DEFAULT_MESSAGE_TYPE, isSupportedMessageType } from '../../../shared/index.ts';
import { deriveConversationId } from './queries.ts';
import type { NewMessageInput, StoredMessage } from './types.ts';

/**
 * Monotonic ISO timestamp generator.
 *
 * `createdAt` doubles as the sort key *and* the pagination cursor, so two
 * messages sent within the same millisecond would otherwise tie: the newest-first
 * ordering becomes arbitrary and a `before` cursor can silently skip or repeat
 * the tied messages.  Forcing each generated timestamp to be strictly greater
 * than the previous one keeps ordering and pagination exact.
 */
let _lastGeneratedAtMs = 0;

/**
 * @returns An ISO timestamp strictly later than the previous one.
 */
export function nextTimestamp(): string {
  const now = Date.now();
  _lastGeneratedAtMs = now > _lastGeneratedAtMs ? now : _lastGeneratedAtMs + 1;
  return new Date(_lastGeneratedAtMs).toISOString();
}

/**
 * Normalise a reactions map: emoji → unique reacting userIds, dropping
 * anything that is not a non-empty array of ids.
 */
export function normaliseReactions(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const reactions: Record<string, string[]> = {};
  for (const [emoji, userIds] of Object.entries(value)) {
    if (!Array.isArray(userIds)) continue;
    const unique = [...new Set(userIds.filter((userId) => typeof userId === 'string' && userId))];
    if (unique.length) reactions[emoji] = unique;
  }
  return reactions;
}

/**
 * Build a complete message document, filling in server-owned fields.
 *
 * The rich fields are always materialised (rather than omitted when unused) so
 * every newly written row has one shape; readers still default a *legacy* row
 * with no `type` to `"text"`.
 *
 *   message
 */
export function createMessageRecord(message: NewMessageInput): StoredMessage {
  return {
    messageId: message.messageId || randomUUID(),
    conversationId:
      message.conversationId || deriveConversationId(message.senderId, message.recipientId),
    senderId: message.senderId,
    recipientId: message.recipientId,
    body: message.body,
    // An unknown type is never persisted: the store owns what it can describe,
    // and a client sending one is rejected long before this point.
    type: isSupportedMessageType(message.type)
      ? (message.type as string)
      : DEFAULT_MESSAGE_TYPE,
    attachment: message.attachment ?? null,
    replyTo: message.replyTo ?? null,
    reactions: normaliseReactions(message.reactions),
    deletedAt: message.deletedAt ?? null,
    createdAt: message.createdAt || nextTimestamp(),
    deliveredTo: Array.isArray(message.deliveredTo) ? [...message.deliveredTo] : [],
    readAt: message.readAt ?? null,
  };
}

/**
 * Redact a message in place, leaving a tombstone: the content is gone for both
 * participants, but the row survives so a reply that quotes it still resolves
 * (and renders "Message deleted" instead of a dangling reference).
 *
 * @returns the same object, mutated.
 */
export function applyTombstone(message: StoredMessage, deletedAt: string): StoredMessage {
  message.body = '';
  message.attachment = null;
  message.reactions = {};
  message.deletedAt = deletedAt;
  return message;
}

/**
 * Apply one reaction change to a reactions map, returning a new map.
 *
 * Idempotent in both directions: adding a reaction a user already left, or
 * removing one they never left, leaves the map unchanged — so a retried
 * `message.react` converges rather than toggling.
 */
export function applyReaction(
  reactions: Record<string, string[]>,
  emoji: string,
  userId: string,
  action: 'add' | 'remove'
): Record<string, string[]> {
  const next = { ...normaliseReactions(reactions) };
  const current = next[emoji] ?? [];
  if (action === 'add') {
    if (!current.includes(userId)) next[emoji] = [...current, userId];
    return next;
  }
  const remaining = current.filter((candidate) => candidate !== userId);
  if (remaining.length) next[emoji] = remaining;
  else delete next[emoji];
  return next;
}

/**
 * Resolve the "other" participant of a message relative to `userId`.
 *
 * @returns `senderId` when `userId` is the recipient, otherwise `recipientId`.
 */
export function peerIdOf(message: StoredMessage, userId: string): string {
  return message.senderId === userId ? message.recipientId : message.senderId;
}

/**
 * Newest-first comparator.  `messageId` breaks ties so the ordering stays
 * deterministic even for caller-supplied timestamps.
 */
export function byNewestFirst(a: StoredMessage, b: StoredMessage): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  if (a.messageId === b.messageId) return 0;
  return a.messageId < b.messageId ? 1 : -1;
}
