import { byNewestFirst, timelineEntryId } from './messageIdentity';
import type { ChatMessage, MessagesByPeer } from './types';

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
 * The first page (no `before` cursor) treats the server as authoritative for
 * everything it knows about, but entries it has never seen — sends still
 * queued in the outbox — are kept and merged by id, never by position, so an
 * optimistic entry is replaced rather than duplicated.
 *
 * A paginated page (with `before`) appends older entries, deduping by their
 * own id: a call entry carries a `callId` rather than a `messageId`.
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
    const unsent = held.filter(
      entry =>
        (entry.syncState === 'pending' || entry.syncState === 'failed') &&
        !serverIds.has(timelineEntryId(entry)),
    );
    return unsent.length ? [...unsent, ...page].sort(byNewestFirst) : page;
  }
  const existingIds = new Set(held.map(timelineEntryId));
  return [...held, ...page.filter(entry => !existingIds.has(timelineEntryId(entry)))];
}
