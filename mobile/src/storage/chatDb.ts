import RNFS from 'react-native-fs';
import { logWarn } from '../appLogger';
import type { ChatMessage, ConversationSummary, OutboxItem } from '../hooks/useMessaging';
import { errorMessage } from '../errors';

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
 * The rows are persisted as a single JSON document through `react-native-fs`
 * (already a dependency, and the medium `settingsStorage` uses) rather than
 * through a native SQLite module: the data set is bounded by
 * {@link MAX_MESSAGES_PER_CONVERSATION} per conversation, so a full read/write
 * is cheap, and the app avoids taking on a native dependency for it. Every
 * access goes through this module, so swapping the medium for SQLite later is
 * a change to this file alone.
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
let cache: ChatSnapshot | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
/** Resolves once every scheduled write has been flushed. */
let pendingWrite = Promise.resolve();

/**
 * Timestamp of a timeline entry, used for retention ordering.
 */
function entryTime(entry: any): number {
  const value = Date.parse(entry?.createdAt ?? '');
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
 * Coerce a parsed file into a valid snapshot, dropping anything malformed so a
 * corrupt or out-of-date file degrades to "less history" instead of breaking
 * the chat screens.
 */
function sanitizeSnapshot(parsed: unknown): ChatSnapshot {
  if (!parsed || typeof parsed !== 'object') return emptySnapshot();
  const raw = (parsed as Record<string, any>);

  const conversations = Array.isArray(raw.conversations)
    ? raw.conversations.filter(
        (entry: any) => entry && typeof entry.peerId === 'string',
      )
    : [];

  const messagesByPeer: Record<string, ChatMessage[]> = {};
  const rawMessages: Record<string, any> =
    raw.messagesByPeer && typeof raw.messagesByPeer === 'object' ? raw.messagesByPeer : {};
  Object.keys(rawMessages).forEach(peerId => {
    const entries = Array.isArray(rawMessages[peerId]) ? rawMessages[peerId] : [];
    messagesByPeer[peerId] = pruneMessages(
      entries.filter((entry: any) => entry && (entry.messageId || entry.callId)),
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
 */
export async function loadChatSnapshot(): Promise<ChatSnapshot> {
  if (cache) return cache;
  try {
    const exists = await RNFS.exists(CHAT_DB_FILE);
    if (!exists) {
      cache = emptySnapshot();
      return cache;
    }
    const content = await RNFS.readFile(CHAT_DB_FILE, 'utf8');
    cache = sanitizeSnapshot(JSON.parse(content));
  } catch (error) {
    logWarn('[ChatDb] Failed to load chat snapshot', { message: errorMessage(error) });
    cache = emptySnapshot();
  }
  return cache;
}

/** Write the cached snapshot to disk now. Failures are logged, never thrown. */
async function flushToDisk() {
  const snapshot = cache ?? emptySnapshot();
  try {
    await RNFS.writeFile(CHAT_DB_FILE, JSON.stringify(snapshot), 'utf8');
  } catch (error) {
    logWarn('[ChatDb] Failed to persist chat snapshot', { message: errorMessage(error) });
  }
}

/**
 * Merge `partial` into the cached snapshot and schedule a (debounced) write.
 * The in-memory cache is updated synchronously, so a read immediately after a
 * save observes the new state whether or not the write has landed yet.
 */
export function saveChatSnapshot(partial: Partial<ChatSnapshot>) {
  const base = cache ?? emptySnapshot();
  const messagesByPeer = partial.messagesByPeer ?? base.messagesByPeer;
  const pruned: Record<string, ChatMessage[]> = {};
  Object.keys(messagesByPeer).forEach(peerId => {
    pruned[peerId] = pruneMessages(messagesByPeer[peerId]);
  });

  cache = {
    conversations: (partial.conversations ?? base.conversations).slice(0, MAX_CONVERSATIONS),
    messagesByPeer: pruned,
    outbox: partial.outbox ?? base.outbox,
    drafts: partial.drafts ?? base.drafts ?? {},
  };

  if (writeTimer) return;
  pendingWrite = new Promise(resolve => {
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flushToDisk().then(resolve, resolve);
    }, WRITE_DEBOUNCE_MS);
  });
}

/**
 * Await any scheduled write, flushing it immediately.
 */
export async function flushChatDb(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
    await flushToDisk();
    return;
  }
  await pendingWrite;
}

/**
 * Drop everything held locally (e.g. on sign-out) and forget the cache.
 */
export async function clearChatDb(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  cache = emptySnapshot();
  try {
    const exists = await RNFS.exists(CHAT_DB_FILE);
    if (exists) await RNFS.unlink(CHAT_DB_FILE);
  } catch (error) {
    logWarn('[ChatDb] Failed to clear chat snapshot', { message: errorMessage(error) });
  }
}

/** Test seam: forget the in-memory cache so the next load re-reads the file. */
export function resetChatDbCache() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  cache = null;
  pendingWrite = Promise.resolve();
}

export const CHAT_DB_FILE_PATH = CHAT_DB_FILE;
