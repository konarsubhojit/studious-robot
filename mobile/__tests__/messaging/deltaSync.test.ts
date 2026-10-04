import { dataScope, withDatabase } from '../../src/storage/localDatabase';
import { loadChatSnapshot, resetChatDbCache } from '../../src/storage/chatDb';
import { readResource } from '../../src/storage/resourceCache';
import {
  deltaCursorKey,
  mergeDeltaChanges,
  syncConversationDelta,
  type DeltaSyncOptions,
} from '../../src/messaging/deltaSync';
import type { ChatMessage, MessagesByPeer } from '../../src/messaging/types';

jest.mock('../../src/appLogger', () => ({ logWarn: jest.fn(), logError: jest.fn() }));

const server = 'https://delta.example.test';
const scope = dataScope(server, 'alice');

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    messageId: 'm',
    senderId: 'bob',
    recipientId: 'alice',
    body: 'hello',
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  } as ChatMessage;
}

function page(changes: Array<{ type: string; message: ChatMessage; }>, cursor: string | null, extra = {}) {
  return { ok: true, json: async () => ({ conversationId: 'alice:bob', changes, cursor, nextCursor: null, hasMore: false, ...extra }) };
}

function harness(initial: MessagesByPeer = {}) {
  let messages = initial;
  const authedFetch = jest.fn();
  const onDeleted = jest.fn();
  const options: DeltaSyncOptions = {
    scope,
    userId: 'alice',
    peerId: 'bob',
    signalingUrl: server,
    authedFetch,
    isCurrentScope: () => true,
    getMessages: () => messages,
    setMessages: next => { messages = next; },
    onDeleted,
  };
  const requestedUrl = (call = 0) => authedFetch.mock.calls[call][0]('sess').url as string;
  return { options, authedFetch, onDeleted, requestedUrl, messages: () => messages };
}

beforeEach(async () => {
  resetChatDbCache();
  await withDatabase(async db => {
    await db.execute('DELETE FROM resource_cache');
    await db.execute('DELETE FROM chat_records');
  });
});

describe('mergeDeltaChanges', () => {
  test('server wins on content but client-only bookkeeping survives', () => {
    const local = [message({ messageId: 'm1', body: 'stale', clientCreatedAt: '2024-01-01T00:00:00.500Z', reactions: {} })];
    const { messages, applied } = mergeDeltaChanges(local, [
      { type: 'reactions', message: message({ messageId: 'm1', body: 'edited', reactions: { '👍': ['alice'] }, readAt: '2024-01-02T00:00:00.000Z' }) },
    ], { userId: 'alice', peerId: 'bob' });
    expect(applied).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      body: 'edited', reactions: { '👍': ['alice'] }, readAt: '2024-01-02T00:00:00.000Z',
      clientCreatedAt: '2024-01-01T00:00:00.500Z',
    });
  });

  test('ignores messages that do not belong to the conversation', () => {
    const local: ChatMessage[] = [];
    const result = mergeDeltaChanges(local, [
      { type: 'new', message: message({ messageId: 'x', senderId: 'carol' }) },
    ], { userId: 'alice', peerId: 'bob' });
    expect(result.messages).toBe(local);
    expect(result.applied).toBe(0);
  });

  test('a tombstone purges the local content and is reported for eviction', () => {
    const local = [message({ messageId: 'gone', body: 'secret', attachment: { url: 'https://x/y' } as never, reactions: { '❤️': ['alice'] } })];
    const result = mergeDeltaChanges(local, [
      { type: 'deleted', message: message({ messageId: 'gone', deletedAt: '2024-01-03T00:00:00.000Z' }) },
    ], { userId: 'alice', peerId: 'bob' });
    expect(result.tombstoned).toEqual(['gone']);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ body: '', attachment: null, reactions: {}, deletedAt: '2024-01-03T00:00:00.000Z' });
  });

  test('a delta plus a pending outbox entry does not duplicate the pending message', () => {
    const pending = message({
      messageId: 'client-1', clientMessageId: 'client-1', senderId: 'alice', recipientId: 'bob',
      body: 'queued', syncState: 'pending', pending: true, createdAt: '2024-01-05T00:00:00.000Z',
      clientCreatedAt: '2024-01-05T00:00:00.000Z',
    });
    const unsent = message({
      messageId: 'client-2', clientMessageId: 'client-2', senderId: 'alice', recipientId: 'bob',
      body: 'never reached the server', syncState: 'failed', failed: true, createdAt: '2024-01-06T00:00:00.000Z',
    });
    const result = mergeDeltaChanges([unsent, pending], [
      { type: 'new', message: message({ messageId: 'server-1', clientMessageId: 'client-1', senderId: 'alice', recipientId: 'bob', body: 'queued', createdAt: '2024-01-05T00:00:01.000Z' }) },
    ], { userId: 'alice', peerId: 'bob' });

    expect(result.messages.filter(entry => entry.clientMessageId === 'client-1')).toHaveLength(1);
    expect(result.messages.find(entry => entry.clientMessageId === 'client-1'))
      .toMatchObject({ messageId: 'server-1', syncState: 'synced', pending: false });
    // The local-only outbox row is untouched.
    expect(result.messages.find(entry => entry.messageId === 'client-2')).toBe(unsent);
    expect(result.messages).toHaveLength(2);
  });
});

