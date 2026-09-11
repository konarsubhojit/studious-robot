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
import { withDatabase } from '../../src/storage/localDatabase';
import type { DB } from '@op-engineering/op-sqlite';
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

let mockDb: jest.Mocked<DB>;
beforeEach(async () => {
  resetChatDbCache();
  await withDatabase(async db => {
    mockDb = db as jest.Mocked<DB>;
    await db.executeBatch([['DELETE FROM chat_records'], ['DELETE FROM resource_cache']]);
  });
});
afterEach(async () => {
  await flushChatDb().catch(() => {});
  resetChatDbCache();
});

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

  test('saving prunes history and commits one coalesced transaction', async () => {
    await loadChatSnapshot();
    mockDb.executeBatch.mockClear();

    saveChatSnapshot({
      conversations: [{ conversationId: 'c1', peerId: 'bob' }],
      messagesByPeer: { bob: makeMessages(MAX_MESSAGES_PER_CONVERSATION + 10) },
    });
    saveChatSnapshot({ outbox: [{ messageId: 'q1', recipientId: 'bob', body: 'queued' }] });
    await flushChatDb();

    expect(mockDb.executeBatch).toHaveBeenCalledTimes(1);
    expect(RNFS.writeFile).not.toHaveBeenCalled();
    resetChatDbCache();
    const written = await loadChatSnapshot();
    expect(written.messagesByPeer.bob).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);
    expect(written.outbox).toHaveLength(1);
    expect(written.conversations).toHaveLength(1);
  });

  test('a failed durable commit rejects and can be retried without losing rows', async () => {
    await loadChatSnapshot();
    mockDb.executeBatch.mockRejectedValueOnce(new Error('disk full'));

    saveChatSnapshot({ conversations: [{ peerId: 'bob' }] });

    await expect(flushChatDb()).rejects.toThrow('disk full');
    await flushChatDb();
    resetChatDbCache();
    expect((await loadChatSnapshot()).conversations).toEqual([{ peerId: 'bob' }]);
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
    // SQLite writes are incremental, but the hydrated UI snapshot must still
    // have a bounded memory footprint.
    test('keeps the hydrated cache bounded', () => {
      expect(MAX_MESSAGES_PER_CONVERSATION).toBe(200);
      expect(MAX_CONVERSATIONS).toBe(100);
      expect(MAX_MESSAGES_PER_CONVERSATION * MAX_CONVERSATIONS).toBeLessThanOrEqual(20_000);
    });

    // Retain the old representative fixture as a guard against unexpected
    // payload growth; it is no longer serialized as one document in production.
    test('a full cache stays within the existing payload size budget', () => {
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

  // The first fix only guarded saves issued before the read *started*. A save
  // landing while it is in flight is the same data loss, one tick later.
  test('a save during the read is not overwritten when the read lands', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    let releaseRead = (_: string) => {};
    (RNFS.readFile as jest.Mock).mockReturnValue(
      new Promise<string>(resolve => {
        releaseRead = resolve;
      }),
    );

    const loading = loadChatSnapshot();
    saveChatSnapshot({ outbox: [{ messageId: 'queued', recipientId: 'bob', body: 'hi' } as any] });
    releaseRead(
      JSON.stringify({
        conversations: [{ peerId: 'bob', unreadCount: 2 }],
        outbox: [{ messageId: 'stale', recipientId: 'bob', body: 'old' }],
      }),
    );
    const snapshot = await loading;

    expect(snapshot.outbox.map(item => item.messageId)).toEqual(['queued']);
    // …and the tables that write did not own still come from the file.
    expect(snapshot.conversations).toHaveLength(1);
  });

  // The load used to resolve to the snapshot captured at read time, so a save
  // between two loads was invisible to the second - contradicting the module's
  // own promise that a read after a save observes the new state.
  test('a load after a save sees the save', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(false);
    await loadChatSnapshot();

    saveChatSnapshot({ drafts: { bob: { text: 'later' } } });

    expect((await loadChatSnapshot()).drafts.bob?.text).toBe('later');
  });

  // An outbox-only write must not re-sort every conversation's history: that
  // runs on the JS thread for every message acknowledgement.
  test('a save re-prunes only the tables it was given', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(false);
    await loadChatSnapshot();

    saveChatSnapshot({ messagesByPeer: { bob: makeMessages(MAX_MESSAGES_PER_CONVERSATION + 10) } });
    const pruned = (await loadChatSnapshot()).messagesByPeer.bob;
    expect(pruned).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);

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

    resetChatDbCache();

    const snapshot = await loadChatSnapshot();
    expect(snapshot.drafts.pia).toEqual({
      text: 'half a thought',
      replyToId: 'm1',
      updatedAt: undefined,
    });
    expect(snapshot.drafts.sam).toBeUndefined();
  });
});

