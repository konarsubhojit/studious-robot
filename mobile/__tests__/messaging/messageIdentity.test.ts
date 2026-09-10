import {
  byNewestFirst,
  byOldestFirst,
  createMessageId,
  timelineEntryId,
} from '../../src/messaging/messageIdentity';

/**
 * Identity and ordering: what every other messaging module reconciles by.
 */

describe('timelineEntryId', () => {
  test('a message is identified by its message id and a call by its call id', () => {
    expect(timelineEntryId({ messageId: 'm1' })).toBe('m1');
    expect(timelineEntryId({ callId: 'c1' })).toBe('c1');
    expect(timelineEntryId({})).toBeUndefined();
  });
});

describe('ordering', () => {
  const older = { createdAt: '2026-08-25T10:00:00.000Z' };
  const newer = { createdAt: '2026-08-25T11:00:00.000Z' };

  test('history is newest first and the outbox is oldest first', () => {
    expect([older, newer].sort(byNewestFirst)).toEqual([newer, older]);
    expect([newer, older].sort(byOldestFirst)).toEqual([older, newer]);
  });

  test('timestamp ties use deterministic type and id ordering', () => {
    const createdAt = '2026-08-25T10:00:00.000Z';
    expect([
      { callId: 'zzz', createdAt },
      { messageId: 'aaa', createdAt },
      { messageId: 'bbb', createdAt },
    ].sort(byNewestFirst).map(entry => entry.messageId ?? entry.callId)).toEqual(['bbb', 'aaa', 'zzz']);
  });

  test('a pending send sorts by its local timestamp, an acknowledged one by the server\'s', () => {
    // While the send is in flight the server has no opinion yet, so the local
    // timestamp is what places the optimistic bubble — below the call it was
    // composed after.
    expect([
      { callId: 'call-late', createdAt: '2026-08-25T17:20:00.000Z' },
      {
        messageId: 'sent-after-call',
        createdAt: '2026-08-25T17:21:00.000Z',
        clientCreatedAt: '2026-08-25T17:21:00.000Z',
        syncState: 'pending',
      },
    ].sort(byNewestFirst).map(entry => entry.messageId ?? entry.callId)).toEqual([
      'sent-after-call',
      'call-late',
    ]);

    // Once acknowledged the server's timestamp wins, even though the device's
    // clock ran a minute fast. Taking the later of the two would have pinned
    // this device's own messages below everything the server considered newer,
    // permanently — and shown the two participants different orders.
    expect([
      { callId: 'call-late', createdAt: '2026-08-25T17:20:00.000Z' },
      {
        messageId: 'sent-after-call',
        createdAt: '2026-08-25T17:10:00.000Z',
        clientCreatedAt: '2026-08-25T17:21:00.000Z',
        syncState: 'synced',
      },
    ].sort(byNewestFirst).map(entry => entry.messageId ?? entry.callId)).toEqual([
      'call-late',
      'sent-after-call',
    ]);
  });

  test('an acknowledged send falls back to its local timestamp when the server has none', () => {
    expect([
      { callId: 'call-late', createdAt: '2026-08-25T17:20:00.000Z' },
      {
        messageId: 'sent-after-call',
        createdAt: undefined,
        clientCreatedAt: '2026-08-25T17:21:00.000Z',
        syncState: 'synced',
      },
    ].sort(byNewestFirst).map(entry => entry.messageId ?? entry.callId)).toEqual([
      'sent-after-call',
      'call-late',
    ]);
  });

  test('Postgres-shaped timestamps order by their instant, not their text', () => {
    // A message's `createdAt` reaches the client from a string-mode Postgres
    // column, a call's from `toISOString`. Compared as text the space
    // separator sorts before `T`, which put every call above every message
    // from the same day.
    expect([
      { messageId: 'message-newer', createdAt: '2026-08-25 17:25:00.5+00' },
      { callId: 'call-older', createdAt: '2026-08-25T17:20:00.000Z' },
    ].sort(byNewestFirst).map(entry => entry.messageId ?? entry.callId)).toEqual([
      'message-newer',
      'call-older',
    ]);
  });
});

describe('createMessageId', () => {
  test('is unique, so the server upsert cannot collide two sends', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createMessageId()));
    expect(ids.size).toBe(100);
  });

  test('falls back to a UUID-shaped id where the runtime has no randomUUID', () => {
    const crypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try {
      expect(createMessageId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: crypto, configurable: true });
    }
  });
});
