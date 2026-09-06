import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { calls as callsTable } from '../../db/schema.ts';
import { deriveConversationId, MAX_MESSAGE_LIMIT } from '../messageStore.ts';
import { invalidateCallHistoryCache, persistCallRecord } from '../callPersistence.ts';
import { describeError } from '../lib/errors.ts';
import { callRecordFromRow } from './callHistory.ts';
import { messageTypeOf } from '../../../shared/index.ts';

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
export type ServerState = import('../stores/contracts.ts').ServerState;
export type CallRecord = import('../stores/contracts.ts').CallRecord;

/**
 * Reads below are served from the durable `calls` table, not from the
 * in-memory `state.calls` map, for the same reason `GET /calls` is
 * (`callHistory.ts`): that map is bounded by `CALL_RETENTION_MS` /
 * `MAX_RETAINED_CALLS` and is emptied by a restart.  Reading a conversation's
 * timeline from it meant a call that had aged out still appeared in the call
 * log but had silently vanished from the chat — the exact disagreement
 * `toCallTimelineEntry`'s contract promises cannot happen — and an
 * unacknowledged missed call that evicted could never be marked read, so it
 * came back on the next restart.
 *
 * As in `callHistory.ts`, the in-memory path remains the fallback for
 * deployments with no `DATABASE_URL` (and for tests), and for a failed query:
 * a database outage degrades the timeline to whatever is still resident
 * rather than failing the request.
 */

/**
 * Per-pair call fetch bound.
 *
 * `mergeTimeline` takes the newest `limit` of the two lists combined, which is
 * only correct if each list already holds the newest `limit` of its own kind —
 * otherwise an entry that belongs on the page can be missing from the input.
 * Deriving this from the message page cap keeps that invariant true by
 * construction rather than by coincidence: previously the call side was bounded
 * by whatever happened to survive in memory, which is what made deep paging
 * over a call-heavy conversation skip entries.
 */
const MAX_TIMELINE_CALLS = MAX_MESSAGE_LIMIT;

/**
 * Chat-list scan bound.  The list only ever shows a peer's *newest* activity,
 * so scanning further back cannot change an answer that older rows do not
 * already lose to a newer one.
 */
const MAX_ACTIVITY_CALLS = 500;

/**
 * @returns `value` as a Date for a timestamp comparison, or `null` when it is
 * not a usable instant — in which case the caller must not filter on it rather
 * than filter on `Invalid Date` and match nothing.
 */
function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Normalise a call record into a conversation-timeline entry.
 *
 * `status` is the record's status, except that a call the caller hung up
 * before it was answered (`ended` with `endReason: 'cancelled'`) is reported as
 * `cancelled` — the same distinction the call log draws — so the two views can
 * never disagree.
 *
 * @param userId - The viewer; decides the entry's direction.
 */
