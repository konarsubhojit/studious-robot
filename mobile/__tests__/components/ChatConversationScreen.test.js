import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { FlatList, Keyboard, KeyboardAvoidingView } from 'react-native';
import ChatConversationScreen from '../../src/components/ChatConversationScreen';

jest.mock(
  '../../src/components/IconButton',
  () => props => require('react').createElement('IconButton', props),
);

function findByTestId(tree, testID) {
  return tree.root.findAll(node => node.props?.testID === testID)[0] ?? null;
}

function findAllByTestId(tree, testID) {
  return tree.root.findAll(node => node.props?.testID === testID && typeof node.type === 'string');
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

    const header = tree.root.findAll(n => n.props?.children === 'user-bob');
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
    const messageItems = list.props.data.filter(item => item.type === 'message');
    expect(messageItems.map(item => item.message.messageId)).toEqual(['m1', 'm2']);
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
      n => n.props?.accessibilityLabel === 'Retry sending message',
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

  test('inserts a single date separator for messages sent on the same day', () => {
    const today = new Date();
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({ messageId: 'm2', createdAt: today.toISOString() }),
        makeMessage({ messageId: 'm1', createdAt: today.toISOString() }),
      ],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    const list = findByTestId(tree, 'chat-message-list');
    const dateItems = list.props.data.filter(item => item.type === 'date');
    expect(dateItems).toHaveLength(1);
    expect(dateItems[0].label).toBe('Today');
  });

  test('only the last message of a consecutive same-sender group shows a timestamp/tick', () => {
    const now = new Date();
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({ messageId: 'm2', senderId: 'user-alice', createdAt: now.toISOString() }),
        makeMessage({
          messageId: 'm1',
          senderId: 'user-alice',
          createdAt: new Date(now.getTime() - 1000).toISOString(),
        }),
      ],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    const list = findByTestId(tree, 'chat-message-list');
    const messageItems = list.props.data.filter(item => item.type === 'message');
    expect(messageItems.map(item => item.isGroupEnd)).toEqual([false, true]);

    const ticks = findAllByTestId(tree, 'chat-message-tick');
    expect(ticks).toHaveLength(1);
  });

  test('renders a read tick (✓✓) for own read messages and a sent tick (✓) otherwise', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({
          messageId: 'read-1',
          senderId: 'user-alice',
          readAt: new Date().toISOString(),
        }),
      ],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    const tick = findByTestId(tree, 'chat-message-tick');
    expect(tick.props.children).toBe('✓✓');
    expect(tick.props.accessibilityLabel).toBe('Read');
  });

  test('shows a typing indicator in the header when isPeerTyping is true', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      peerPresence: { online: true },
      isPeerTyping: true,
    });
    expect(findByTestId(tree, 'chat-typing-indicator')).not.toBeNull();
  });

  test('renders a presence row with the online/offline label', () => {
    const online = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      peerPresence: { online: true },
    });
    expect(findByTestId(online, 'chat-presence-row')).not.toBeNull();
    expect(online.root.findAll(n => n.props?.children === 'Online').length).toBeGreaterThan(0);

    const offline = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      peerPresence: { online: false },
    });
    expect(findByTestId(offline, 'chat-presence-row')).not.toBeNull();
    expect(offline.root.findAll(n => n.props?.children === 'Offline').length).toBeGreaterThan(0);
  });

  test('composer input applies a focus style when focused and clears it on blur', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    const inputBefore = findByTestId(tree, 'chat-message-input');
    const unfocusedStyle = [].concat(inputBefore.props.style).flat();

    act(() => {
      inputBefore.props.onFocus();
    });
    const inputFocused = findByTestId(tree, 'chat-message-input');
    const focusedStyle = [].concat(inputFocused.props.style).flat();
    expect(focusedStyle).not.toEqual(unfocusedStyle);

    act(() => {
      inputFocused.props.onBlur();
    });
    const inputAfterBlur = findByTestId(tree, 'chat-message-input');
    expect([].concat(inputAfterBlur.props.style).flat()).toEqual(unfocusedStyle);
  });

  test('reports typing state to onTypingChange while composing and after send', () => {
    const onTypingChange = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      onTypingChange,
    });

    const input = findByTestId(tree, 'chat-message-input');
    act(() => {
      input.props.onChangeText('hi');
    });
    expect(onTypingChange).toHaveBeenCalledWith(true);

    onTypingChange.mockClear();
    act(() => {
      findByTestId(tree, 'chat-message-send').props.onPress();
    });
    expect(onTypingChange).toHaveBeenCalledWith(false);
  });

  test('call buttons show a loading state and are disabled while a call is being placed', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      onStartAudioCall: jest.fn(),
      onStartVideoCall: jest.fn(),
      isStartingCall: true,
    });
    expect(findByTestId(tree, 'chat-call-audio').props.loading).toBe(true);
    expect(findByTestId(tree, 'chat-call-audio').props.disabled).toBe(true);
    expect(findByTestId(tree, 'chat-call-video').props.loading).toBe(true);
    expect(findByTestId(tree, 'chat-call-video').props.disabled).toBe(true);
  });

  test('call buttons stay enabled when the peer is known to be offline (presence is a stale snapshot, not a live signal)', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      onStartAudioCall: jest.fn(),
      onStartVideoCall: jest.fn(),
      peerPresence: { online: false },
    });
    expect(findByTestId(tree, 'chat-call-audio').props.disabled).toBe(false);
    expect(findByTestId(tree, 'chat-call-video').props.disabled).toBe(false);
  });

  // ── Keyboard-aware composer / auto-scroll ──────────────────────────────

  test('the message list allows tapping through an open keyboard (keyboardShouldPersistTaps)', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    expect(findByTestId(tree, 'chat-message-list').props.keyboardShouldPersistTaps).toBe('handled');
  });

  test('auto-scrolls to the newest message when it changes (new message sent/received)', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage({ messageId: 'm1' })],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    const flatList = tree.root.findByType(FlatList).instance;
    const scrollSpy = jest.spyOn(flatList, 'scrollToEnd');

    act(() => {
      tree.update(
        <ChatConversationScreen
          peerId="user-bob"
          messages={[makeMessage({ messageId: 'm2' }), makeMessage({ messageId: 'm1' })]}
          onSendMessage={jest.fn()}
          onBack={jest.fn()}
          currentUserId="user-alice"
        />,
      );
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(scrollSpy).toHaveBeenCalled();
  });

  test('does not auto-scroll when older history is paged in (newest message unchanged)', () => {
    const newest = makeMessage({ messageId: 'm2' });
    const tree = render({
      peerId: 'user-bob',
      messages: [newest, makeMessage({ messageId: 'm1' })],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    const flatList = tree.root.findByType(FlatList).instance;
    const scrollSpy = jest.spyOn(flatList, 'scrollToEnd');
    scrollSpy.mockClear();

    act(() => {
      tree.update(
        <ChatConversationScreen
          peerId="user-bob"
          messages={[newest, makeMessage({ messageId: 'm1' }), makeMessage({ messageId: 'm0' })]}
          onSendMessage={jest.fn()}
          onBack={jest.fn()}
          currentUserId="user-alice"
        />,
      );
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  test('scrolls the message list to the bottom when the keyboard opens, so the composer stays visible', () => {
    const addListenerSpy = jest.spyOn(Keyboard, 'addListener');
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage({ messageId: 'm1' })],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    const showListenerCall = addListenerSpy.mock.calls.findLast(
      ([eventName]) => eventName === 'keyboardDidShow' || eventName === 'keyboardWillShow',
    );
    expect(showListenerCall).toBeDefined();
    const [, showListener] = showListenerCall;

    const flatList = tree.root.findByType(FlatList).instance;
    const scrollSpy = jest.spyOn(flatList, 'scrollToEnd');
    scrollSpy.mockClear();

    act(() => {
      showListener({ endCoordinates: { height: 300 } });
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(scrollSpy).toHaveBeenCalled();
  });

  test('unsubscribes the keyboard listener on unmount', () => {
    const addListenerSpy = jest.spyOn(Keyboard, 'addListener');
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    const showListenerCall = addListenerSpy.mock.calls.findLast(
      ([eventName]) => eventName === 'keyboardDidShow' || eventName === 'keyboardWillShow',
    );
    const callIndex = addListenerSpy.mock.calls.indexOf(showListenerCall);
    const subscription = addListenerSpy.mock.results[callIndex].value;
    const removeSpy = jest.spyOn(subscription, 'remove');

    act(() => {
      tree.unmount();
    });

    expect(removeSpy).toHaveBeenCalled();
  });

  test('forwards keyboardVerticalOffset to the KeyboardAvoidingView so the composer clears the keyboard when nested below a safe-area top inset', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      keyboardVerticalOffset: 32,
    });
    expect(tree.root.findByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(32);
  });

  test('defaults keyboardVerticalOffset to 0 when not provided', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    expect(tree.root.findByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(0);
  });

  // ── Scroll-to-bottom FAB ────────────────────────────────────────────────

  test('shows a scroll-to-bottom FAB when a peer message arrives while scrolled up, and hides it on tap', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage({ messageId: 'm1', senderId: 'user-bob' })],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(findByTestId(tree, 'chat-scroll-to-bottom')).toBeNull();

    const list = findByTestId(tree, 'chat-message-list');
    act(() => {
      list.props.onScroll({
        nativeEvent: {
          contentOffset: { y: 200 },
          contentSize: { height: 1000 },
          layoutMeasurement: { height: 500 },
        },
      });
    });

    act(() => {
      tree.update(
        <ChatConversationScreen
          peerId="user-bob"
          messages={[
            makeMessage({ messageId: 'm2', senderId: 'user-bob' }),
            makeMessage({ messageId: 'm1', senderId: 'user-bob' }),
          ]}
          onSendMessage={jest.fn()}
          onBack={jest.fn()}
          currentUserId="user-alice"
        />,
      );
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    const fab = findByTestId(tree, 'chat-scroll-to-bottom');
    expect(fab).not.toBeNull();

    const flatList = tree.root.findByType(FlatList).instance;
    const scrollSpy = jest.spyOn(flatList, 'scrollToEnd');

    act(() => {
      fab.props.onPress();
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(scrollSpy).toHaveBeenCalled();
    expect(findByTestId(tree, 'chat-scroll-to-bottom')).toBeNull();
  });

  test("does not show the scroll-to-bottom FAB when the new message is the current user's own", () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage({ messageId: 'm1', senderId: 'user-bob' })],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    const list = findByTestId(tree, 'chat-message-list');
    act(() => {
      list.props.onScroll({
        nativeEvent: {
          contentOffset: { y: 200 },
          contentSize: { height: 1000 },
          layoutMeasurement: { height: 500 },
        },
      });
    });

    act(() => {
      tree.update(
        <ChatConversationScreen
          peerId="user-bob"
          messages={[
            makeMessage({ messageId: 'm2', senderId: 'user-alice' }),
            makeMessage({ messageId: 'm1', senderId: 'user-bob' }),
          ]}
          onSendMessage={jest.fn()}
          onBack={jest.fn()}
          currentUserId="user-alice"
        />,
      );
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(findByTestId(tree, 'chat-scroll-to-bottom')).toBeNull();
  });

  test('scrolling back near the bottom clears the scroll-to-bottom FAB', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage({ messageId: 'm1', senderId: 'user-bob' })],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    const list = findByTestId(tree, 'chat-message-list');
    act(() => {
      list.props.onScroll({
        nativeEvent: {
          contentOffset: { y: 200 },
          contentSize: { height: 1000 },
          layoutMeasurement: { height: 500 },
        },
      });
    });

    act(() => {
      tree.update(
        <ChatConversationScreen
          peerId="user-bob"
          messages={[
            makeMessage({ messageId: 'm2', senderId: 'user-bob' }),
            makeMessage({ messageId: 'm1', senderId: 'user-bob' }),
          ]}
          onSendMessage={jest.fn()}
          onBack={jest.fn()}
          currentUserId="user-alice"
        />,
      );
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(findByTestId(tree, 'chat-scroll-to-bottom')).not.toBeNull();

    act(() => {
      list.props.onScroll({
        nativeEvent: {
          contentOffset: { y: 490 },
          contentSize: { height: 1000 },
          layoutMeasurement: { height: 500 },
        },
      });
    });

    expect(findByTestId(tree, 'chat-scroll-to-bottom')).toBeNull();
  });
});
