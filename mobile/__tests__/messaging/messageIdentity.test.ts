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
