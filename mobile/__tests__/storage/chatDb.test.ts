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

    // The message *count* is only half of what a write costs: the other half
    // is how big each message is, and that grows every time the schema gains a
    // field. `JSON.stringify` of the whole document runs on the JS thread on
    // every flush, so this pins the input to the latency recorded against P1.7
    // in ../../../docs/OPTIMIZATION_PLAN.md — a schema change that doubles the
    // document doubles the jank on send.
    test('a full document stays within the size the P1.7 measurement assumed', () => {
      const snapshot = {
        conversations: [],
        messagesByPeer: {},
        outbox: [],
        drafts: {},
      } as any;

      for (let index = 0; index < MAX_CONVERSATIONS; index += 1) {
        const peerId = `user-peer${index}`;
        const messages = makeMessages(MAX_MESSAGES_PER_CONVERSATION, {
          conversationId: `conv-${index}`,
          senderId: peerId,
          recipientId: 'user-alice',
          body: 'Sure, that works for me — see you at half past then.',
          type: 'text',
          attachment: null,
          replyTo: null,
          reactions: {},
          deletedAt: null,
          deliveredTo: ['user-alice'],
          readAt: '2024-01-01T00:00:00.000Z',
        } as any);
        snapshot.conversations.push({
          conversationId: `conv-${index}`,
          peerId,
          lastMessage: messages[0],
          lastActivity: '2024-01-01T00:00:00.000Z',
          unreadCount: 0,
        });
        snapshot.messagesByPeer[peerId] = messages;
      }

      const bytes = JSON.stringify(snapshot).length;
      expect(bytes).toBeGreaterThan(1_000_000);
      expect(bytes).toBeLessThan(12_000_000);
    });
  });
});

// The load is asynchronous, a save is not: the composer can queue a send before
// the disk read resolves. The cache the save left behind used to satisfy the
// load outright, so the file was never read and every persisted conversation,
// message and draft was silently discarded — then overwritten with nothing.
describe('chatDb load/save ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetChatDbCache();
  });

  test('a save before the first load does not stop the file being read', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.readFile as jest.Mock).mockResolvedValue(
      JSON.stringify({
        conversations: [{ peerId: 'bob', unreadCount: 2 }],
        messagesByPeer: { bob: makeMessages(3) },
        outbox: [],
        drafts: {},
      }),
    );

    saveChatSnapshot({ outbox: [{ messageId: 'queued', recipientId: 'bob', body: 'hi' } as any] });
    const snapshot = await loadChatSnapshot();

    expect(RNFS.readFile).toHaveBeenCalled();
    expect(snapshot.conversations).toHaveLength(1);
    expect(snapshot.messagesByPeer.bob).toHaveLength(3);
  });

  test('the pre-load write wins over the file for the table it owns', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.readFile as jest.Mock).mockResolvedValue(
      JSON.stringify({
        conversations: [],
        messagesByPeer: {},
        outbox: [{ messageId: 'stale', recipientId: 'bob', body: 'old' }],
        drafts: {},
      }),
    );

    saveChatSnapshot({ outbox: [{ messageId: 'queued', recipientId: 'bob', body: 'hi' } as any] });
    const snapshot = await loadChatSnapshot();

    expect(snapshot.outbox.map(item => item.messageId)).toEqual(['queued']);
  });

  test('concurrent loads share one read of the file', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify({ conversations: [] }));

    const [first, second] = await Promise.all([loadChatSnapshot(), loadChatSnapshot()]);

    expect(RNFS.readFile).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  test('a load after clearing does not resurrect the deleted file', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.readFile as jest.Mock).mockResolvedValue(
      JSON.stringify({ conversations: [{ peerId: 'bob', unreadCount: 1 }] }),
    );
    (RNFS.unlink as jest.Mock).mockResolvedValue(undefined);

    await clearChatDb();
    const snapshot = await loadChatSnapshot();

    expect(snapshot.conversations).toEqual([]);
  });

  // An outbox-only write must not re-sort every conversation's history: that
  // runs on the JS thread for every message acknowledgement.
  test('a save re-prunes only the tables it was given', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(false);
    await loadChatSnapshot();

    const history = makeMessages(MAX_MESSAGES_PER_CONVERSATION + 10);
    saveChatSnapshot({ messagesByPeer: { bob: history } });
    const pruned = (await loadChatSnapshot()).messagesByPeer.bob;

    saveChatSnapshot({ outbox: [] });
    expect((await loadChatSnapshot()).messagesByPeer.bob).toBe(pruned);
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