describe('syncConversationDelta', () => {
  test('offline for N messages: one delta call applies exactly those N and persists the cursor', async () => {
    const { options, authedFetch, requestedUrl, messages } = harness({ bob: [message({ messageId: 'old' })] });
    const missed = [1, 2, 3].map(n => message({ messageId: `missed-${n}`, body: `missed ${n}`, createdAt: `2024-01-0${n + 1}T00:00:00.000Z` }));
    authedFetch.mockResolvedValueOnce(page(missed.map(entry => ({ type: 'new', message: entry })), 'cursor-1'));

    await expect(syncConversationDelta(options)).resolves.toBe(3);

    expect(authedFetch).toHaveBeenCalledTimes(1);
    expect(requestedUrl()).toContain('/messages/delta?');
    expect(requestedUrl()).toContain('peerId=bob');
    expect(requestedUrl()).not.toContain('cursor=');
    expect(messages().bob.map(entry => entry.messageId)).toEqual(['missed-3', 'missed-2', 'missed-1', 'old']);
    expect((await readResource<string>(scope, deltaCursorKey('bob')))?.value).toBe('cursor-1');
  });

  test('a deletion that happened while offline is reflected locally', async () => {
    const { options, authedFetch, onDeleted, messages } = harness({ bob: [message({ messageId: 'doomed', body: 'secret' })] });
    authedFetch.mockResolvedValueOnce(page([
      { type: 'deleted', message: message({ messageId: 'doomed', body: '', deletedAt: '2024-01-04T00:00:00.000Z' }) },
    ], 'cursor-2'));

    await syncConversationDelta(options);

    expect(messages().bob[0]).toMatchObject({ messageId: 'doomed', body: '', deletedAt: '2024-01-04T00:00:00.000Z' });
    expect(onDeleted).toHaveBeenCalledWith('doomed');
  });

  test('the cursor and the merged history are durable across a restart', async () => {
    const first = harness();
    first.authedFetch.mockResolvedValueOnce(page([{ type: 'new', message: message({ messageId: 'durable' }) }], 'cursor-durable'));
    await syncConversationDelta(first.options);

    // Restart: drop every in-memory cache and read back from SQLite.
    resetChatDbCache();
    const snapshot = await loadChatSnapshot(scope);
    expect(snapshot.messagesByPeer.bob.map(entry => entry.messageId)).toEqual(['durable']);

    const second = harness(snapshot.messagesByPeer);
    second.authedFetch.mockResolvedValueOnce(page([], 'cursor-durable'));
    await expect(syncConversationDelta(second.options)).resolves.toBe(0);
    expect(second.requestedUrl()).toContain('cursor=cursor-durable');
    expect(second.messages().bob.map(entry => entry.messageId)).toEqual(['durable']);
  });

  test('follows nextCursor across pages and refuses a cursor that does not advance', async () => {
    const { options, authedFetch, requestedUrl } = harness();
    authedFetch
      .mockResolvedValueOnce(page([{ type: 'new', message: message({ messageId: 'p1' }) }], 'page-1', { nextCursor: 'page-1', hasMore: true }))
      .mockResolvedValueOnce(page([{ type: 'new', message: message({ messageId: 'p2' }) }], 'page-2'));
    await expect(syncConversationDelta(options)).resolves.toBe(2);
    expect(requestedUrl(1)).toContain('cursor=page-1');

    authedFetch.mockResolvedValueOnce(page([], 'page-2', { nextCursor: 'page-2', hasMore: true }));
    await expect(syncConversationDelta(options)).rejects.toThrow('did not advance');
  });

  test('a failed request leaves the stored cursor untouched', async () => {
    const { options, authedFetch } = harness();
    authedFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(syncConversationDelta(options)).rejects.toThrow('HTTP 503');
    expect(await readResource<string>(scope, deltaCursorKey('bob'))).toBeNull();
  });
});
