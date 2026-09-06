import { byNewestFirst, timelineEntryId } from './messageIdentity';
import type { ChatMessage, MessagesByPeer } from './types';

/**
 * Millisecond timestamp of a timeline entry, or `null` when it has none that
 * parses.  An entry whose time is unknown cannot be placed relative to a page's
 * window, so callers treat `null` as "outside it" and keep the entry.
 */
function entryTime(entry: { createdAt?: string; }): number | null {
  const parsed = Date.parse(entry?.createdAt ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Pure transforms over the per-peer message history.
 *
 * Every one of them returns the *same* object when nothing changed, so a React
 * `setState` fed by them bails out of the re-render exactly as the inline
 * updaters they were extracted from did. That identity contract is the whole
 * reason these are functions rather than mutations.
 */

/**
 * Update one message in `peerId`'s history, by id.
 */
export function patchMessage(
  state: MessagesByPeer,
  peerId: string,
  messageId: string,
  update: (message: ChatMessage) => ChatMessage,
): MessagesByPeer {
  const existing = state[peerId];
  if (!existing) return state;
  let changed = false;
  const next = existing.map(entry => {
    if (entry.messageId !== messageId) return entry;
    changed = true;
    return update(entry);
  });
  return changed ? { ...state, [peerId]: next } : state;
}

/**
 * Update a message wherever it lives, without knowing which conversation that
 * is: the `message.deleted` and `message.reaction` fan-outs carry a message id
 * but not the peer it belongs to.
 */
export function patchMessageEverywhere(
  state: MessagesByPeer,
  messageId: string,
  update: (message: ChatMessage) => ChatMessage,
): MessagesByPeer {
  let changed = false;
  const next: MessagesByPeer = {};
  Object.entries(state).forEach(([peerId, messages]) => {
    next[peerId] = messages.map(entry => {
      if (entry.messageId !== messageId) return entry;
      changed = true;
      return update(entry);
    });
  });
  return changed ? next : state;
}

/**
 * Remove one message from `peerId`'s history.
 */
export function removeMessage(
  state: MessagesByPeer,
  peerId: string,
  messageId: string,
): MessagesByPeer {
  const existing = state[peerId];
  if (!existing) return state;
  const next = existing.filter(m => m.messageId !== messageId);
  return next.length === existing.length ? state : { ...state, [peerId]: next };
}

/**
 * Put a message at the head of `peerId`'s history (newest-first ordering).
 */
export function prependMessage(
  state: MessagesByPeer,
  peerId: string,
  message: ChatMessage,
): MessagesByPeer {
  return { ...state, [peerId]: [message, ...(state[peerId] ?? [])] };
}

/**
 * Merge a fetched page of conversation history into what is already held.
 *
 * The server is authoritative, but only over the *window it reported on*.  A
 * page covers `[oldest, newest]` of the entries the server holds; a held entry
 * that falls inside that window and is absent from the page was deleted
 * server-side and is dropped, while one that falls outside it was never in
 * scope and is kept.  Two things depend on that distinction:
 *
 * - A message that arrives over the socket *while the request is in flight* is
 *   newer than anything the page can contain.  Treating the page as a wholesale
 *   replacement dropped it from the conversation even though the conversation
 *   list had already counted it — the screen and its unread badge disagreed
 *   until something else forced a refetch.
 * - Older history already paged in is below the window, so re-opening a
 *   conversation no longer collapses it back to the first page.
 *
 * Entries still awaiting delivery are kept regardless of the window: an
 * optimistic send is not something the server can be authoritative about yet.
 * They are merged by id, never by position, so an optimistic entry the server
 * now knows about is replaced rather than duplicated.
 *
 * A paginated page (with `before`) simply appends older entries, deduping by
 * their own id: a call entry carries a `callId` rather than a `messageId`.
 *
 * @param existing the currently held entries for the peer, newest first
 * @param page the fetched entries, newest first
 */
export function mergeHistoryPage(
  existing: ChatMessage[],
  page: ChatMessage[],
  { before }: { before?: string; } = {},
): ChatMessage[] {
  const held = existing ?? [];
  if (!before) {
    const serverIds = new Set(page.map(timelineEntryId));
    const times = page.map(entryTime).filter(time => time !== null) as number[];
    // An empty page reports on nothing, so its window is empty and every held
    // entry sits outside it.
    const newest = times.length ? Math.max(...times) : null;
    const oldest = times.length ? Math.min(...times) : null;
    const kept = held.filter(entry => {
      if (serverIds.has(timelineEntryId(entry))) return false;
      if (entry.syncState === 'pending' || entry.syncState === 'failed') return true;
      if (newest === null || oldest === null) return true;
      const time = entryTime(entry);
      return time === null || time > newest || time < oldest;
    });
    return kept.length ? [...kept, ...page].sort(byNewestFirst) : page;
  }
  const existingIds = new Set(held.map(timelineEntryId));
  return [...held, ...page.filter(entry => !existingIds.has(timelineEntryId(entry)))];
}
