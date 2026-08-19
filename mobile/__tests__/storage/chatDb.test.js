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
  MAX_MESSAGES_PER_CONVERSATION,
  clearChatDb,
  flushChatDb,
  loadChatSnapshot,
  pruneMessages,
  resetChatDbCache,
  saveChatSnapshot,
} from '../../src/storage/chatDb';

/** `count` messages, newest first, one minute apart. */
function makeMessages(count, overrides = {}) {
  return Array.from({ length: count }, (_unused, index) => ({
    messageId: `m${index}`,
    body: `message ${index}`,
    createdAt: new Date(Date.UTC(2024, 0, 1) + (count - index) * 60_000).toISOString(),
    syncState: 'synced',
    ...overrides,
  }));
}

describe('chatDb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetChatDbCache();
    RNFS.exists.mockResolvedValue(false);
    RNFS.writeFile.mockResolvedValue(undefined);
    RNFS.unlink.mockResolvedValue(undefined);
  });

  test('loads an empty snapshot when nothing has been persisted', async () => {
    const snapshot = await loadChatSnapshot();
    expect(snapshot).toEqual({ conversations: [], messagesByPeer: {}, outbox: [] });
    expect(RNFS.readFile).not.toHaveBeenCalled();
  });

  test('loads previously persisted conversations, history and outbox', async () => {
    RNFS.exists.mockResolvedValue(true);
    RNFS.readFile.mockResolvedValue(
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
    RNFS.exists.mockResolvedValue(true);
    RNFS.readFile.mockResolvedValue('{not json');

    expect(await loadChatSnapshot()).toEqual({
      conversations: [],
      messagesByPeer: {},
      outbox: [],
    });
  });

  test('drops malformed rows rather than surfacing them to the UI', async () => {
    RNFS.exists.mockResolvedValue(true);
    RNFS.readFile.mockResolvedValue(
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
      {
        messageId: 'old-pending',
        body: 'never sent',
        createdAt: '2000-01-01T00:00:00.000Z',
        syncState: 'pending',
      },
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
    const [path, contents] = RNFS.writeFile.mock.calls[0];
    expect(path).toBe(CHAT_DB_FILE_PATH);
    const written = JSON.parse(contents);
    expect(written.messagesByPeer.bob).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);
    expect(written.outbox).toHaveLength(1);
    expect(written.conversations).toHaveLength(1);
  });

  test('a write failure is swallowed so it cannot break the chat UI', async () => {
    await loadChatSnapshot();
    RNFS.writeFile.mockRejectedValue(new Error('disk full'));

    saveChatSnapshot({ conversations: [{ peerId: 'bob' }] });

    await expect(flushChatDb()).resolves.toBeUndefined();
  });

  test('clearing removes the file and empties the snapshot', async () => {
    RNFS.exists.mockResolvedValue(true);
    RNFS.readFile.mockResolvedValue(JSON.stringify({ conversations: [{ peerId: 'bob' }] }));
    await loadChatSnapshot();

    await clearChatDb();

    expect(RNFS.unlink).toHaveBeenCalledWith(CHAT_DB_FILE_PATH);
    expect(await loadChatSnapshot()).toEqual({
      conversations: [],
      messagesByPeer: {},
      outbox: [],
    });
  });
});
