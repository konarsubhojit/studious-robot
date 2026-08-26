import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ChatListScreen from '../../src/components/ChatListScreen';
import { fontScaleCaps } from '../../src/theme';

function findByTestId(tree: any, testID: any) {
  return tree.root.findAll((node: any) => node.props?.testID === testID)[0] ?? null;
}

function findAllByTestId(tree: any, testID: any) {
  return tree.root.findAll((node: any) => node.props?.testID === testID && typeof node.type === 'string');
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

function render(props: any) {
  let tree: any;
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

  test('long-pressing a conversation opens the person hub', () => {
    const onOpenProfile = jest.fn();
    const tree = render({
      conversations: [makeConversation({ peerId: 'user-carol' })],
      onOpenConversation: jest.fn(),
      onOpenProfile,
    });
    const row = findByTestId(tree, 'chat-list-row');
    act(() => {
      row.props.onLongPress();
    });
    expect(onOpenProfile).toHaveBeenCalledWith('user-carol');
  });

  test('offers exactly one search affordance, and no settings gear', () => {
    const tree = render({
      conversations: [],
      onOpenConversation: jest.fn(),
      onOpenSearch: jest.fn(),
    });

    // The inline "Search contacts" field and the second gear are gone: search
    // happens in one place, and Settings is a tab.
    expect(findByTestId(tree, 'chat-list-search-input')).toBeNull();
    expect(findByTestId(tree, 'chat-list-open-settings')).toBeNull();
    expect(findByTestId(tree, 'chat-list-open-search')).not.toBeNull();
  });

  test('the search action is omitted when there is nowhere to search', () => {
    const tree = render({ conversations: [], onOpenConversation: jest.fn() });
    expect(findByTestId(tree, 'chat-list-open-search')).toBeNull();
  });

  test('the new-chat FAB opens the people picker', () => {
    const tree = render({
      conversations: [makeConversation()],
      onOpenConversation: jest.fn(),
      onSearchUsers: jest.fn().mockResolvedValue([]),
    });

    const picker = () =>
      tree.root.findAll(
        (n: any) => n.props?.testID === 'chat-list-people-picker' && typeof n.type === 'function',
      )[0];
    expect(picker().props.visible).toBe(false);

    const fab = tree.root.findAll(
      (n: any) => n.props?.testID === 'chat-list-new-chat' && typeof n.props?.onPress === 'function',
    )[0];
    act(() => {
      fab.props.onPress();
    });
    expect(picker().props.visible).toBe(true);
  });

  test('picking someone from the picker starts a chat with them', () => {
    const onStartChat = jest.fn();
    const tree = render({
      conversations: [],
      onOpenConversation: jest.fn(),
      onSearchUsers: jest.fn().mockResolvedValue([]),
      onStartChat,
    });

    const picker = tree.root.findAll(
      (n: any) => n.props?.testID === 'chat-list-people-picker' && typeof n.type === 'function',
    )[0];
    act(() => {
      picker.props.onSelect('user-dave');
    });
    expect(onStartChat).toHaveBeenCalledWith('user-dave');
  });

  test('the first-run empty state leads into the people picker', () => {
    const tree = render({
      conversations: [],
      onOpenConversation: jest.fn(),
      onSearchUsers: jest.fn().mockResolvedValue([]),
    });

    const empty = tree.root.findAll(
      (n: any) => n.props?.testID === 'chat-list-empty' && typeof n.type === 'function',
    )[0];
    expect(empty.props.actionLabel).toBe('Find someone');

    act(() => {
      empty.props.onAction();
    });

    const picker = tree.root.findAll(
      (n: any) => n.props?.testID === 'chat-list-people-picker' && typeof n.type === 'function',
    )[0];
    expect(picker.props.visible).toBe(true);
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

  /**
   * A conversation row's title and preview are free to grow — they are the
   * content. The trailing timestamp is the fixed-shape column beside them, and
   * is the only text on the row that is capped.
   */
  describe('dynamic type', () => {
    function capsOf(tree: any) {
      return tree.root
        .findAll((n: any) => n.type === 'Text')
        .map((n: any) => n.props.maxFontSizeMultiplier)
        .filter((cap: unknown) => cap !== undefined);
    }

    test('caps the row timestamp beside the growing title', () => {
      const tree = render({
        conversations: [makeConversation()],
        onOpenConversation: jest.fn(),
      });

      expect(capsOf(tree)).toContain(fontScaleCaps.meta);
    });

    test('leaves the title and the preview uncapped: they are the row', () => {
      const tree = render({
        conversations: [makeConversation({ peerId: 'user-bob' })],
        onOpenConversation: jest.fn(),
      });

      const running = tree.root.findAll(
        (n: any) =>
          n.type === 'Text' && (n.props?.children === 'user-bob' || n.props?.children === 'Hey there!'),
      );
      expect(running.length).toBe(2);
      running.forEach((node: any) => expect(node.props.maxFontSizeMultiplier).toBeUndefined());
    });
  });
});
