import RNFS from 'react-native-fs';
import { logWarn } from '../appLogger';
import type { ChatMessage, ConversationSummary, OutboxItem } from '../messaging/types';
import { normalizeEntryTimestamps } from '../messaging/messageHistory';
import { timestampMs } from '../../../shared/time';
import { errorMessage } from '../errors';
import { withDatabase } from './localDatabase';
import { rowChanges, snapshotRows } from './chatRecords';
import type { ChatRows } from './chatRecords';

/**
 * Durable local chat store: the conversation list, per-conversation message
 * history, and the outbox of sends that have not been acknowledged yet.
 *
 * It exists so the app is usable before (and without) the network: the chat
 * screens hydrate from here on launch and only then reconcile with the server,
 * and a message composed offline survives process death because it is written
 * here *before* it is emitted.
 *
 * Shape — three logical tables, keyed exactly as the server keys them so a
 * server row and its local copy always reconcile by id, never by position:
 *
 *   conversations  { conversationId, peerId, lastMessage, lastActivity,
 *                    unreadCount }
 *   messages       peerId → message[] (newest-first, matching the server's
 *                  ordering), each with a `syncState` of synced|pending|failed
 *   outbox         { messageId, conversationId, recipientId, body, createdAt,
 *                    attempts, lastAttemptAt, lastError }
 *
 * Rows live in SQLite behind an asynchronous JSI connection. Each flush is
 * one atomic transaction containing only changed rows. Callers supply an
 * account/server scope; the unscoped default exists only for legacy imports.
 */

