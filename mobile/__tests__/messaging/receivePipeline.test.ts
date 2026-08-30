import {
  applyDeliveryReceipt,
  applyIncomingMessage,
  applyReactions,
  applyReadReceipt,
  applyTombstone,
  tombstoneOf,
} from '../../src/messaging/receivePipeline';

/**
 * The receive pipeline's pure half. Every case here also asserts the identity
 * contract: an event that changes nothing must return the state it was given,
 * or the conversation re-renders on every duplicate receipt.
 */

const message = (overrides: any = {}): any => ({
  messageId: 'm1',
  senderId: 'bob',
  recipientId: 'alice',
  body: 'hi',
  createdAt: '2026-08-25T10:30:00.000Z',
  reactions: {},
  deletedAt: null,
  ...overrides,
});

describe('applyIncomingMessage', () => {
  test('an inbound message is prepended to its sender history as synced', () => {
    const next = applyIncomingMessage({}, message());
    expect(next.bob).toHaveLength(1);
    expect(next.bob[0]).toMatchObject({ messageId: 'm1', syncState: 'synced' });
  });

  test('the same message over both the socket and a push converges on one entry', () => {
    const state = { bob: [message({ syncState: 'synced' })] };
    expect(applyIncomingMessage(state, message())).toBe(state);
  });
});

describe('applyDeliveryReceipt', () => {
  test('a receipt for a held message merges the server copy in', () => {
    const state = { bob: [message({ senderId: 'alice', recipientId: 'bob' })] };
    const next = applyDeliveryReceipt(
      state,
      message({ senderId: 'alice', recipientId: 'bob', deliveredTo: ['bob'] }),
    );
    expect(next.bob[0].deliveredTo).toEqual(['bob']);
  });

  test('a receipt that arrives before the send ack still lands in the history', () => {
    const next = applyDeliveryReceipt({}, message({ senderId: 'alice', recipientId: 'bob' }));
    expect(next.bob).toHaveLength(1);
  });
});

describe('applyReadReceipt', () => {
  const args = { readerId: 'bob', readAt: '2026-08-25T11:00:00.000Z', currentUserId: 'alice' };

  test('only this user\'s unread messages to that peer are stamped', () => {
    const state = {
      bob: [
        message({ messageId: 'mine', senderId: 'alice', recipientId: 'bob' }),
        message({ messageId: 'theirs' }),
      ],
    };
    const next = applyReadReceipt(state, args);
    expect(next.bob[0].readAt).toBe('2026-08-25T11:00:00.000Z');
    expect(next.bob[1].readAt).toBeUndefined();
  });

  test('a repeated receipt changes nothing', () => {
    const state = {
      bob: [message({ senderId: 'alice', recipientId: 'bob', readAt: '2026-08-25T11:00:00.000Z' })],
    };
    expect(applyReadReceipt(state, args)).toBe(state);
  });

  test('a receipt for an unloaded conversation is a no-op', () => {
    const state = {};
    expect(applyReadReceipt(state, args)).toBe(state);
  });
});

describe('tombstones', () => {
  test('a deleted message keeps its row but loses its content', () => {
    const stone = tombstoneOf(message({ body: 'secret', attachment: { url: 'x' } }));
    expect(stone).toMatchObject({ body: '', attachment: null, reactions: {} });
    expect(stone.deletedAt).toEqual(expect.any(String));
  });

  test('the server tombstone wins when it sends one', () => {
    const stone = tombstoneOf(message(), { deletedAt: '2026-08-25T12:00:00.000Z' });
    expect(stone.deletedAt).toBe('2026-08-25T12:00:00.000Z');
  });

  test('a deletion is applied without knowing which conversation it is in', () => {
    const state = { bob: [message({ body: 'secret' })], carol: [message({ messageId: 'm2' })] };
    const next = applyTombstone(state, 'm1');
    expect(next.bob[0].body).toBe('');
    expect(next.carol[0].body).toBe('hi');
  });

  test('a deletion for an unknown message changes nothing', () => {
    const state = { bob: [message()] };
    expect(applyTombstone(state, 'nope')).toBe(state);
  });
});

describe('applyReactions', () => {
  test('the server reaction set replaces whatever was held', () => {
    const state = { bob: [message({ reactions: { '👍': ['alice'] } })] };
    const next = applyReactions(state, 'm1', { '🎉': ['bob'] });
    expect(next.bob[0].reactions).toEqual({ '🎉': ['bob'] });
  });

  test('a reaction for an unknown message changes nothing', () => {
    const state = { bob: [message()] };
    expect(applyReactions(state, 'nope', { '🎉': ['bob'] })).toBe(state);
  });
});
