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
 * The `[oldest, newest]` span a page covers, or `null` for a page that covers
 * nothing — one that is empty, or whose entries all carry unusable timestamps.
 *
 * Folded in one pass rather than via `Math.min`/`Math.max` over a spread array:
 * the page comes off the wire, and spreading an unbounded array into a call
 * overflows the stack.
 */
function pageWindow(page: ChatMessage[]): { oldest: number; newest: number; } | null {
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const entry of page) {
    const time = entryTime(entry);
    if (time === null) continue;
    if (oldest === null || time < oldest) oldest = time;
    if (newest === null || time > newest) newest = time;
  }
  return oldest === null || newest === null ? null : { oldest, newest };
}

/**
 * Timestamp for a freshly composed local entry.
 *
 * If the device clock is behind the newest loaded timeline entry, a plain
 * `new Date()` would sort the optimistic bubble above newer calls/messages.
 * Clamp the local timestamp just after the newest known entry (and after the
 * previous locally minted timestamp) so composition order remains chronological.
 */
export function nextLocalCreatedAt(
  existing: ChatMessage[] = [],
  nowMs: number = Date.now(),
  previousLocalMs: number = 0,
): string {
  let floor = Number.isFinite(previousLocalMs) ? previousLocalMs : 0;
  for (const entry of existing) {
    const time = entryTime(entry);
    if (time !== null && time > floor) floor = time;
  }
  const next = Number.isFinite(nowMs) && nowMs > floor ? nowMs : floor + 1;
  return new Date(next).toISOString();
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
  return changed ? { ...state, [peerId]: dedupeAndSort(next) } : state;
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
    const updated = messages.map(entry => {
      if (entry.messageId !== messageId) return entry;
      changed = true;
      return update(entry);
    });
    next[peerId] = changed ? dedupeAndSort(updated) : updated;
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
  return { ...state, [peerId]: dedupeAndSort([message, ...(state[peerId] ?? [])]) };
}

/**
 * Insert or replace one timeline entry in `peerId`'s newest-first history.
 *
 * Live calls use the same reconciliation rule as optimistic messages: the
 * provisional local entry and the server entry share the call's `callId`, so
 * whichever copy arrives later replaces the earlier one instead of duplicating
 * it in the chat.
 */
export function upsertTimelineEntry(
  state: MessagesByPeer,
  peerId: string,
  entry: ChatMessage,
): MessagesByPeer {
  const entryId = timelineEntryId(entry);
  if (!entryId) return state;
  const existing = state[peerId] ?? [];
  const next = dedupeAndSort([entry, ...existing.filter(item => timelineEntryId(item) !== entryId)]);
  return { ...state, [peerId]: next };
}

export function dedupeAndSort(entries: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  const unidentified: ChatMessage[] = [];
  for (const entry of entries) {
    const id = timelineEntryId(entry);
    if (!id) {
      unidentified.push(entry);
      continue;
    }
    byId.set(id, byId.has(id) ? { ...(byId.get(id) ?? {}), ...entry } : entry);
  }
  return [...byId.values(), ...unidentified].sort(byNewestFirst);
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
  const pageWithClientTimes = carryLocalCreatedAt(held, page);
  if (!before) {
    const serverIds = new Set(pageWithClientTimes.map(timelineEntryId));
    const window = pageWindow(pageWithClientTimes);
    const kept = held.filter(entry => {
      if (serverIds.has(timelineEntryId(entry))) return false;
      if (entry.syncState === 'pending' || entry.syncState === 'failed') return true;
      // A page that reports on nothing cannot contradict anything held.
      if (!window) return true;
      const time = entryTime(entry);
      return time === null || time > window.newest || time < window.oldest;
    });
    return dedupeAndSort(kept.length ? [...kept, ...pageWithClientTimes] : pageWithClientTimes);
  }
  const existingIds = new Set(held.map(timelineEntryId));
  return dedupeAndSort([...held, ...pageWithClientTimes.filter(entry => !existingIds.has(timelineEntryId(entry)))]);
}

function carryLocalCreatedAt(existing: ChatMessage[], page: ChatMessage[]): ChatMessage[] {
  const clientCreatedAtById = new Map<string, string>();
  for (const entry of existing) {
    const id = timelineEntryId(entry);
    if (!id || !entry.clientCreatedAt) continue;
    clientCreatedAtById.set(id, entry.clientCreatedAt);
  }
  if (!clientCreatedAtById.size) return page;
  return page.map(entry => {
    const id = timelineEntryId(entry);
    const clientCreatedAt = id ? clientCreatedAtById.get(id) : undefined;
    return clientCreatedAt ? { ...entry, clientCreatedAt } : entry;
  });
}
