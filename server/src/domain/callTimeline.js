'use strict';

const { deriveConversationId } = require('../messageStore');
const { invalidateCallHistoryCache, persistCallRecord } = require('../callPersistence');
const { messageTypeOf } = require('../../../shared');

/**
 * Call records seen as part of a conversation's timeline.
 *
 * The chat and the call log are two views of the same relationship, and
 * `deriveConversationId` already maps a participant pair onto a conversation
 * deterministically — so a call between the same two users belongs to their
 * conversation with no extra schema.  This module normalises call records into
 * timeline entries that merge-sort with messages, and owns the read state of
 * the missed calls that feed a conversation's unread count.
 */

/**
 * Normalise a call record into a conversation-timeline entry.
 *
 * `status` is the record's status, except that a call the caller hung up
 * before it was answered (`ended` with `endReason: 'cancelled'`) is reported as
 * `cancelled` — the same distinction the call log draws — so the two views can
 * never disagree.
 *
 * @param {object} call
 * @param {string} userId - The viewer; decides the entry's direction.
 * @returns {{ type: 'call', callId: string, conversationId: string, direction: 'incoming'|'outgoing',
 *   status: string, endReason: string|null, durationSeconds: number|null, createdAt: string }}
 */
function toCallTimelineEntry(call, userId) {
  const status =
    call.status === 'ended' && call.endReason === 'cancelled' ? 'cancelled' : call.status;
  return {
    type: 'call',
    callId: call.callId,
    conversationId: deriveConversationId(call.callerId, call.calleeId),
    direction: call.callerId === userId ? 'outgoing' : 'incoming',
    status,
    endReason: call.endReason ?? null,
    durationSeconds: call.durationSeconds ?? null,
    createdAt: call.createdAt,
  };
}

/**
 * Every call between `userId` and `peerId`, in no particular order.
 *
 * @param {object} state
 * @param {string} userId
 * @param {string} peerId
 * @returns {object[]}
 */
function listCallsBetween(state, userId, peerId) {
  const calls = [];
  for (const call of state.calls.values()) {
    const isPair =
      (call.callerId === userId && call.calleeId === peerId) ||
      (call.callerId === peerId && call.calleeId === userId);
    if (isPair) calls.push(call);
  }
  return calls;
}

/**
 * True when `call` is a missed call addressed to `userId` that they have not
 * acknowledged yet — the call-side contribution to a conversation's unread
 * count.
 *
 * @param {object} call
 * @param {string} userId
 * @returns {boolean}
 */
function isUnreadMissedCall(call, userId) {
  return call.calleeId === userId && call.status === 'missed' && !call.missedReadAt;
}

/**
 * Acknowledge every missed call `userId` has from `peerId`, mirroring
 * `markRead` for messages: opening the conversation clears both.
 *
 * @param {object} state
 * @param {string} userId
 * @param {string} peerId
 * @returns {number} How many calls were marked read.
 */
function markMissedCallsRead(state, userId, peerId) {
  const readAt = new Date().toISOString();
  let updated = 0;
  for (const call of state.calls.values()) {
    if (call.callerId !== peerId || call.calleeId !== userId) continue;
    if (!isUnreadMissedCall(call, userId)) continue;
    call.missedReadAt = readAt;
    persistCallRecord(state.db, call);
    updated += 1;
  }
  if (updated > 0) invalidateCallHistoryCache(state, userId);
  return updated;
}

/**
 * Merge messages and call entries into one newest-first timeline page.
 *
 * Both inputs are already newest-first; ties on `createdAt` are broken by the
 * entry's own id so the order — and therefore a `before` cursor over it — stays
 * deterministic when a message and a call share a millisecond.
 *
 * @param {object[]} messages - Newest-first message records.
 * @param {object[]} callEntries - Newest-first call timeline entries.
 * @param {number} limit
 * @returns {object[]}
 */
function mergeTimeline(messages, callEntries, limit) {
  const entries = [
    // A message keeps its own type (`image`, `voice`, …); only a legacy row
    // that carries none is defaulted, so the discriminator stays truthful.
    ...messages.map((message) => ({ ...message, type: messageTypeOf(message) })),
    ...callEntries,
  ];
  entries.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    const aId = a.messageId ?? a.callId ?? '';
    const bId = b.messageId ?? b.callId ?? '';
    if (aId === bId) return 0;
    return aId < bId ? 1 : -1;
  });
  return entries.slice(0, limit);
}

/**
 * Fold call history into the chat list.
 *
 * Each conversation gains a `lastActivity` — the newer of its last message and
 * its last call — so the preview row reads "Missed call" instead of a stale
 * older message, and its `unreadCount` gains that peer's unacknowledged missed
 * calls, so the Chats tab badge reflects them too.  A peer the user has only
 * ever called (never messaged) becomes a conversation in its own right.
 *
 * @param {object} state
 * @param {string} userId
 * @param {Array<{ conversationId: string, peerId: string, lastMessage: object, unreadCount: number }>} conversations
 * @returns {object[]} Newest-activity first.
 */
function augmentConversationsWithCalls(state, userId, conversations) {
  /** @type {Map<string, { entry: object, unread: number }>} */
  const byPeer = new Map();
  for (const call of state.calls.values()) {
    if (call.callerId !== userId && call.calleeId !== userId) continue;
    const peerId = call.callerId === userId ? call.calleeId : call.callerId;
    const entry = toCallTimelineEntry(call, userId);
    const existing = byPeer.get(peerId);
    if (!existing) {
      byPeer.set(peerId, { entry, unread: isUnreadMissedCall(call, userId) ? 1 : 0 });
    } else {
      if (entry.createdAt > existing.entry.createdAt) existing.entry = entry;
      if (isUnreadMissedCall(call, userId)) existing.unread += 1;
    }
  }

  const merged = conversations.map((conversation) => {
    const calls = byPeer.get(conversation.peerId);
    byPeer.delete(conversation.peerId);
    const lastMessage = conversation.lastMessage
      ? { ...conversation.lastMessage, type: messageTypeOf(conversation.lastMessage) }
      : null;
    const lastActivity =
      calls && (!lastMessage || calls.entry.createdAt > lastMessage.createdAt)
        ? calls.entry
        : lastMessage;
    return {
      ...conversation,
      lastActivity,
      unreadCount: (conversation.unreadCount || 0) + (calls?.unread ?? 0),
    };
  });

  for (const [peerId, calls] of byPeer) {
    merged.push({
      conversationId: deriveConversationId(userId, peerId),
      peerId,
      lastMessage: null,
      lastActivity: calls.entry,
      unreadCount: calls.unread,
    });
  }

  return merged.sort((a, b) => {
    const aAt = a.lastActivity?.createdAt ?? '';
    const bAt = b.lastActivity?.createdAt ?? '';
    if (aAt === bAt) return 0;
    return aAt < bAt ? 1 : -1;
  });
}

module.exports = {
  toCallTimelineEntry,
  augmentConversationsWithCalls,
  listCallsBetween,
  isUnreadMissedCall,
  markMissedCallsRead,
  mergeTimeline,
};
