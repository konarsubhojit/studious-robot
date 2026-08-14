import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ChatConversationScreen from '../../src/components/ChatConversationScreen';

jest.mock('../../src/components/IconButton', () => (props) =>
  require('react').createElement('IconButton', props),
);

function findByTestId(tree, testID) {
  return tree.root.findAll((node) => node.props?.testID === testID)[0] ?? null;
}

function findAllByTestId(tree, testID) {
  return tree.root.findAll(
    (node) => node.props?.testID === testID && typeof node.type === 'string',
  );
}

function makeMessage(overrides = {}) {
  return {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    senderId: 'user-bob',
    recipientId: 'user-alice',
    body: 'Hello!',
    createdAt: new Date().toISOString(),
    deliveredTo: [],
    readAt: null,
    ...overrides,
  };
}

function render(props) {
  let tree;
  act(() => {
    tree = renderer.create(<ChatConversationScreen {...props} />);
  });
  return tree;
}

describe('ChatConversationScreen', () => {
  // VirtualizedList (used internally by FlatList) schedules a setTimeout to
  // recompute which cells to render; flush it under fake timers so it never
  // fires an unwrapped setState after the test/render has finished.
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  test('renders the header with peerId and presence', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      peerPresence: { online: true },
    });

    const header = tree.root.findAll((n) => n.props?.children === 'user-bob');
    expect(header.length).toBeGreaterThan(0);
  });

  test('renders one message row per message, newest at the bottom', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({ messageId: 'm2', body: 'second (newest)' }),
        makeMessage({ messageId: 'm1', body: 'first (oldest)' }),
      ],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    const list = findByTestId(tree, 'chat-message-list');
    expect(list.props.data.map((m) => m.messageId)).toEqual(['m1', 'm2']);
  });

  test('back button calls onBack', () => {
    const onBack = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack,
      currentUserId: 'user-alice',
    });
    const back = findByTestId(tree, 'chat-back');
    act(() => {
      back.props.onPress();
    });
    expect(onBack).toHaveBeenCalled();
  });

  test('audio/video call buttons only render when handlers are provided', () => {
    const withoutHandlers = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    expect(findByTestId(withoutHandlers, 'chat-call-audio')).toBeNull();
    expect(findByTestId(withoutHandlers, 'chat-call-video')).toBeNull();

    const onStartAudioCall = jest.fn();
    const onStartVideoCall = jest.fn();
    const withHandlers = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      onStartAudioCall,
      onStartVideoCall,
    });
    act(() => {
      findByTestId(withHandlers, 'chat-call-audio').props.onPress();
    });
    expect(onStartAudioCall).toHaveBeenCalled();
    act(() => {
      findByTestId(withHandlers, 'chat-call-video').props.onPress();
    });
    expect(onStartVideoCall).toHaveBeenCalled();
  });

  test('sending a message calls onSendMessage with trimmed body and clears the input', () => {
    const onSendMessage = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage,
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    const input = findByTestId(tree, 'chat-message-input');
    act(() => {
      input.props.onChangeText('  hi there  ');
    });
    const sendButton = findByTestId(tree, 'chat-message-send');
    act(() => {
      sendButton.props.onPress();
    });
    expect(onSendMessage).toHaveBeenCalledWith('hi there');

    const inputAfter = findByTestId(tree, 'chat-message-input');
    expect(inputAfter.props.value).toBe('');
  });

  test('send button is disabled when the draft is empty/whitespace', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    expect(findByTestId(tree, 'chat-message-send').props.disabled).toBe(true);

    const input = findByTestId(tree, 'chat-message-input');
    act(() => {
      input.props.onChangeText('   ');
    });
    expect(findByTestId(tree, 'chat-message-send').props.disabled).toBe(true);
  });

  test('shows a pending indicator for optimistic messages and a failed/retry indicator for failed ones', () => {
    const onSendMessage = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({ messageId: 'pending-1', senderId: 'user-alice', pending: true }),
        makeMessage({ messageId: 'failed-1', senderId: 'user-alice', body: 'oops', failed: true }),
      ],
      onSendMessage,
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    const rows = findAllByTestId(tree, 'chat-message-row');
    expect(rows).toHaveLength(2);

    const retryLabel = tree.root.findAll(
      (n) => n.props?.accessibilityLabel === 'Retry sending message',
    )[0];
    expect(retryLabel).toBeDefined();
    act(() => {
      retryLabel.props.onPress();
    });
    expect(onSendMessage).toHaveBeenCalledWith('oops');
  });

  test('scrolling to the top calls onLoadOlder', () => {
    const onLoadOlder = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage()],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      onLoadOlder,
    });
    const list = findByTestId(tree, 'chat-message-list');
    act(() => {
      list.props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
    });
    expect(onLoadOlder).toHaveBeenCalled();
  });
});
