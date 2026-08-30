jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(),
}));

jest.mock('../../src/appLogger', () => ({
  logWarn: jest.fn(),
}));

import RNFS from 'react-native-fs';
import {
  CHAT_DB_FILE_PATH,
  MAX_CONVERSATIONS,
  MAX_MESSAGES_PER_CONVERSATION,
  clearChatDb,
  flushChatDb,
  loadChatSnapshot,
  pruneMessages,
  resetChatDbCache,
  saveChatSnapshot,
} from '../../src/storage/chatDb';

/** `count` messages, newest first, one minute apart. */
function makeMessages(count: number, overrides: Partial<import('../../src/hooks/useMessaging').ChatMessage> = {}): import('../../src/hooks/useMessaging').ChatMessage[] {
  return Array.from({ length: count }, (_unused, index) => ({
    messageId: `m${index}`,
    body: `message ${index}`,
    createdAt: new Date(Date.UTC(2024, 0, 1) + (count - index) * 60_000).toISOString(),
    syncState: 'synced',
    ...overrides,
  } as any));
}

describe('chatDb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetChatDbCache();
    (RNFS.exists as jest.Mock).mockResolvedValue(false);
    (RNFS.writeFile as jest.Mock).mockResolvedValue(undefined);
    (RNFS.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  test('loads an empty snapshot when nothing has been persisted', async () => {
    const snapshot = await loadChatSnapshot();
    expect(snapshot).toEqual({ conversations: [], messagesByPeer: {}, outbox: [], drafts: {} });
    expect(RNFS.readFile).not.toHaveBeenCalled();
  });

  test('loads previously persisted conversations, history and outbox', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.readFile as jest.Mock).mockResolvedValue(
      JSON.stringify({
        conversations: [{ conversationId: 'c1', peerId: 'bob', unreadCount: 1 }],
        messagesByPeer: { bob: [{ messageId: 'm1', body: 'hi', createdAt: '2024-01-01' }] },
        outbox: [{ messageId: 'q1', recipientId: 'bob', body: 'queued', attempts: '2' }],
      }),
    );

    const snapshot = await loadChatSnapshot();

    expect(snapshot.conversations).toHaveLength(1);
    expect(snapshot.messagesByPeer.bob[0].body).toBe('hi');
    expect(snapshot.outbox[0]).toMatchObject({ messageId: 'q1', attempts: 2 });
  });

  test('degrades to an empty snapshot when the file is corrupt', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.readFile as jest.Mock).mockResolvedValue('{not json');

    expect(await loadChatSnapshot()).toEqual({
      conversations: [],
      messagesByPeer: {},
      outbox: [],
      drafts: {},
    });
  });

  test('drops malformed rows rather than surfacing them to the UI', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.readFile as jest.Mock).mockResolvedValue(
      JSON.stringify({
        conversations: [{ peerId: 'bob' }, { conversationId: 'no-peer' }, null],
        messagesByPeer: { bob: [{ messageId: 'm1' }, { body: 'no id' }] },
        outbox: [{ messageId: 'q1', recipientId: 'bob', body: 'ok' }, { messageId: 'incomplete' }],
      }),
    );

    const snapshot = await loadChatSnapshot();

    expect(snapshot.conversations).toEqual([{ peerId: 'bob' }]);
    expect(snapshot.messagesByPeer.bob).toEqual([{ messageId: 'm1' }]);
    expect(snapshot.outbox).toHaveLength(1);
  });

  test('bounds retained history per conversation but keeps unsent messages', () => {
    const overflowing = [
      ...makeMessages(MAX_MESSAGES_PER_CONVERSATION + 5),
      ...makeMessages(1, {
        messageId: 'old-pending',
        body: 'never sent',
        createdAt: '2000-01-01T00:00:00.000Z',
        syncState: 'pending',
      }),
    ];

    const pruned = pruneMessages(overflowing);

    expect(pruned).toHaveLength(MAX_MESSAGES_PER_CONVERSATION + 1);
    expect(pruned.some(m => m.messageId === 'old-pending')).toBe(true);
  });

  test('saving prunes history and writes a single coalesced file', async () => {
    await loadChatSnapshot();

    saveChatSnapshot({
      conversations: [{ conversationId: 'c1', peerId: 'bob' }],
      messagesByPeer: { bob: makeMessages(MAX_MESSAGES_PER_CONVERSATION + 10) },
    });
    saveChatSnapshot({ outbox: [{ messageId: 'q1', recipientId: 'bob', body: 'queued' }] });
    await flushChatDb();

    expect(RNFS.writeFile).toHaveBeenCalledTimes(1);
    const [path, contents] = (RNFS.writeFile as jest.Mock).mock.calls[0];
    expect(path).toBe(CHAT_DB_FILE_PATH);
    const written = JSON.parse(contents);
    expect(written.messagesByPeer.bob).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);
    expect(written.outbox).toHaveLength(1);
    expect(written.conversations).toHaveLength(1);
  });

  test('a write failure is swallowed so it cannot break the chat UI', async () => {
    await loadChatSnapshot();
    (RNFS.writeFile as jest.Mock).mockRejectedValue(new Error('disk full'));

    saveChatSnapshot({ conversations: [{ peerId: 'bob' }] });

    await expect(flushChatDb()).resolves.toBeUndefined();
  });

  test('clearing removes the file and empties the snapshot', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify({ conversations: [{ peerId: 'bob' }] }));
    await loadChatSnapshot();

    await clearChatDb();

    expect(RNFS.unlink).toHaveBeenCalledWith(CHAT_DB_FILE_PATH);
    expect(await loadChatSnapshot()).toEqual({
      conversations: [],
      messagesByPeer: {},
      outbox: [],
      drafts: {},
    });
  });

  describe('retention bounds', () => {
    // The JSON document is only a defensible medium for this store *because*
    // it is bounded: every read and write serialises the whole file, so the
    // cost grows with these two numbers. Raising them is the point at which
    // the store has to move to SQLite (see ../../../docs/OPTIMIZATION_PLAN.md, P1.7), so
    // they are pinned here rather than left to drift.
    test('keeps the document small enough for whole-file reads and writes', () => {
      expect(MAX_MESSAGES_PER_CONVERSATION).toBe(200);
      expect(MAX_CONVERSATIONS).toBe(100);
      expect(MAX_MESSAGES_PER_CONVERSATION * MAX_CONVERSATIONS).toBeLessThanOrEqual(20_000);
    });
  });
});

describe('chatDb drafts', () => {
  test('round-trips a draft and drops empty ones', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(false);
    await loadChatSnapshot();

    saveChatSnapshot({
      drafts: {
        pia: { text: 'half a thought', replyToId: 'm1' },
        // An empty draft is indistinguishable from no draft at all.
        sam: { text: '   ' },
      },
    } as any);
    await flushChatDb();

    const written = JSON.parse((RNFS.writeFile as jest.Mock).mock.calls.at(-1)[1]);
    resetChatDbCache();
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify(written));

    const snapshot = await loadChatSnapshot();
    expect(snapshot.drafts.pia).toEqual({
      text: 'half a thought',
      replyToId: 'm1',
      updatedAt: undefined,
    });
    expect(snapshot.drafts.sam).toBeUndefined();
  });
});
