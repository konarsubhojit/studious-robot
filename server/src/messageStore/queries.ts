/**
 * Query vocabulary shared by every backend: conversation identity, pagination
 * bounds and search-term handling.
 *
 * Keeping these here rather than inline in a store means the rules that define
 * what a query *means* — how a conversation id is derived, what a page size
 * clamps to, whether a search term matches — are asserted once and cannot drift
 * between the Postgres store and the in-memory one.
 */


/** Default page size for `listMessages`. */
export const DEFAULT_MESSAGE_LIMIT = 50;
/** Maximum page size for `listMessages`. */
export const MAX_MESSAGE_LIMIT = 100;
/** Maximum number of conversations returned by one conversation-list request. */
export const MAX_CONVERSATION_LIMIT = 100;

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
