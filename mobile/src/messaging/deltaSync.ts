import { API_ROUTES } from '../../../shared';
import { bearerAuthHeaders } from '../authHeaders';
import { flushChatDb, saveChatSnapshot } from '../storage/chatDb';
import { readResource, writeResource } from '../storage/resourceCache';
import { dedupeAndSort } from './messageHistory';
import { tombstoneOf } from './receivePipeline';
import type { ChatMessage, MessagesByPeer } from './types';

/**
 * Per-conversation delta sync (`GET /messages/delta`): after a reconnect or a
 * return to the foreground, ask the server for exactly what changed in one
 * conversation since this device last looked, and reconcile the local SQLite
 * copy with it.
 *
 * Merge rules — the contract between the server's change log and the local
 * timeline:
 *
 * 1. **Server wins on content.** A message the delta reports replaces the
 *    local copy's server-owned fields (body, attachment, reactions, receipts,
 *    `deletedAt`, timestamps). Only client-only bookkeeping such as
 *    `clientCreatedAt` survives from the local copy.
 * 2. **Local-only outbox rows are preserved.** The delta is a list of changes,
 *    not a window of history, so a local row it does not mention is never
 *    dropped — a pending or failed send stays exactly as it was. A delta row
 *    that *is* the server copy of a pending send (same sender and
 *    `clientMessageId`) is merged onto that row by identity, so the
 *    conversation shows one message, not two; the outbox entry itself is left
 *    for the drain, whose resend the server de-duplicates.
 * 3. **Tombstoned messages are removed locally.** A message whose server copy
 *    carries `deletedAt` has its content (body, attachment, reactions) purged
 *    from the local copy and its cached attachment evicted, leaving the same
 *    "message deleted" tombstone the live `message.deleted` event produces —
 *    so the result is identical whichever path delivered the deletion.
 *
 * The cursor is the server's opaque position, persisted per conversation in
 * the local database and only advanced *after* the page it covers has been
 * flushed, so a crash can replay a page (merging is idempotent) but never
 * skip one. It is keyed by peer id, which identifies a direct conversation.
 */

const DELTA_PAGE_LIMIT = 100;
/** Bound one sync run; the persisted cursor lets the next run continue. */
const MAX_DELTA_PAGES = 20;

export type DeltaChange = {
  changeId?: string;
  type?: string;
  changedAt?: string;
  message?: ChatMessage;
};

export type DeltaSyncOptions = {
  scope: string;
  userId: string;
  peerId: string;
  signalingUrl: string;
  authedFetch: Function | null;
  isCurrentScope: () => boolean;
  getMessages: () => MessagesByPeer;
  setMessages: (messages: MessagesByPeer) => void;
  onDeleted: (messageId: string) => void;
};

export function deltaCursorKey(peerId: string): string {
  return `messages:delta:${peerId}`;
}

/**
 * Apply one delta page to a peer's newest-first timeline under the merge
 * rules above. Returns the same array when nothing applied.
 */
export function mergeDeltaChanges(
  existing: ChatMessage[],
  changes: DeltaChange[],
  { userId, peerId }: { userId: string; peerId: string; },
): { messages: ChatMessage[]; applied: number; tombstoned: string[]; } {
  const serverCopies: ChatMessage[] = [];
  const tombstoned: string[] = [];
  for (const change of changes) {
    const message = change?.message;
    if (!message?.messageId) continue;
    const inConversation =
      (message.senderId === userId && message.recipientId === peerId) ||
      (message.senderId === peerId && message.recipientId === userId);
    if (!inConversation) continue;
    if (message.deletedAt) {
      serverCopies.push({ ...message, ...tombstoneOf(message, message) });
      tombstoned.push(message.messageId);
    } else {
      serverCopies.push(message);
    }
  }
  if (!serverCopies.length) return { messages: existing, applied: 0, tombstoned };
  // Server copies go last so `dedupeAndSort` lays them over the local copy.
  return {
    messages: dedupeAndSort([...existing, ...serverCopies]),
    applied: serverCopies.length,
    tombstoned,
  };
}

async function fetchDeltaPage(
  { signalingUrl, authedFetch, peerId }: Pick<DeltaSyncOptions, 'signalingUrl' | 'authedFetch' | 'peerId'>,
  cursor: string | null,
) {
  const params = new URLSearchParams({ peerId, limit: String(DELTA_PAGE_LIMIT) });
  if (cursor) params.set('cursor', cursor);
  const response = await authedFetch?.((sid: string) => ({
    url: `${signalingUrl.trim()}${API_ROUTES.MESSAGES_DELTA}?${params.toString()}`,
    options: { headers: bearerAuthHeaders(sid) },
  }));
  if (!response?.ok) throw new Error(`delta sync failed (HTTP ${response?.status ?? 0})`);
  const data = await response.json();
  if (!Array.isArray(data?.changes)) throw new Error('delta sync returned an invalid page');
  return data as { changes: DeltaChange[]; cursor?: unknown; nextCursor?: unknown; hasMore?: unknown; };
}

/** Merge a page into the held timeline and flush it before the cursor moves. */
async function applyDeltaPage(options: DeltaSyncOptions, changes: DeltaChange[]): Promise<number> {
  const current = options.getMessages();
  const result = mergeDeltaChanges(current[options.peerId] ?? [], changes, options);
  if (!result.applied) return 0;
  const next = { ...current, [options.peerId]: result.messages };
  options.setMessages(next);
  result.tombstoned.forEach(messageId => options.onDeleted(messageId));
  saveChatSnapshot({ messagesByPeer: next }, options.scope);
  await flushChatDb(options.scope);
  return result.applied;
}

function nextDeltaCursor(cursor: string | null, data: { cursor?: unknown; hasMore?: unknown; }): string | null {
  const next = typeof data.cursor === 'string' && data.cursor ? data.cursor : cursor;
  if (data.hasMore === true && (!next || next === cursor)) {
    throw new Error('delta sync cursor did not advance');
  }
  return next;
}

/**
 * Bring one direct conversation up to date from its persisted cursor.
 *
 * @returns how many changed messages were applied
 */
export async function syncConversationDelta(options: DeltaSyncOptions): Promise<number> {
  const { scope, peerId } = options;
  if (!scope || !peerId) return 0;
  const key = deltaCursorKey(peerId);
  let cursor = (await readResource<string>(scope, key))?.value ?? null;
  let applied = 0;
  for (let page = 0; page < MAX_DELTA_PAGES && options.isCurrentScope(); page += 1) {
    const data = await fetchDeltaPage(options, cursor);
    if (!options.isCurrentScope()) break;
    applied += await applyDeltaPage(options, data.changes);
    const next = nextDeltaCursor(cursor, data);
    if (next && next !== cursor && options.isCurrentScope()) {
      await writeResource(scope, key, next);
      cursor = next;
    }
    if (data.hasMore !== true) break;
  }
  return applied;
}
