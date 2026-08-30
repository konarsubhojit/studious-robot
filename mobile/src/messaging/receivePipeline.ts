import { patchMessageEverywhere, prependMessage } from './messageHistory';
import type { ChatMessage, MessagesByPeer } from './types';

/**
 * The receive pipeline's pure half: how each inbound `message.*` event is
 * folded into the held history.
 *
 * These are deliberately identity-preserving — an event that changes nothing
 * (a duplicate delivered over both the socket and a push, a read receipt for
 * messages already marked read) returns the state it was given, so the
 * corresponding `setState` does not re-render the conversation.
 */

/**
 * The tombstone a deleted message becomes: the content is gone, the row stays
 * so a reply quoting it still resolves and renders "Message deleted".
 *
 * @param message - the local copy being replaced.
 * @param serverTombstone - the server's version, when it sent one.
 */
export function tombstoneOf(
  message: ChatMessage,
  serverTombstone?: Partial<ChatMessage>,
): Partial<ChatMessage> {
  return {
    ...(serverTombstone ?? {}),
    body: '',
    attachment: null,
    reactions: {},
    deletedAt: serverTombstone?.deletedAt ?? message?.deletedAt ?? new Date().toISOString(),
  };
}

/**
 * An inbound message from `senderId`. Deduped by id, so a message that arrives
 * over both the socket and a background push converges on one entry.
 */
export function applyIncomingMessage(
  state: MessagesByPeer,
  message: ChatMessage,
): MessagesByPeer {
  const senderId = message.senderId;
  const existing = state[senderId] ?? [];
  if (existing.some(m => m.messageId === message.messageId)) return state;
  return prependMessage(state, senderId, { ...message, syncState: 'synced' });
}

/**
 * A delivery receipt for a message this user sent. When the message is already
 * held (the send ack raced ahead of this event) the server's copy is merged in
 * so `deliveredTo` flips the status tick from "sent" to "delivered"; when it is
 * not, the server's copy is what the history gets.
 */
export function applyDeliveryReceipt(
  state: MessagesByPeer,
  message: ChatMessage,
): MessagesByPeer {
  const peerId = message.recipientId;
  const existing = state[peerId] ?? [];
  const index = existing.findIndex(m => m.messageId === message.messageId);
  if (index === -1) return prependMessage(state, peerId, message);
  const next = [...existing];
  next[index] = { ...next[index], ...message };
  return { ...state, [peerId]: next };
}

/**
 * The peer read this user's messages in their shared conversation.
 *
 * `readerId` is the peer who just read our messages; `messagesByPeer` is keyed
 * by the other participant regardless of send direction, so it doubles as the
 * lookup key here.
 */
export function applyReadReceipt(
  state: MessagesByPeer,
  { readerId, readAt, currentUserId }: {
    readerId: string;
    readAt?: string;
    currentUserId: string;
  },
): MessagesByPeer {
  const existing = state[readerId];
  if (!existing) return state;
  let changed = false;
  const updated = existing.map(m => {
    if (m.senderId === currentUserId && !m.readAt) {
      changed = true;
      return { ...m, readAt: readAt ?? new Date().toISOString() };
    }
    return m;
  });
  return changed ? { ...state, [readerId]: updated } : state;
}

/**
 * A participant deleted a message: replace it with the server's tombstone so
 * both sides converge on "Message deleted" rather than on a hole.
 */
export function applyTombstone(
  state: MessagesByPeer,
  messageId: string,
  serverTombstone?: Partial<ChatMessage>,
): MessagesByPeer {
  return patchMessageEverywhere(state, messageId, entry => ({
    ...entry,
    ...tombstoneOf(entry, serverTombstone),
  }));
}

/**
 * The server's authoritative reaction set for a message, from either
 * participant — including this user on another device, which is what makes the
 * local optimistic update converge.
 */
export function applyReactions(
  state: MessagesByPeer,
  messageId: string,
  reactions: Record<string, string[]>,
): MessagesByPeer {
  return patchMessageEverywhere(state, messageId, entry => ({ ...entry, reactions }));
}
