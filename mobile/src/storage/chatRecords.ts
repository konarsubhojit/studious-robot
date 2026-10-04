import type { SQLBatchTuple } from '@op-engineering/op-sqlite';
import type { ChatSnapshot } from './chatDb';
import { timelineEntryId } from '../messaging/messageIdentity';
import type { OutboxItem } from '../messaging/types';
import { isRetryable } from '../messaging/sendPipeline';

export type StoredChatRow = {
  kind: keyof ChatSnapshot;
  id: string;
  peer: string;
  position: number;
  payload: string;
};

export type ChatRows = Map<string, StoredChatRow>;

function addRow(rows: ChatRows, kind: keyof ChatSnapshot, id: string, peer: string, position: number, value: unknown) {
  rows.set(JSON.stringify([kind, id]), { kind, id, peer, position, payload: JSON.stringify(value) });
}

/** Unchanged peer arrays bypass serialization, not merely the eventual SQL write. */
export function snapshotRows(snapshot: ChatSnapshot, previous?: ChatSnapshot, held: ChatRows = new Map()): ChatRows {
  const rows: ChatRows = new Map();
  for (const [key, row] of held) {
    if (snapshot[row.kind] === previous?.[row.kind]) {
      rows.set(key, row);
    } else if (row.kind === 'messagesByPeer' &&
      snapshot.messagesByPeer[row.peer] === previous?.messagesByPeer[row.peer]) {
      rows.set(key, row);
    }
  }
  if (snapshot.conversations !== previous?.conversations) {
    snapshot.conversations.forEach((entry, position) =>
      addRow(rows, 'conversations', entry.peerId, entry.peerId, position, entry));
  }
  for (const [peer, entries] of Object.entries(snapshot.messagesByPeer)) {
    if (entries === previous?.messagesByPeer[peer]) continue;
    entries.forEach((entry, position) =>
      addRow(rows, 'messagesByPeer',
        JSON.stringify([entry.conversationId || peer, timelineEntryId(entry)]), peer, position, entry));
  }
  if (snapshot.outbox !== previous?.outbox) {
    snapshot.outbox.forEach((entry, position) =>
      addRow(rows, 'outbox', entry.messageId, entry.recipientId, position, entry));
  }
  if (snapshot.drafts !== previous?.drafts) {
    Object.entries(snapshot.drafts).forEach(([peer, draft]) =>
      addRow(rows, 'drafts', peer, peer, 0, draft));
  }
  if (snapshot.socketCursors !== previous?.socketCursors) {
    Object.entries(snapshot.socketCursors).forEach(([conversationId, cursor]) =>
      addRow(rows, 'socketCursors', conversationId, conversationId, 0, cursor));
  }
  return rows;
}

export function rowChanges(scope: string, previous: ChatRows, next: ChatRows): SQLBatchTuple[] {
  const commands: SQLBatchTuple[] = [];
  for (const [key, row] of previous) {
    if (!next.has(key)) commands.push(row.kind === 'outbox' ? [
      'DELETE FROM outbox WHERE scope = ? AND id = ?', [scope, row.id],
    ] : [
      'DELETE FROM chat_records WHERE scope = ? AND kind = ? AND id = ?', [scope, row.kind, row.id],
    ]);
  }
  for (const [key, row] of next) {
    const old = previous.get(key);
    if (old?.payload === row.payload && old.position === row.position) continue;
    if (row.kind === 'outbox') {
      const item = JSON.parse(row.payload) as OutboxItem;
      commands.push([
        `INSERT INTO outbox(scope, id, peer, position, client_key, attempts, last_error, next_attempt_at, state, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, id) DO UPDATE SET peer = excluded.peer, position = excluded.position,
           client_key = excluded.client_key, attempts = excluded.attempts, last_error = excluded.last_error,
           next_attempt_at = excluded.next_attempt_at, state = excluded.state, payload = excluded.payload`,
        [scope, row.id, row.peer, row.position, item.clientMessageId ?? row.id,
          item.attempts ?? 0, item.lastError ?? null, item.nextAttemptAt ?? null,
          isRetryable(item) ? 'pending' : 'failed', row.payload],
      ]);
      continue;
    }
    commands.push([
      `INSERT INTO chat_records(scope, kind, id, peer, position, payload) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, kind, id) DO UPDATE SET position = excluded.position, payload = excluded.payload`,
      [scope, row.kind, row.id, row.peer, row.position, row.payload],
    ]);
  }
  return commands;
}
