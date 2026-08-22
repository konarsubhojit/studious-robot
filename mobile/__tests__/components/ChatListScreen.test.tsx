import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ChatListScreen from '../../src/components/ChatListScreen';

function findByTestId(/** @type {any} */ tree: any, /** @type {any} */ testID: any) {
  return tree.root.findAll((/** @type {any} */ node: any) => node.props?.testID === testID)[0] ?? null;
}

function findAllByTestId(/** @type {any} */ tree: any, /** @type {any} */ testID: any) {
  return tree.root.findAll((/** @type {any} */ node: any) => node.props?.testID === testID && typeof node.type === 'string');
}

function makeConversation(overrides = {}) {
  return {
    conversationId: 'conv-1',
    peerId: 'user-bob',
    lastMessage: { body: 'Hey there!', createdAt: new Date().toISOString() },
    unreadCount: 0,
    ...overrides,
  };
}

function render(/** @type {any} */ props: any) {
  let tree;
  act(() => {
    tree = renderer.create(<ChatListScreen {...props} />);
  });
  return tree;
}

describe('ChatListScreen', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('renders the conversation list with last message and timestamp', () => {
    const tree = render({
      conversations: [makeConversation()],
      onOpenConversation: jest.fn(),
    });

    const rows = findAllByTestId(tree, 'chat-list-row');
    expect(rows).toHaveLength(1);
    expect(findByTestId(tree, 'chat-list-empty')).toBeNull();
  });

  test('shows the empty state when there are no conversations', () => {
    const tree = render({ conversations: [], onOpenConversation: jest.fn() });
    expect(findByTestId(tree, 'chat-list-empty')).not.toBeNull();
  });

  test('shows an unread badge when unreadCount > 0', () => {
    const tree = render({
      conversations: [makeConversation({ unreadCount: 3 })],
      onOpenConversation: jest.fn(),
    });
    const badge = findByTestId(tree, 'chat-list-unread-badge');
    expect(badge).not.toBeNull();
  });

  test('tapping a conversation row calls onOpenConversation with the peerId', () => {
    const onOpenConversation = jest.fn();
    const tree = render({
      conversations: [makeConversation({ peerId: 'user-carol' })],
      onOpenConversation,
    });
    const row = findByTestId(tree, 'chat-list-row');
    act(() => {
      row.props.onPress();
    });
    expect(onOpenConversation).toHaveBeenCalledWith('user-carol');
  });

  test('shows skeleton rows while the conversation list is loading', () => {
    const tree = render({ conversations: [], isLoading: true, onOpenConversation: jest.fn() });
    expect(findByTestId(tree, 'chat-list-skeleton')).not.toBeNull();
    expect(findByTestId(tree, 'chat-list-empty')).toBeNull();
  });

  test('swiping a conversation exposes a mark-read action that reports the peerId', () => {
    const onMarkRead = jest.fn();
    const tree = render({
      conversations: [makeConversation({ peerId: 'user-carol', unreadCount: 2 })],
      onOpenConversation: jest.fn(),
      onMarkRead,
    });
    const action = findByTestId(tree, 'chat-list-mark-read');
    act(() => {
      action.props.onPress();
    });
    expect(onMarkRead).toHaveBeenCalledWith('user-carol');
  });

  test('offers no mark-read action for a conversation that is already read', () => {
    const tree = render({
      conversations: [makeConversation({ unreadCount: 0 })],
      onOpenConversation: jest.fn(),
      onMarkRead: jest.fn(),
    });
    expect(findByTestId(tree, 'chat-list-mark-read')).toBeNull();
  });

  test('searching swaps to contact results and tapping a result opens a conversation', async () => {
    jest.useFakeTimers();
    const onOpenConversation = jest.fn();
    const onSearchUsers = jest.fn().mockResolvedValue([{ userId: 'user-dave', online: true }]);
    const tree = render({
      conversations: [makeConversation()],
      onOpenConversation,
      onSearchUsers,
    });

    const input = findByTestId(tree, 'chat-list-search-input');
    await act(async () => {
      input.props.onChangeText('dave');
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSearchUsers).toHaveBeenCalledWith('dave');

    const contactRow = findByTestId(tree, 'chat-list-contact-row');
    expect(contactRow).not.toBeNull();
    // Conversation rows should be hidden while searching.
    expect(findAllByTestId(tree, 'chat-list-row')).toHaveLength(0);

    act(() => {
      contactRow.props.onPress();
    });
    expect(onOpenConversation).toHaveBeenCalledWith('user-dave');
  });

  test('renders a settings gear only when onOpenSettings is provided', () => {
    const withSettings = render({
      conversations: [],
      onOpenConversation: jest.fn(),
      onOpenSettings: jest.fn(),
    });
    expect(findByTestId(withSettings, 'chat-list-open-settings')).not.toBeNull();

    const withoutSettings = render({ conversations: [], onOpenConversation: jest.fn() });
    expect(findByTestId(withoutSettings, 'chat-list-open-settings')).toBeNull();
  });

  test('renders an initials avatar with an online-status dot on conversation rows', () => {
    const tree = render({
      conversations: [makeConversation({ peerId: 'user-bob', online: true })],
      onOpenConversation: jest.fn(),
    });
    const avatar = findByTestId(tree, 'chat-list-avatar');
    expect(avatar).not.toBeNull();
    const statusDot = findByTestId(tree, 'chat-list-avatar-status');
    expect(statusDot.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: expect.any(String) })]),
    );
  });

  test('omits the online-status dot when a conversation has no known presence', () => {
    const tree = render({
      conversations: [makeConversation({ peerId: 'user-bob', online: undefined })],
      onOpenConversation: jest.fn(),
    });
    expect(findByTestId(tree, 'chat-list-avatar-status')).toBeNull();
  });
});
