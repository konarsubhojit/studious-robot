import { API_ROUTES } from '../../../shared';
import { bearerAuthHeaders } from '../authHeaders';
import { flushChatDb, saveChatSnapshot } from '../storage/chatDb';
import { readResource, writeResource } from '../storage/resourceCache';
import { upsertTimelineEntry } from './messageHistory';
import type { ChatMessage, MessagesByPeer } from './types';

const MESSAGE_SYNC_SINCE = '1970-01-01T00:00:00.000Z';
const MESSAGE_SYNC_LIMIT = 100;
const CHECKPOINT_KEY = 'messages:backfill';

export type MessageSyncCheckpoint = {
  since: string;
  cursor: string | null;
  complete: boolean;
  messagesSynced: number;
};

type SyncChange = { message?: ChatMessage };

type BackfillOptions = {
  scope: string;
  userId: string;
  signalingUrl: string;
  getSessionId: () => string | null;
  authedFetch: Function | null;
  isCurrentScope: () => boolean;
  getMessages: () => MessagesByPeer;
  setMessages: (messages: MessagesByPeer) => void;
  onStart: () => void;
  onProgress: (messageCount: number) => void;
  onDeleted: (messageId: string) => void;
};

function nextCheckpoint(
  current: MessageSyncCheckpoint,
  nextCursor: unknown,
  hasMore: boolean,
  count: number,
): MessageSyncCheckpoint {
  const cursor = typeof nextCursor === 'string' && nextCursor ? nextCursor : null;
  if (hasMore && (!cursor || cursor === current.cursor)) {
    throw new Error('message sync cursor did not advance');
  }
  return {
    since: current.since || MESSAGE_SYNC_SINCE,
    cursor,
    complete: !hasMore,
    messagesSynced: current.messagesSynced + count,
  };
}

function applyChanges(changes: SyncChange[], userId: string, messages: MessagesByPeer, onDeleted: (id: string) => void) {
  let next = messages;
  let applied = 0;
  for (const change of changes) {
    const message = change?.message;
    if (!message?.messageId || !message.senderId || !message.recipientId) continue;
    if (message.senderId !== userId && message.recipientId !== userId) continue;
    const peerId = message.senderId === userId ? message.recipientId : message.senderId;
    if (message.deletedAt) onDeleted(message.messageId);
    next = upsertTimelineEntry(next, peerId, message);
    applied += 1;
  }
  return { messages: next, applied };
}

async function fetchPage({
  signalingUrl, authedFetch, checkpoint,
}: Pick<BackfillOptions, 'signalingUrl' | 'authedFetch'> & {
  checkpoint: MessageSyncCheckpoint;
}) {
  const params = new URLSearchParams({
    since: checkpoint.since,
    limit: String(MESSAGE_SYNC_LIMIT),
  });
  if (checkpoint.cursor) params.set('cursor', checkpoint.cursor);
  const response = await authedFetch?.((sid: string) => ({
    url: `${signalingUrl.trim()}${API_ROUTES.MESSAGES_SYNC}?${params.toString()}`,
    options: { headers: bearerAuthHeaders(sid) },
  }));
  if (!response?.ok) throw new Error(`message sync failed (HTTP ${response?.status ?? 0})`);
  const data = await response.json();
  if (!Array.isArray(data.changes)) throw new Error('message sync returned an invalid page');
  return data;
}

export async function resumeMessageBackfill(options: BackfillOptions): Promise<void> {
  const stored = await readResource<MessageSyncCheckpoint>(options.scope, CHECKPOINT_KEY);
  let checkpoint: MessageSyncCheckpoint = stored?.value ?? {
    since: MESSAGE_SYNC_SINCE,
    cursor: null,
    complete: false,
    messagesSynced: 0,
  };
  options.onProgress(checkpoint.messagesSynced ?? 0);
  if (checkpoint.complete) return;
  options.onStart();

  while (options.isCurrentScope() && options.getSessionId()) {
    const data = await fetchPage({ ...options, checkpoint });
    if (!options.isCurrentScope()) return;
    const result = applyChanges(data.changes as SyncChange[], options.userId, options.getMessages(), options.onDeleted);
    if (result.messages !== options.getMessages()) {
      options.setMessages(result.messages);
      saveChatSnapshot({ messagesByPeer: result.messages }, options.scope);
      await flushChatDb(options.scope);
    }
    checkpoint = nextCheckpoint(
      checkpoint, data.nextCursor, data.hasMore === true, result.applied,
    );
    await writeResource(options.scope, CHECKPOINT_KEY, checkpoint);
    options.onProgress(checkpoint.messagesSynced);
    if (checkpoint.complete) return;
  }
}