const CHAT_DB_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-chat.json`;

/** Retention: newest messages kept per conversation; older ones are pruned on
 * load and re-fetchable from the server, so the file cannot grow unbounded. */
export const MAX_MESSAGES_PER_CONVERSATION = 200;

/** Retention: conversations kept, newest activity first. */
export const MAX_CONVERSATIONS = 100;

/** Writes are coalesced over this window so a burst of state updates (a
 * fetched history page, a delivery receipt, a read receipt) costs one write. */
const WRITE_DEBOUNCE_MS = 250;

export type { ConversationSummary };
export type { ChatMessage };
export type { OutboxItem };

/**
 * An unsent composer entry: the text the user typed and, when they were
 * replying, the message they were replying to. Kept per peer so switching
 * conversations (or a process death) never loses typed-but-unsent text.
 */
export type ChatDraft = {
  text: string;
  replyToId?: string | null;
  updatedAt?: string;
};

export type ChatSnapshot = {
  conversations: ConversationSummary[];
  messagesByPeer: Record<string, ChatMessage[]>;
  outbox: OutboxItem[];
  /** peerId -> draft; a peer with no typed text has no entry at all. */
  drafts: Record<string, ChatDraft>;
};

function emptySnapshot(): ChatSnapshot {
  return { conversations: [], messagesByPeer: {}, outbox: [], drafts: {} };
}

/**
 * Last known snapshot, so a save only has to supply the tables it changed and
 * a load after a save does not have to hit the disk.
 */
type Store = {
  cache: ChatSnapshot | null;
  persisted?: ChatSnapshot;
  rows: ChatRows;
  loadPromise: Promise<void> | null;
  preloadWrites: Set<keyof ChatSnapshot>;
  writeTimer: ReturnType<typeof setTimeout> | null;
  pendingWrite: Promise<void>;
  closed: boolean;
};
const stores = new Map<string, Store>();
function storeFor(scope: string): Store {
  let store = stores.get(scope);
  if (!store) {
    store = {
      cache: null, rows: new Map(), loadPromise: null, preloadWrites: new Set(),
      writeTimer: null, pendingWrite: Promise.resolve(), closed: false,
    };
    stores.set(scope, store);
  }
  return store;
}

/**
 * Timestamp of a timeline entry, used for retention ordering.
 */
function entryTime(entry: any): number {
  const value = timestampMs(entry?.createdAt);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Keep only the newest {@link MAX_MESSAGES_PER_CONVERSATION} entries, plus
 * every entry still awaiting delivery: an old message that never sent must
 * never be pruned out from under its outbox row.
 *
 * @param messages newest-first
 */
export function pruneMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  const ordered = [...messages].sort((a, b) => entryTime(b) - entryTime(a));
  const kept = ordered.slice(0, MAX_MESSAGES_PER_CONVERSATION);
  const unsent = ordered
    .slice(MAX_MESSAGES_PER_CONVERSATION)
    .filter(
      (entry: any) => entry?.syncState === 'pending' || entry?.syncState === 'failed',
    );
  return unsent.length ? [...kept, ...unsent].sort((a, b) => entryTime(b) - entryTime(a)) : kept;
}

/**
 * Canonicalise the timestamps a chat-list row carries.
 *
 * A row's `lastActivity` is the merged newest of the conversation's last
 * message and last call, and both it and `lastMessage` are timeline entries, so
 * they need the same treatment as the history itself — the list orders and
 * previews by them.
 */
function normalizeConversationTimestamps(row: any): any {
  const lastMessage = row.lastMessage ? normalizeEntryTimestamps(row.lastMessage) : row.lastMessage;
  const lastActivity = row.lastActivity
    ? normalizeEntryTimestamps(row.lastActivity)
    : row.lastActivity;
  if (lastMessage === row.lastMessage && lastActivity === row.lastActivity) return row;
  return { ...row, lastMessage, lastActivity };
}

/**
 * Coerce a parsed file into a valid snapshot, dropping anything malformed so a
 * corrupt or out-of-date file degrades to "less history" instead of breaking
 * the chat screens.
 *
 * Timestamps are canonicalised on the way in.  The file outlives any one server
 * response, so an entry cached from a build that stored a raw Postgres
 * `timestamptz` rendering would otherwise keep its unparseable time for as long
 * as retention holds it, and go on sorting itself by id.
 */
function sanitizeSnapshot(parsed: unknown): ChatSnapshot {
  if (!parsed || typeof parsed !== 'object') return emptySnapshot();
  const raw = (parsed as Record<string, any>);

  const conversations = Array.isArray(raw.conversations)
    ? raw.conversations
        .filter((entry: any) => entry && typeof entry.peerId === 'string')
        .map(normalizeConversationTimestamps)
    : [];

  const messagesByPeer: Record<string, ChatMessage[]> = {};
  const rawMessages: Record<string, any> =
    raw.messagesByPeer && typeof raw.messagesByPeer === 'object' ? raw.messagesByPeer : {};
  Object.keys(rawMessages).forEach(peerId => {
    const entries = Array.isArray(rawMessages[peerId]) ? rawMessages[peerId] : [];
    messagesByPeer[peerId] = pruneMessages(
      entries
        .filter((entry: any) => entry && (entry.messageId || entry.callId))
        .map(normalizeEntryTimestamps),
    );
  });

  const outbox = Array.isArray(raw.outbox)
    ? raw.outbox
        .filter(
          (item: any) =>
            item &&
            typeof item.messageId === 'string' &&
            typeof item.recipientId === 'string' &&
            typeof item.body === 'string',
        )
        .map((item: any) => ({ ...item, attempts: Number(item.attempts) || 0 }))
    : [];

  // A draft is only worth keeping while it has text: an empty one is
  // indistinguishable from having no draft, and storing it would leak a row
  // per conversation the user merely opened.
  const drafts: Record<string, ChatDraft> = {};
  const rawDrafts: Record<string, any> =
    raw.drafts && typeof raw.drafts === 'object' ? raw.drafts : {};
  Object.keys(rawDrafts).forEach(peerId => {
    const entry = rawDrafts[peerId];
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return;
    drafts[peerId] = {
      text: entry.text,
      replyToId: typeof entry.replyToId === 'string' ? entry.replyToId : null,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : undefined,
    };
  });

  return {
    conversations: conversations.slice(0, MAX_CONVERSATIONS),
    messagesByPeer,
    outbox,
    drafts,
  };
}

/**
 * Read the persisted chat state, pruned to the retention limits.
 *
 * Never rejects: an unreadable or corrupt file yields an empty snapshot, which
 * simply means the app starts as it did before anything was cached.
 *
 * Concurrent callers share a single read, and a save that lands while the read
 * is in flight is preserved — see {@link preloadWrites}.  Both matter because
 * the load is asynchronous but a save is not: the composer can queue a send
 * before the disk read resolves, and treating the resulting cache as
 * authoritative discarded every conversation, message and draft on disk.
 */
export async function loadChatSnapshot(scope = 'legacy'): Promise<ChatSnapshot> {
  const store = storeFor(scope);
  store.loadPromise ??= readSnapshot(store, scope).catch(error => {
    store.loadPromise = null;
    throw error;
  });
  await store.loadPromise;
  // Deliberately the live cache rather than whatever the read resolved to: a
  // save between two loads must be visible to the second, as it was when this
  // returned `cache` directly.
  return store.cache ?? emptySnapshot();
}

/** Never assign ownerless legacy sends to whichever account happens to log in. */
async function readLegacySnapshot(scope: string): Promise<ChatSnapshot> {
  try {
    if (!await RNFS.exists(CHAT_DB_FILE)) return emptySnapshot();
    const parsed = JSON.parse(await RNFS.readFile(CHAT_DB_FILE, 'utf8'));
    if (scope !== 'legacy' && parsed?.ownerScope !== scope) return emptySnapshot();
    return sanitizeSnapshot(parsed);
  } catch (error) {
    logWarn('[ChatDb] Failed to read legacy snapshot', { message: errorMessage(error) });
    return emptySnapshot();
  }
}

async function readSnapshot(store: Store, scope: string): Promise<void> {
  const fromDisk = await withDatabase(async db => {
    const result = await db.execute(
      'SELECT kind, peer, payload FROM chat_records WHERE scope = ? ORDER BY position', [scope]);
    const snapshot = emptySnapshot();
    for (const row of result.rows) {
      const value: unknown = JSON.parse(String(row.payload));
      if (row.kind === 'messagesByPeer') {
        const peer = String(row.peer);
        snapshot.messagesByPeer[peer] ??= [];
        snapshot.messagesByPeer[peer].push(value as ChatMessage);
      } else if (row.kind === 'drafts') {
        snapshot.drafts[String(row.peer)] = value as ChatDraft;
      } else if (row.kind === 'conversations') {
        snapshot.conversations.push(value as ConversationSummary);
      } else if (row.kind === 'outbox') {
        snapshot.outbox.push(value as OutboxItem);
      }
    }
    const migrated = await db.execute(
      'SELECT payload FROM resource_cache WHERE scope = ? AND key = ?', [scope, 'chat:migrated']);
    if (!migrated.rows.length) {
      const legacy = result.rows.length ? snapshot : await readLegacySnapshot(scope);
      await db.executeBatch([
        ...rowChanges(scope, new Map(), snapshotRows(legacy)),
        ['INSERT INTO resource_cache(scope, key, payload, updated_at) VALUES (?, ?, ?, ?)',
          [scope, 'chat:migrated', 'true', Date.now()]],
      ]);
      return legacy;
    }
    return sanitizeSnapshot(snapshot);
  });
  if (store.closed) return;
  store.persisted = fromDisk;
  store.rows = snapshotRows(fromDisk);
  const merged = { ...fromDisk };
  for (const table of store.preloadWrites) {
    (merged as Record<string, unknown>)[table] = store.cache?.[table];
  }
  store.preloadWrites.clear();
  store.cache = merged;
}

async function flushToDisk(store: Store, scope: string) {
  await loadChatSnapshot(scope);
  if (store.closed) return;
  await withDatabase(async db => {
    if (store.closed) return;
    const snapshot = store.cache ?? emptySnapshot();
    const rows = snapshotRows(snapshot, store.persisted, store.rows);
    const commands = rowChanges(scope, store.rows, rows);
    if (commands.length) await db.executeBatch(commands);
    store.persisted = snapshot;
    store.rows = rows;
  });
}

/**
 * Merge `partial` into the cached snapshot and schedule a (debounced) write.
 * The in-memory cache is updated synchronously, so a read immediately after a
 * save observes the new state whether or not the write has landed yet.
 *
 * Only the tables the caller actually supplied are re-pruned: everything else
 * is already at its retention limit from when it was stored, and re-sorting
 * every conversation's history on an outbox-only write put a full sort of the
 * entire local store on the JS thread for each message acknowledgement.
 */
export function saveChatSnapshot(partial: Partial<ChatSnapshot>, scope = 'legacy') {
  const store = storeFor(scope);
  if (store.closed) return;
  const base = store.cache ?? emptySnapshot();

  let messagesByPeer = base.messagesByPeer;
  if (partial.messagesByPeer) {
    messagesByPeer = {};
    Object.keys(partial.messagesByPeer).forEach(peerId => {
      const entries = partial.messagesByPeer![peerId];
      messagesByPeer[peerId] = entries === base.messagesByPeer[peerId]
        ? entries : pruneMessages(entries);
    });
  }

  store.cache = {
    conversations: partial.conversations
      ? partial.conversations.slice(0, MAX_CONVERSATIONS)
      : base.conversations,
    messagesByPeer,
    outbox: partial.outbox ?? base.outbox,
    drafts: partial.drafts ?? base.drafts ?? {},
  };

  // Until the file has been folded in, remember which tables this write owns so
  // the read folds itself in underneath them rather than over them.  The test
  // is "has the read finished", not "has one started": a save landing *during*
  // the read is exactly the case this exists for.
  if (!store.persisted) {
    (Object.keys(partial) as Array<keyof ChatSnapshot>).forEach(table =>
      store.preloadWrites.add(table),
    );
  }

  if (store.writeTimer) return;
  store.writeTimer = setTimeout(() => {
    store.writeTimer = null;
    void flushChatDb(scope).catch(error => {
      logWarn('[ChatDb] Failed to persist snapshot', { message: errorMessage(error) });
    });
  }, WRITE_DEBOUNCE_MS);
}

/**
 * Await any scheduled write, flushing it immediately.
 */
export async function flushChatDb(scope = 'legacy'): Promise<void> {
  const store = storeFor(scope);
  if (store.writeTimer) clearTimeout(store.writeTimer);
  store.writeTimer = null;
  const write = store.pendingWrite.catch(() => {}).then(() => flushToDisk(store, scope));
  store.pendingWrite = write;
  await write;
}

/**
 * Drop everything held locally (e.g. on sign-out) and forget the cache.
 */
export async function clearChatDb(scope = 'legacy'): Promise<void> {
  const store = storeFor(scope);
  if (store.writeTimer) clearTimeout(store.writeTimer);
  store.closed = true;
  await store.loadPromise?.catch(() => {});
  await store.pendingWrite.catch(() => {});
  await withDatabase(async db => {
    await db.executeBatch([
      ['DELETE FROM chat_records WHERE scope = ?', [scope]],
      [`INSERT OR REPLACE INTO resource_cache(scope, key, payload, updated_at) VALUES (?, ?, ?, ?)`,
        [scope, 'chat:migrated', 'true', Date.now()]],
    ]);
  });
  stores.delete(scope);
  if (scope === 'legacy' && await RNFS.exists(CHAT_DB_FILE)) await RNFS.unlink(CHAT_DB_FILE);
}

/** Test seam: forget the in-memory cache so the next load re-reads the file. */
export function resetChatDbCache() {
  for (const store of stores.values()) {
    if (store.writeTimer) clearTimeout(store.writeTimer);
    store.closed = true;
  }
  stores.clear();
}

export const CHAT_DB_FILE_PATH = CHAT_DB_FILE;
