/**
 * Query construction: conversation identity, pagination bounds, search-term
 * handling, and the Mongo filters/sorts the store issues.
 *
 * Building the filters here rather than inline in the store means the shape of
 * a query — including the escaping that keeps a user-supplied search term from
 * being interpreted as a pattern — is assertable without a database.
 */

import type { MongoFilter, MongoSortSpec } from './types.ts';

/** Default page size for `listMessages`. */
export const DEFAULT_MESSAGE_LIMIT = 50;
/** Maximum page size for `listMessages`. */
export const MAX_MESSAGE_LIMIT = 100;

/**
 * Sort applied by `listMessages`: newest first, with `messageId` breaking ties.
 *
 * Prefixed with the shard key and matching a composite index exactly, because
 * Cosmos DB for MongoDB (RU) will not serve a sort that no index covers.
 */
export const LIST_MESSAGES_SORT: MongoSortSpec = {
  conversationId: 1,
  createdAt: -1,
  messageId: -1,
};

/**
 * Derive a deterministic conversation id from the two participant ids.
 *
 * The ids are sorted before joining so both participants — and both directions
 * of a send — always resolve to the same conversation.
 */
export function deriveConversationId(userA: string, userB: string): string {
  return [String(userA), String(userB)].sort().join(':');
}

/**
 * Clamp a requested page size into the supported range.
 */
export function clampLimit(limit: unknown): number {
  const requested = Number(limit);
  if (!Number.isFinite(requested)) return DEFAULT_MESSAGE_LIMIT;
  return Math.min(Math.max(Math.floor(requested), 1), MAX_MESSAGE_LIMIT);
}

/**
 * Escape every regular-expression metacharacter in `value`, so a user-supplied
 * search term is only ever matched literally.  Without this a term such as
 * `.*` would match every message, and a pathological one could make the
 * database evaluate a catastrophically backtracking pattern.
 */
export function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalise a search term: trimmed, and empty when there is nothing to match.
 */
export function normaliseSearchTerm(query: unknown): string {
  return String(query ?? '').trim();
}

/**
 * Whether `message.body` contains `term`, case-insensitively.
 */
export function bodyMatches(message: { body?: string; }, term: string): boolean {
  return String(message?.body ?? '')
    .toLowerCase()
    .includes(term.toLowerCase());
}

/**
 * Filter for one conversation's page of messages, optionally before a cursor.
 */
export function buildListMessagesFilter(
  conversationId: string | undefined,
  before?: string
): MongoFilter {
  const query: MongoFilter = { conversationId };
  if (before) {
    query.createdAt = { $lt: before };
  }
  return query;
}

/**
 * Filter for a user's message search.
 *
 * The body match is a literal, case-insensitive substring match: the term is
 * escaped so a user cannot inject a pattern, and no `$text` is used because
 * Cosmos RU does not implement it.
 */
export function buildSearchMessagesFilter(
  userId: string,
  term: string,
  before?: string
): MongoFilter {
  const filter: MongoFilter = {
    $or: [{ senderId: userId }, { recipientId: userId }],
    body: { $regex: escapeRegExp(term), $options: 'i' },
  };
  if (before) {
    filter.createdAt = { $lt: before };
  }
  return filter;
}

/**
 * Filter selecting every message a user takes part in, in either direction.
 */
export function buildParticipantFilter(userId: string): MongoFilter {
  return { $or: [{ senderId: userId }, { recipientId: userId }] };
}
