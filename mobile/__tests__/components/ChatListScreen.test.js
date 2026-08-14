import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ChatListScreen from '../../src/components/ChatListScreen';

function findByTestId(tree, testID) {
  return tree.root.findAll((node) => node.props?.testID === testID)[0] ?? null;
}

function findAllByTestId(tree, testID) {
  return tree.root.findAll(
    (node) => node.props?.testID === testID && typeof node.type === 'string',
  );
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

function render(props) {
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

  test('searching swaps to contact results and tapping a result opens a conversation', async () => {
    jest.useFakeTimers();
    const onOpenConversation = jest.fn();
    const onSearchUsers = jest.fn().mockResolvedValue([
      { userId: 'user-dave', online: true },
    ]);
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
});
