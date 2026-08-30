import {
  conversationIdForPeer,
  totalUnread,
  withConversationRead,
  withIncomingMessage,
} from '../../src/messaging/conversations';
import { withDraft, withoutDraft } from '../../src/messaging/drafts';

/**
 * The conversation list's unread accounting and the per-conversation drafts,
 * both exercised without mounting `useMessaging`.
 */

const conversation = (overrides: any = {}): any => ({
  conversationId: 'conv-1',
  peerId: 'bob',
  unreadCount: 0,
  ...overrides,
});

describe('unread accounting', () => {
  test('the badge is the sum of every conversation unread count', () => {
    expect(
      totalUnread([
        conversation({ unreadCount: 2 }),
        conversation({ peerId: 'carol', unreadCount: 3 }),
        conversation({ peerId: 'dave', unreadCount: undefined }),
      ]),
    ).toBe(5);
  });

  test('an inbound message becomes the row newest activity and bumps its count', () => {
    const next = withIncomingMessage(
      [conversation({ unreadCount: 1 })],
      { messageId: 'm1', senderId: 'bob', body: 'hi' } as any,
    );
    expect(next?.[0]).toMatchObject({
      unreadCount: 2,
      lastMessage: { messageId: 'm1' },
      lastActivity: { messageId: 'm1', type: 'text' },
    });
  });

  test('a message from an unknown peer forces a refetch rather than an invented row', () => {
    expect(withIncomingMessage([conversation()], { senderId: 'carol' } as any)).toBeNull();
  });

  test('marking a conversation read zeroes only its own badge', () => {
    const next = withConversationRead(
      [conversation({ unreadCount: 4 }), conversation({ peerId: 'carol', unreadCount: 7 })],
      'bob',
    );
    expect(next.map(c => c.unreadCount)).toEqual([0, 7]);
  });

  test('a peer with no conversation yet has no conversation id', () => {
    expect(conversationIdForPeer([conversation()], 'bob')).toBe('conv-1');
    expect(conversationIdForPeer([conversation()], 'carol')).toBeNull();
  });
});

describe('drafts', () => {
  const now = () => '2026-08-25T10:30:00.000Z';

  test('a draft records the typed text and the reply target', () => {
    expect(withDraft({}, 'bob', 'half a thought', 'm1', now)).toEqual({
      bob: { text: 'half a thought', replyToId: 'm1', updatedAt: '2026-08-25T10:30:00.000Z' },
    });
  });

  test('an emptied composer removes the draft instead of leaving a marker', () => {
    const drafts = withDraft({}, 'bob', 'typing', null, now);
    expect(withDraft(drafts, 'bob', '   ', null, now)).toEqual({});
  });

  test('re-saving an unchanged draft returns the same map', () => {
    const drafts = withDraft({}, 'bob', 'typing', 'm1', now);
    expect(withDraft(drafts, 'bob', 'typing', 'm1', now)).toBe(drafts);
  });

  test('changing only the reply target still records a new draft', () => {
    const drafts = withDraft({}, 'bob', 'typing', null, now);
    expect(withDraft(drafts, 'bob', 'typing', 'm2', now).bob.replyToId).toBe('m2');
  });

  test('clearing a conversation with no draft returns the same map', () => {
    const drafts = withDraft({}, 'bob', 'typing', null, now);
    expect(withoutDraft(drafts, 'carol')).toBe(drafts);
    expect(withoutDraft(drafts, 'bob')).toEqual({});
  });
});
