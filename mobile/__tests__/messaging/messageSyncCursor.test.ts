import { advanceSocketMessageCursor } from '../../src/messaging/messageSyncCursor';

test('advances a socket watermark by message time and id', () => {
  const current = { messageCreatedAt: '2026-10-03T07:00:00.000Z', messageId: 'm-2' };
  expect(advanceSocketMessageCursor(current, {
    createdAt: '2026-10-03T07:00:00.000Z', messageId: 'm-1',
  })).toBe(current);
  expect(advanceSocketMessageCursor(current, {
    createdAt: '2026-10-03T07:00:00.000Z', messageId: 'm-3',
  })).toEqual({ messageCreatedAt: '2026-10-03T07:00:00.000Z', messageId: 'm-3' });
  expect(advanceSocketMessageCursor(current, {
    createdAt: '2026-10-03T06:59:59.000Z', messageId: 'older',
  })).toBe(current);
});

test('does not create a socket watermark without a usable message timestamp', () => {
  expect(advanceSocketMessageCursor(undefined, { messageId: 'm-1' }))
    .toBeUndefined();
  expect(advanceSocketMessageCursor(undefined, {
    messageId: 'm-1', createdAt: 'not-a-timestamp',
  })).toBeUndefined();
});

test('canonicalizes the message timestamp stored in the local watermark', () => {
  expect(advanceSocketMessageCursor(undefined, {
    messageId: 'm-1', createdAt: '2026-10-03 07:00:00+00',
  })).toEqual({ messageCreatedAt: '2026-10-03T07:00:00.000Z', messageId: 'm-1' });
});