function toCallTimelineEntry(call: CallRecord, userId: string): {
    type: 'call'; callId: string; conversationId: string; direction: 'incoming' | 'outgoing';
    status: string; endReason: string | null; durationSeconds: number | null; createdAt: string;
} {
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
 * Every resident call between `userId` and `peerId`, newest first.
 *
 * The in-memory fallback for `readCallsBetween`; see the note above.
 *
 * @param before - Optional ISO cursor; only calls older than it are returned.
 */
function listCallsBetween(
  state: ServerState,
  userId: string,
  peerId: string,
  before?: string | null,
): CallRecord[] {
  const calls: CallRecord[] = [];
  for (const call of state.calls.values()) {
    const isPair =
      (call.callerId === userId && call.calleeId === peerId) ||
      (call.callerId === peerId && call.calleeId === userId);
    if (!isPair) continue;
    if (before && !(call.createdAt < before)) continue;
    calls.push(call);
  }
  return calls.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Every call between `userId` and `peerId`, newest first, from the durable
 * table when there is one.
 *
 * @param before - Optional ISO cursor; only calls older than it are returned.
 */
async function readCallsBetween(
  state: ServerState,
  userId: string,
  peerId: string,
  before?: string | null,
): Promise<CallRecord[]> {
  if (!state.db) return listCallsBetween(state, userId, peerId, before);
  try {
    const pair = or(
      and(eq(callsTable.callerId, userId), eq(callsTable.calleeId, peerId)),
      and(eq(callsTable.callerId, peerId), eq(callsTable.calleeId, userId)),
    );
    const cursor = toDate(before);
    const rows = await state.db
      .select()
      .from(callsTable)
      .where(cursor ? and(pair, lt(callsTable.createdAt, cursor)) : pair)
      .orderBy(desc(callsTable.createdAt), desc(callsTable.callId))
      .limit(MAX_TIMELINE_CALLS);
    return (rows ?? []).map(callRecordFromRow);
  } catch (error) {
    console.error(`[calls] conversation call lookup failed, serving resident calls: ${describeError(error)}`);
    return listCallsBetween(state, userId, peerId, before);
  }
}

/**
 * True when `call` is a missed call addressed to `userId` that they have not
 * acknowledged yet — the call-side contribution to a conversation's unread
 * count.
 */
function isUnreadMissedCall(call: CallRecord, userId: string): boolean {
  return call.calleeId === userId && call.status === 'missed' && !call.missedReadAt;
}

/**
 * Acknowledge every missed call `userId` has from `peerId`, mirroring
 * `markRead` for messages: opening the conversation clears both.
 *
 * @returns How many calls were marked read.
 */
async function markMissedCallsRead(state: ServerState, userId: string, peerId: string): Promise<number> {
  const readAt = new Date().toISOString();

  // Resident calls first, so live state agrees with the table immediately, and
  // so a call missed moments ago whose persist write has not landed yet is
  // still acknowledged durably by the upsert below.
  const acknowledged = new Set<string>();
  for (const call of state.calls.values()) {
    if (call.callerId !== peerId || call.calleeId !== userId) continue;
    if (!isUnreadMissedCall(call, userId)) continue;
    call.missedReadAt = readAt;
    acknowledged.add(call.callId);
    void persistCallRecord(state.db, call);
  }

  if (state.db) {
    try {
      // One statement covers every missed call from this peer, including the
      // ones evicted from `state.calls`, which the loop above cannot see and
      // which therefore used to resurrect unread on the next restart.
      const rows = await state.db
        .update(callsTable)
        .set({ missedReadAt: new Date(readAt), updatedAt: new Date(readAt) })
        .where(
          and(
            eq(callsTable.calleeId, userId),
            eq(callsTable.callerId, peerId),
            eq(callsTable.status, 'missed'),
            isNull(callsTable.missedReadAt),
          ),
        )
        .returning({ callId: callsTable.callId });
      for (const row of rows ?? []) {
        if (typeof row?.callId === 'string') acknowledged.add(row.callId);
      }
    } catch (error) {
      // The resident calls above are already marked and queued for persistence,
      // so the acknowledgement is not lost — only the evicted ones are missed.
      console.error(`[calls] missed-call acknowledgement failed: ${describeError(error)}`);
    }
  }

  const updated = acknowledged.size;
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
 * @param messages - Newest-first message records.
 * @param callEntries - Newest-first call timeline entries.
 */
function mergeTimeline(messages: Array<Record<string, any>>, callEntries: Array<Record<string, any>>, limit: number): Array<Record<string, any>> {
  const entries: Array<Record<string, any>> = [
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
 * @param conversations
 * @returns Newest-activity first.
 */
type CallActivitySummary = {
  entry: ReturnType<typeof toCallTimelineEntry>;
  unread: number;
};

type ConversationSummary = {
  conversationId: string;
  peerId: string;
  lastMessage: Record<string, any> | null;
  unreadCount: number;
};

function isUserCall(call: CallRecord, userId: string) {
  return call.callerId === userId || call.calleeId === userId;
}

function addCallActivity(
  byPeer: Map<string, CallActivitySummary>,
  call: CallRecord,
  userId: string,
) {
  const peerId = call.callerId === userId ? call.calleeId : call.callerId;
  const entry = toCallTimelineEntry(call, userId);
  const existing = byPeer.get(peerId);
  const unread = isUnreadMissedCall(call, userId);
  if (!existing) {
    byPeer.set(peerId, { entry, unread: unread ? 1 : 0 });
    return;
  }
  if (entry.createdAt > existing.entry.createdAt) existing.entry = entry;
  if (unread) existing.unread += 1;
}

function collectCallActivityByPeer(state: ServerState, userId: string): Map<string, CallActivitySummary> {
  const byPeer = new Map<string, CallActivitySummary>();
  for (const call of state.calls.values()) {
    if (isUserCall(call, userId)) addCallActivity(byPeer, call, userId);
  }
  return byPeer;
}

/**
 * The same summary, from the durable table when there is one.
 *
 * Two bounded queries rather than one scan: the newest calls decide each
 * peer's `lastActivity`, while unacknowledged missed calls decide the unread
 * count and may be arbitrarily old — an unread badge that expired with the
 * retention window would be a worse lie than a slightly shallow preview.  The
 * results overlap, so they are folded by `callId` before counting; counting a
 * call twice would double the badge.
 */
async function readCallActivityByPeer(
  state: ServerState,
  userId: string,
): Promise<Map<string, CallActivitySummary>> {
  if (!state.db) return collectCallActivityByPeer(state, userId);
  try {
    const participant = or(eq(callsTable.callerId, userId), eq(callsTable.calleeId, userId));
    const [recent, unread] = await Promise.all([
      state.db
        .select()
        .from(callsTable)
        .where(participant)
        .orderBy(desc(callsTable.createdAt), desc(callsTable.callId))
        .limit(MAX_ACTIVITY_CALLS),
      state.db
        .select()
        .from(callsTable)
        .where(
          and(
            eq(callsTable.calleeId, userId),
            eq(callsTable.status, 'missed'),
            isNull(callsTable.missedReadAt),
          ),
        )
        .limit(MAX_ACTIVITY_CALLS),
    ]);

    const distinct = new Map<string, CallRecord>();
    for (const row of [...(recent ?? []), ...(unread ?? [])]) {
      const call = callRecordFromRow(row);
      if (call.callId && !distinct.has(call.callId)) distinct.set(call.callId, call);
    }

    const byPeer = new Map<string, CallActivitySummary>();
    for (const call of distinct.values()) {
      if (isUserCall(call, userId)) addCallActivity(byPeer, call, userId);
    }
    return byPeer;
  } catch (error) {
    console.error(`[calls] chat-list call activity lookup failed, serving resident calls: ${describeError(error)}`);
    return collectCallActivityByPeer(state, userId);
  }
}

function mergeConversationCallActivity(
  conversation: ConversationSummary,
  calls: CallActivitySummary | undefined,
): Record<string, any> {
  const lastMessage: Record<string, any> | null = conversation.lastMessage
    ? { ...conversation.lastMessage, type: messageTypeOf(conversation.lastMessage) }
    : null;
  return {
    ...conversation,
    lastActivity: latestConversationActivity(calls, lastMessage),
    unreadCount: (conversation.unreadCount || 0) + (calls?.unread ?? 0),
  };
}

function latestConversationActivity(
  calls: CallActivitySummary | undefined,
  lastMessage: Record<string, any> | null,
) {
  if (!calls) return lastMessage;
  if (!lastMessage || calls.entry.createdAt > lastMessage.createdAt) return calls.entry;
  return lastMessage;
}

function appendCallOnlyConversations(
  merged: Array<Record<string, any>>,
  userId: string,
  byPeer: Map<string, CallActivitySummary>,
) {
  for (const [peerId, calls] of byPeer) {
    merged.push({
      conversationId: deriveConversationId(userId, peerId),
      peerId,
      lastMessage: null,
      lastActivity: calls.entry,
      unreadCount: calls.unread,
    });
  }
}

function sortConversationsByActivity(conversations: Array<Record<string, any>>) {
  return conversations.sort((a, b) => {
    const aAt = a.lastActivity?.createdAt ?? '';
    const bAt = b.lastActivity?.createdAt ?? '';
    if (aAt === bAt) return 0;
    return aAt < bAt ? 1 : -1;
  });
}

async function augmentConversationsWithCalls(
  state: ServerState,
  userId: string,
  conversations: ConversationSummary[],
): Promise<Array<Record<string, any>>> {
  const byPeer = await readCallActivityByPeer(state, userId);
  const merged = conversations.map((conversation) => {
    const calls = byPeer.get(conversation.peerId);
    byPeer.delete(conversation.peerId);
    return mergeConversationCallActivity(conversation, calls);
  });
  appendCallOnlyConversations(merged, userId, byPeer);
  return sortConversationsByActivity(merged);
}

export {
  toCallTimelineEntry,
  augmentConversationsWithCalls,
  listCallsBetween,
  readCallsBetween,
  readCallActivityByPeer,
  isUnreadMissedCall,
  markMissedCallsRead,
  mergeTimeline,
};