describe('SQLite isolation and incremental writes', () => {
      beforeEach(() => {
        (RNFS.exists as jest.Mock).mockResolvedValue(false);
      });

      test('isolates accounts and servers, including queued sends and drafts', async () => {
        for (const scope of ['alice@one', 'bob@one', 'alice@two']) {
          saveChatSnapshot({
            drafts: { bob: { text: scope } },
            outbox: [{ messageId: 'same-id', recipientId: 'bob', body: scope }],
          }, scope);
          await flushChatDb(scope);
        }
        resetChatDbCache();
        expect((await loadChatSnapshot('alice@one')).drafts.bob.text).toBe('alice@one');
        expect((await loadChatSnapshot('bob@one')).outbox[0].body).toBe('bob@one');
        await clearChatDb('alice@one');
        expect((await loadChatSnapshot('alice@two')).outbox[0].body).toBe('alice@two');
        expect((await loadChatSnapshot('alice@one')).outbox).toEqual([]);
      });

      test('does not assign an ownerless legacy outbox to a signed-in account', async () => {
        (RNFS.exists as jest.Mock).mockResolvedValue(true);
        (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify({
          outbox: [{ messageId: 'private', recipientId: 'bob', body: 'private' }],
        }));
        expect((await loadChatSnapshot('new-account')).outbox).toEqual([]);
        expect(RNFS.unlink).not.toHaveBeenCalled();
      });

      test('imports an explicitly owned legacy snapshot atomically and only once', async () => {
        (RNFS.exists as jest.Mock).mockResolvedValue(true);
        (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify({
          ownerScope: 'alice',
          drafts: { bob: { text: 'retained' } },
        }));
        expect((await loadChatSnapshot('alice')).drafts.bob.text).toBe('retained');
        resetChatDbCache();
        (RNFS.readFile as jest.Mock).mockClear();
        expect((await loadChatSnapshot('alice')).drafts.bob.text).toBe('retained');
        expect(RNFS.readFile).not.toHaveBeenCalled();
      });

      test('an outbox change never rewrites stored message rows', async () => {
        saveChatSnapshot({ messagesByPeer: { bob: makeMessages(200) } });
        await flushChatDb();
        mockDb.executeBatch.mockClear();
        saveChatSnapshot({ outbox: [{ messageId: 'q', recipientId: 'bob', body: 'hi' }] });
        await Promise.all([flushChatDb(), flushChatDb()]);
        expect(mockDb.executeBatch).toHaveBeenCalledTimes(1);
        const [commands] = mockDb.executeBatch.mock.calls[0];
        expect(commands).toHaveLength(1);
        expect(commands[0][1]).toEqual(expect.arrayContaining(['outbox', 'q']));
      });

      test('clearing fences an in-flight load and pending writes', async () => {
        saveChatSnapshot({ drafts: { bob: { text: 'must not return' } } }, 'alice');
        const loading = loadChatSnapshot('alice');
        await clearChatDb('alice');
        await loading;
        resetChatDbCache();
        expect((await loadChatSnapshot('alice')).drafts).toEqual({});
      });

      test('rolls back the optimistic message if a later outbox statement fails', async () => {
        await loadChatSnapshot('atomic');
        await withDatabase(async db => {
          await db.execute(`CREATE TEMP TRIGGER reject_outbox BEFORE INSERT ON chat_records
            WHEN NEW.kind = 'outbox' BEGIN SELECT RAISE(ABORT, 'disk failure'); END`);
        });
        saveChatSnapshot({
          messagesByPeer: { bob: makeMessages(1) },
          outbox: [{ messageId: 'q', recipientId: 'bob', body: 'hi' }],
        }, 'atomic');
        try {
          await expect(flushChatDb('atomic')).rejects.toThrow('disk failure');
          const rows = await withDatabase(db => db.execute('SELECT id FROM chat_records WHERE scope = ?', ['atomic']));
          expect(rows.rows).toHaveLength(0);
        } finally {
          await withDatabase(async db => { await db.execute('DROP TRIGGER reject_outbox'); });
        }
        await flushChatDb('atomic');
        resetChatDbCache();
        expect((await loadChatSnapshot('atomic')).outbox).toHaveLength(1);
        expect((await loadChatSnapshot('atomic')).messagesByPeer.bob).toHaveLength(1);
      });

      test('bounds peer history caches while preserving draft and queued-message peers', async () => {
        const messagesByPeer = Object.fromEntries(
          Array.from({ length: 103 }, (_, index) => [`peer-${index}`, makeMessages(1)]),
        );
        saveChatSnapshot({
          messagesByPeer,
          drafts: { 'peer-101': { text: 'unsent thought' } },
          outbox: [{ messageId: 'q', recipientId: 'peer-102', body: 'unsent' }],
        });
        await flushChatDb();
        const first = await loadChatSnapshot();
        expect(Object.keys(first.messagesByPeer)).toHaveLength(102);
        expect(first.messagesByPeer['peer-100']).toBeUndefined();
        expect(first.messagesByPeer['peer-101']).toHaveLength(1);
        expect(first.messagesByPeer['peer-102']).toHaveLength(1);
        saveChatSnapshot({ messagesByPeer });
        await flushChatDb();
        expect((await loadChatSnapshot()).messagesByPeer['peer-102']).toHaveLength(1);
      });
    });
