import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, FlatList, Keyboard, KeyboardAvoidingView } from 'react-native';
import ChatConversationScreen, {
  findUnreadAnchorKey,
} from '../../src/components/ChatConversationScreen';
import { announceForAccessibility } from '../../src/accessibilityAnnouncer';

jest.mock('../../src/accessibilityAnnouncer', () => ({
  ...jest.requireActual('../../src/accessibilityAnnouncer'),
  announceForAccessibility: jest.fn(),
}));

jest.mock(
  '../../src/components/IconButton',
  () => (props: any) => require('react').createElement('IconButton', props),
);

function findByTestId(tree: any, testID: any) {
  return tree.root.findAll((node: any) => node.props?.testID === testID)[0] ?? null;
}

function findAllByTestId(tree: any, testID: any) {
  return tree.root.findAll((node: any) => node.props?.testID === testID && typeof node.type === 'string');
}

/**
 * Performs the message row's long press the way assistive technology does:
 * through the `longpress` accessibility action the swipeable row publishes.
 * The gesture itself is native, so there is no touch stream to drive here.
 */
function longPressRow(tree: any) {
  const row = tree.root.findAll(
    (node: any) =>
      typeof node.type === 'string' &&
      node.props?.accessibilityActions?.some((action: any) => action.name === 'longpress'),
  )[0];
  if (!row) throw new Error('no row exposes a longpress accessibility action');
  row.props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } });
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

function render(props: any) {
  let tree: any;
  act(() => {
    tree = renderer.create(<ChatConversationScreen {...props} />);
  });
  mountedTrees.push(tree);
  return tree;
}

const mountedTrees: any[] = [];
function unmountRenderedTrees() {
  mountedTrees.splice(0).forEach(tree => tree.unmount());
}

afterEach(() => {
  act(() => {
    unmountRenderedTrees();
  });
});

describe('ChatConversationScreen', () => {
  // VirtualizedList (used internally by FlatList) schedules a setTimeout to
  // recompute which cells to render; flush it under fake timers so it never
  // fires an unwrapped setState after the test/render has finished.
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      unmountRenderedTrees();
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

    const header = tree.root.findAll((n: any) => n.props?.children === 'user-bob');
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
    const messageItems = list.props.data.filter((item: any) => item.type === 'message');
    expect(messageItems.map((item: any) => item.message.messageId)).toEqual(['m1', 'm2']);
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
    expect(onSendMessage).toHaveBeenCalledWith('hi there', { replyTo: null });

    const inputAfter = findByTestId(tree, 'chat-message-input');
    expect(inputAfter.props.value).toBe('');
  });

  // Rapid-fire sending: the change event for the text being sent can still be
  // crossing the bridge when the send fires, so it lands after the composer was
  // cleared and carries the sent text. Accepting it re-filled the box, and the
  // next send appended to that — the composer grew instead of resetting.
  test('a change event echoing the text just sent does not refill the composer', () => {
    const onSendMessage = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage,
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    act(() => {
      findByTestId(tree, 'chat-message-input').props.onChangeText('first');
    });
    act(() => {
      findByTestId(tree, 'chat-message-send').props.onPress();
    });
    // The in-flight keystroke, delivered late.
    act(() => {
      findByTestId(tree, 'chat-message-input').props.onChangeText('first');
    });

    expect(findByTestId(tree, 'chat-message-input').props.value).toBe('');
    expect(findByTestId(tree, 'chat-message-send').props.disabled).toBe(true);
    expect(onSendMessage).toHaveBeenCalledTimes(1);
  });

  test('typing resumes normally after the stale echo is dropped', () => {
    const onSendMessage = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage,
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    act(() => {
      findByTestId(tree, 'chat-message-input').props.onChangeText('first');
    });
    act(() => {
      findByTestId(tree, 'chat-message-send').props.onPress();
    });
    act(() => {
      findByTestId(tree, 'chat-message-input').props.onChangeText('first');
    });
    act(() => {
      findByTestId(tree, 'chat-message-input').props.onChangeText('second');
    });
    act(() => {
      findByTestId(tree, 'chat-message-send').props.onPress();
    });

    expect(onSendMessage).toHaveBeenNthCalledWith(2, 'second', { replyTo: null });
    expect(findByTestId(tree, 'chat-message-input').props.value).toBe('');
  });

  // Only the echo of the *last* send is dropped, so deliberately sending the
  // same word twice in a row still goes through twice.
  test('retyping the same message after a send still sends it', () => {
    const onSendMessage = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage,
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    act(() => {
      findByTestId(tree, 'chat-message-input').props.onChangeText('ok');
    });
    act(() => {
      findByTestId(tree, 'chat-message-send').props.onPress();
    });
    // First 'ok' after the send is the stale echo; the second is real typing.
    act(() => {
      findByTestId(tree, 'chat-message-input').props.onChangeText('ok');
    });
    act(() => {
      findByTestId(tree, 'chat-message-input').props.onChangeText('ok');
    });
    act(() => {
      findByTestId(tree, 'chat-message-send').props.onPress();
    });

    expect(onSendMessage).toHaveBeenCalledTimes(2);
    expect(onSendMessage).toHaveBeenNthCalledWith(2, 'ok', { replyTo: null });
  });

  test('two send taps in the same frame send the message once', () => {
    const onSendMessage = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage,
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    act(() => {
      findByTestId(tree, 'chat-message-input').props.onChangeText('once');
    });
    const sendButton = findByTestId(tree, 'chat-message-send');
    act(() => {
      sendButton.props.onPress();
      sendButton.props.onPress();
    });

    expect(onSendMessage).toHaveBeenCalledTimes(1);
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
      (n: any) => n.props?.accessibilityLabel === 'Retry sending message',
    )[0];
    expect(retryLabel).toBeDefined();
    act(() => {
      retryLabel.props.onPress();
    });
    expect(onSendMessage).toHaveBeenCalledWith('oops');

    // Retry is not wired to the bubble itself: a touch handler spanning the
    // whole drag surface is the same class of conflict a `Pressable` used to
    // cause with `SwipeableRow`'s pan, so the footer's "tap to retry" control
    // is the only retry affordance. The bubble still carries the failure in
    // its accessibility label for context, but nothing on it is tappable.
    const failedBubble = tree.root.findAll(
      (n: any) =>
        n.props?.testID === 'chat-message-bubble' &&
        typeof n.props?.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.includes('Failed to send'),
    )[0];
    expect(failedBubble.props.onTouchEnd).toBeUndefined();
    expect(failedBubble.props.onAccessibilityTap).toBeUndefined();

    // The footer's `DeliveryState` control is the one remaining retry
    // affordance, so it must still actually retry.
    act(() => {
      findByTestId(tree, 'chat-message-failed').props.onPress();
    });
    expect(onSendMessage).toHaveBeenCalledTimes(2);
  });

  test('every delivery state renders in the same footer slot', () => {
    // Ticks used to appear only at the end of a group, while "Sending…" and
    // "Failed to send" hung below the bubble in two other places, so a message
    // changed shape as it progressed.
    const footerOf = (message: any) => {
      const tree = render({
        peerId: 'user-bob',
        messages: [message],
        onSendMessage: jest.fn(),
        onBack: jest.fn(),
        currentUserId: 'user-alice',
      });
      return ['chat-message-pending', 'chat-message-failed', 'chat-message-tick'].filter(
        id => findByTestId(tree, id) !== null,
      );
    };

    expect(footerOf(makeMessage({ senderId: 'user-alice', pending: true }))).toEqual([
      'chat-message-pending',
    ]);
    expect(footerOf(makeMessage({ senderId: 'user-alice', failed: true }))).toEqual([
      'chat-message-failed',
    ]);
    expect(footerOf(makeMessage({ senderId: 'user-alice' }))).toEqual(['chat-message-tick']);
  });

  test("a pending message says 'Queued' rather than 'Sending…' while offline", () => {
    const pending = makeMessage({ senderId: 'user-alice', pending: true });
    const props = {
      peerId: 'user-bob',
      messages: [pending],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    };

    expect(findByTestId(render(props), 'chat-message-pending').props.children).toBe('Sending…');
    expect(
      findByTestId(render({ ...props, isOffline: true }), 'chat-message-pending').props.children,
    ).toBe('Queued');
  });

  test("a peer's message never shows a delivery state — it isn't ours to report", () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage({ senderId: 'user-bob' })],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    expect(findByTestId(tree, 'chat-message-tick')).toBeNull();
    expect(findByTestId(tree, 'chat-message-pending')).toBeNull();
  });

  test('swiping an own message exposes delete, and retry for failed sends', () => {
    const onDeleteMessage = jest.fn();
    const onRetryMessage = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((title, message, buttons) => {
      buttons?.find(button => button.style === 'destructive')?.onPress?.();
    });
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({ messageId: 'failed-1', senderId: 'user-alice', failed: true }),
        makeMessage({ messageId: 'theirs-1', senderId: 'user-bob' }),
      ],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      onDeleteMessage,
      onRetryMessage,
    });

    // Only the user's own message gets swipe actions.
    const deleteActions = findAllByTestId(tree, 'chat-message-swipe-delete');
    expect(deleteActions).toHaveLength(1);

    act(() => {
      findByTestId(tree, 'chat-message-swipe-delete').props.onPress();
    });
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(onDeleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'failed-1' }),
    );
    alertSpy.mockRestore();

    act(() => {
      findByTestId(tree, 'chat-message-swipe-retry').props.onPress();
    });
    expect(onRetryMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'failed-1' }));
  });

  test('shows the offline notice only while offline', () => {
    const props = {
      peerId: 'user-bob',
      messages: [makeMessage()],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    };

    const online = render(props);
    expect(findByTestId(online, 'chat-offline-notice')).toBeNull();

    // Offline is now one of the four notices in the stack above the composer,
    // in the same geometry as the rest, rather than a `StatusBanner` wedged
    // between the header and the list.
    const offline = render({ ...props, isOffline: true });
    const notice = findByTestId(offline, 'chat-offline-notice');
    const text = notice.findAll((n: any) => typeof n.props?.children === 'string');
    expect(text.some((n: any) => n.props.children.includes('Offline'))).toBe(true);
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
    const dateItems = list.props.data.filter((item: any) => item.type === 'date');
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
    const messageItems = list.props.data.filter((item: any) => item.type === 'message');
    expect(messageItems.map((item: any) => item.isGroupEnd)).toEqual([false, true]);

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

  test('renders a delivered tick (✓✓) for own messages the recipient received', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({
          messageId: 'delivered-1',
          senderId: 'user-alice',
          recipientId: 'user-bob',
          deliveredTo: ['user-bob'],
        }),
      ],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    const tick = findByTestId(tree, 'chat-message-tick');
    expect(tick.props.children).toBe('✓✓');
    expect(tick.props.accessibilityLabel).toBe('Delivered');
  });

  test('shows skeleton bubbles while the first page of history loads', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      isLoadingMessages: true,
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    expect(findByTestId(tree, 'chat-message-skeleton')).not.toBeNull();
  });

  test('does not show skeleton bubbles once messages have loaded', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage()],
      isLoadingMessages: false,
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    expect(findByTestId(tree, 'chat-message-skeleton')).toBeNull();
  });

  test('pins the date of the topmost visible message as a sticky separator', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage()],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    const list = findByTestId(tree, 'chat-message-list');
    const messageItem = list.props.data.find((item: any) => item.type === 'message');
    expect(findByTestId(tree, 'chat-sticky-date')).toBeNull();

    act(() => {
      list.props.onViewableItemsChanged({ viewableItems: [{ item: messageItem }] });
    });
    const sticky = findByTestId(tree, 'chat-sticky-date');
    expect(sticky).not.toBeNull();
    expect(messageItem.dateLabel).toBe('Today');
  });

  test('caps how many message cells the list mounts at once', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: Array.from({ length: 50 }, (_unused, index) =>
        makeMessage({ messageId: `msg-${index}` }),
      ),
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });
    const list = findByTestId(tree, 'chat-message-list');
    expect(list.props.initialNumToRender).toBeLessThan(50);
    // removeClippedSubviews is deliberately omitted — on Android it clips by
    // layout bounds and ignores transform, breaking SwipeableRow action trays.
    expect(list.props.removeClippedSubviews).toBeUndefined();
    expect(findAllByTestId(tree, 'chat-message-row').length).toBeLessThan(50);
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
    expect(online.root.findAll((n: any) => n.props?.children === 'Online').length).toBeGreaterThan(0);

    const offline = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      peerPresence: { online: false },
    });
    expect(findByTestId(offline, 'chat-presence-row')).not.toBeNull();
    expect(offline.root.findAll((n: any) => n.props?.children === 'Offline').length).toBeGreaterThan(0);
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
    const unfocusedStyle = ([] as any[]).concat(inputBefore.props.style).flat();

    act(() => {
      inputBefore.props.onFocus();
    });
    const inputFocused = findByTestId(tree, 'chat-message-input');
    const focusedStyle = ([] as any[]).concat(inputFocused.props.style).flat();
    expect(focusedStyle).not.toEqual(unfocusedStyle);

    act(() => {
      inputFocused.props.onBlur();
    });
    const inputAfterBlur = findByTestId(tree, 'chat-message-input');
    expect(([] as any[]).concat(inputAfterBlur.props.style).flat()).toEqual(unfocusedStyle);
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
    const [, showListener] = (showListenerCall as any[]);

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
    const callIndex = addListenerSpy.mock.calls.indexOf((showListenerCall as any));
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

  test('renders call records inline in the timeline', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({ messageId: 'm2', body: 'after', type: 'text' }),
        {
          type: 'call',
          callId: 'call-1',
          direction: 'incoming',
          status: 'missed',
          durationSeconds: 0,
          createdAt: new Date().toISOString(),
        },
        makeMessage({ messageId: 'm1', body: 'before', type: 'text' }),
      ],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    expect(findAllByTestId(tree, 'chat-message-row')).toHaveLength(2);
    const callRow = findByTestId(tree, 'chat-call-entry');
    expect(callRow).not.toBeNull();
    expect(callRow.props.accessibilityLabel).toBe('Missed call');
  });

  test('collapses consecutive calls with the same outcome into one row', () => {
    const createdAt = new Date();
    const makeCall = (callId: any, offsetMinutes: any) => ({
      type: 'call',
      callId,
      direction: 'incoming',
      status: 'missed',
      durationSeconds: 0,
      createdAt: new Date(createdAt.getTime() - offsetMinutes * 60_000).toISOString(),
    });

    const tree = render({
      peerId: 'user-bob',
      messages: [makeCall('c3', 0), makeCall('c2', 1), makeCall('c1', 2)],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    const rows = findAllByTestId(tree, 'chat-call-timeline-row');
    expect(rows).toHaveLength(1);
    expect(findByTestId(tree, 'chat-call-entry').props.accessibilityLabel).toBe(
      '3 missed calls',
    );
  });
});

describe('ChatConversationScreen deep-linked message', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      unmountRenderedTrees();
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  test('highlights the deep-linked message and scrolls it into view', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage({ messageId: 'msg-1' }), makeMessage({ messageId: 'msg-2' })],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
      highlightMessageId: 'msg-1',
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(findAllByTestId(tree, 'chat-message-highlighted')).toHaveLength(1);
  });

  test('highlights nothing when the message is not in the loaded page', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage({ messageId: 'msg-1' })],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
      highlightMessageId: 'msg-missing',
    });

    expect(findAllByTestId(tree, 'chat-message-highlighted')).toHaveLength(0);
  });

  test('opens the peer profile from the header', () => {
    const onOpenProfile = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
      onOpenProfile,
    });

    act(() => {
      findByTestId(tree, 'chat-open-profile').props.onPress();
    });

    expect(onOpenProfile).toHaveBeenCalled();
  });

  test('renders an image attachment inline', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({
          body: '',
          type: 'image',
          attachment: { url: 'https://media.test/chatblobs/c/p.jpg', mimeType: 'image/jpeg' },
        }),
      ],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
    });

    const image = findByTestId(tree, 'chat-message-image');
    expect(image.props.source).toEqual({ uri: 'https://media.test/chatblobs/c/p.jpg' });
  });

  test('renders an unknown message type as a neutral placeholder', () => {
    const tree = render({
      peerId: 'user-bob',
      // A message written by a newer client: this build must not blank out or
      // crash on it.
      messages: [makeMessage({ body: '', type: 'poll', poll: { question: 'lunch?' } })],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
    });

    expect(findByTestId(tree, 'chat-message-unsupported').props.children).toBe(
      'Unsupported message',
    );
  });

  test('renders a deleted message as a tombstone', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage({ body: '', deletedAt: '2024-01-01T00:00:00.000Z' })],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
    });

    expect(findByTestId(tree, 'chat-message-deleted').props.children).toBe('Message deleted');
  });

  test('a reply quotes the original, and still renders once it is deleted', () => {
    const quoted = makeMessage({ messageId: 'm-original', body: 'the original' });
    const reply = makeMessage({ messageId: 'm-reply', body: 'quoting you', replyTo: 'm-original' });

    const tree = render({
      peerId: 'user-bob',
      messages: [reply, quoted],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
    });
    expect(findByTestId(tree, 'chat-message-quote')).not.toBeNull();

    const withTombstone = render({
      peerId: 'user-bob',
      messages: [reply, { ...quoted, body: '', deletedAt: '2024-01-01T00:00:00.000Z' }],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
    });
    const quote = findByTestId(withTombstone, 'chat-message-quote');
    expect(quote.props.accessibilityLabel).toBe('Replying to: Message deleted');
  });

  test('long-pressing a bubble opens the reaction bar and reports the toggle', () => {
    const onReactToMessage = jest.fn();
    const message = makeMessage({ reactions: {} });
    const tree = render({
      peerId: 'user-bob',
      messages: [message],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
      onReactToMessage,
    });

    expect(findAllByTestId(tree, 'chat-message-reaction-bar')).toHaveLength(0);
    // The long press belongs to the swipeable row's gesture race, not to a
    // touch responder on the bubble, so it is driven the way assistive
    // technology drives it.
    act(() => {
      longPressRow(tree);
    });

    const bar = findByTestId(tree, 'chat-message-reaction-bar');
    act(() => {
      bar.props.children[0].props.onPress();
    });

    expect(onReactToMessage).toHaveBeenCalledWith(message, '\u{1F44D}', 'add');
  });

  test('an existing reaction chip toggles the current user reaction off', () => {
    const onReactToMessage = jest.fn();
    const message = makeMessage({ reactions: { '\u{1F44D}': ['user-alice'] } });
    const tree = render({
      peerId: 'user-bob',
      messages: [message],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
      onReactToMessage,
    });

    const chips = findByTestId(tree, 'chat-message-reactions');
    act(() => {
      chips.props.children[0].props.onPress();
    });

    expect(onReactToMessage).toHaveBeenCalledWith(message, '\u{1F44D}', 'remove');
  });

  test('replying from the swipe action sends the quoted messageId', () => {
    const onSendMessage = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [makeMessage({ messageId: 'm-original' })],
      onSendMessage,
      currentUserId: 'user-alice',
    });

    act(() => {
      findByTestId(tree, 'chat-message-swipe-reply').props.onPress();
    });
    expect(findByTestId(tree, 'chat-reply-preview')).not.toBeNull();

    act(() => {
      findByTestId(tree, 'chat-message-input').props.onChangeText('answering');
    });
    act(() => {
      findByTestId(tree, 'chat-message-send').props.onPress();
    });

    expect(onSendMessage).toHaveBeenCalledWith('answering', { replyTo: 'm-original' });
    expect(findAllByTestId(tree, 'chat-reply-preview')).toHaveLength(0);
  });
});

describe('ChatConversationScreen attachments', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      unmountRenderedTrees();
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  test('attach and mic controls are always visible in the composer', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
    });

    expect(findByTestId(tree, 'chat-attach-button')).not.toBeNull();
    expect(findByTestId(tree, 'chat-mic-button')).not.toBeNull();
  });

  test('tapping attach opens a sheet, and picking an option calls onPickAttachment', () => {
    const onPickAttachment = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      onPickAttachment,
    });

    expect(findAllByTestId(tree, 'chat-attach-sheet')).toHaveLength(0);

    act(() => {
      findByTestId(tree, 'chat-attach-button').props.onPress();
    });
    expect(findByTestId(tree, 'chat-attach-sheet')).not.toBeNull();

    act(() => {
      findByTestId(tree, 'chat-attach-option-photo').props.onPress();
    });
    expect(onPickAttachment).toHaveBeenCalledWith('photo');
    expect(findAllByTestId(tree, 'chat-attach-sheet')).toHaveLength(0);
  });

  test('tapping attach while attachments are unavailable shows a notice instead of the sheet', () => {
    const onPickAttachment = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      onPickAttachment,
      attachmentsAvailable: false,
    });

    act(() => {
      findByTestId(tree, 'chat-attach-button').props.onPress();
    });

    expect(findAllByTestId(tree, 'chat-attach-sheet')).toHaveLength(0);
    expect(findByTestId(tree, 'chat-attachments-unavailable-notice')).not.toBeNull();
    expect(onPickAttachment).not.toHaveBeenCalled();
  });

  test('the mic button toggles voice-note recording', () => {
    const onStartVoiceNote = jest.fn();
    const onStopVoiceNote = jest.fn();
    const props = {
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      onStartVoiceNote,
      onStopVoiceNote,
      isVoiceNoteSupported: true,
      isRecordingVoiceNote: false,
    };
    const tree = render(props);

    act(() => {
      findByTestId(tree, 'chat-mic-button').props.onPress();
    });
    expect(onStartVoiceNote).toHaveBeenCalledTimes(1);

    act(() => {
      tree.update(<ChatConversationScreen {...props} isRecordingVoiceNote />);
    });

    act(() => {
      findByTestId(tree, 'chat-mic-button').props.onPress();
    });
    expect(onStopVoiceNote).toHaveBeenCalledTimes(1);
  });

  test('a cancel button appears only while recording and stops without sending', () => {
    const onCancelVoiceNote = jest.fn();
    const props = {
      peerId: 'user-bob',
      messages: [],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      onCancelVoiceNote,
      isVoiceNoteSupported: true,
      isRecordingVoiceNote: false,
    };
    const tree = render(props);

    expect(findAllByTestId(tree, 'chat-mic-cancel-button')).toHaveLength(0);

    act(() => {
      tree.update(<ChatConversationScreen {...props} isRecordingVoiceNote />);
    });
    expect(findByTestId(tree, 'chat-mic-cancel-button')).not.toBeNull();

    act(() => {
      findByTestId(tree, 'chat-mic-cancel-button').props.onPress();
    });
    expect(onCancelVoiceNote).toHaveBeenCalledTimes(1);
  });

  test('shows upload progress while an attachment is uploading', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({
          messageId: 'file-uploading',
          senderId: 'user-alice',
          body: '',
          type: 'file',
          pending: true,
          uploadState: 'uploading',
          uploadProgress: 0.42,
          attachment: { url: 'file:///report.pdf', mimeType: 'application/pdf', name: 'report.pdf' },
        }),
      ],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      isUploadingAttachment: true,
    });

    const notice = findByTestId(tree, 'chat-attachment-upload-progress');
    expect(notice).not.toBeNull();
    const text = notice
      .findAll((n: any) => typeof n.props?.children === 'string')
      .map((n: any) => n.props.children);
    expect(text.some((value: string) => value.includes('42%'))).toBe(true);
    expect(notice.props.accessibilityRole).toBe('progressbar');
  });

  test('shows a download action for sent file attachments', () => {
    const onDownloadAttachment = jest.fn();
    const fileMessage = makeMessage({
      messageId: 'file-1',
      senderId: 'user-alice',
      body: '',
      type: 'file',
      attachment: {
        url: 'https://media.test/chatblobs/c/report.pdf',
        name: 'report.pdf',
        mimeType: 'application/pdf',
      },
    });
    const tree = render({
      peerId: 'user-bob',
      messages: [fileMessage],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      onDownloadAttachment,
    });

    const download = findByTestId(tree, 'chat-attachment-download');
    expect(download).not.toBeNull();

    act(() => {
      download.props.onPress();
    });

    expect(onDownloadAttachment).toHaveBeenCalledWith(fileMessage);
  });

  test('tapping a received photo opens it in the fullscreen viewer, and closing returns to the chat', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({
          messageId: 'img-1',
          body: '',
          type: 'image',
          attachment: { url: 'https://media.test/chatblobs/c/p.jpg', mimeType: 'image/jpeg' },
        }),
      ],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
    });

    expect(findAllByTestId(tree, 'media-viewer-image')).toHaveLength(0);

    act(() => {
      findByTestId(tree, 'chat-message-image-open').props.onPress();
    });
    expect(findByTestId(tree, 'media-viewer-image').props.source).toEqual({
      uri: 'https://media.test/chatblobs/c/p.jpg',
    });

    act(() => {
      findByTestId(tree, 'media-viewer-close').props.onPress();
    });
    expect(findAllByTestId(tree, 'media-viewer-image')).toHaveLength(0);
  });

  test('a voice note renders an inline player instead of a bare description', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({
          messageId: 'voice-1',
          body: '',
          type: 'voice',
          attachment: {
            url: 'https://media.test/chatblobs/c/note.m4a',
            mimeType: 'audio/aac',
            durationMs: 8000,
          },
        }),
      ],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
    });

    expect(findByTestId(tree, 'chat-audio-player')).not.toBeNull();
    expect(findByTestId(tree, 'chat-audio-player-duration').props.children).toBe('0:08');
  });

  test('a video file renders a play affordance that opens the viewer', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({
          messageId: 'video-1',
          body: '',
          type: 'file',
          attachment: {
            url: 'https://media.test/chatblobs/c/clip.mp4',
            mimeType: 'video/mp4',
            name: 'clip.mp4',
          },
        }),
      ],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
    });

    const video = findByTestId(tree, 'chat-message-video');
    expect(video.props.accessibilityLabel).toBe('Play video');

    act(() => {
      video.props.onPress();
    });
    expect(findByTestId(tree, 'media-viewer')).not.toBeNull();
  });

  test('an attachment still uploading says so instead of offering a download', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({
          messageId: 'file-pending',
          senderId: 'user-alice',
          body: '',
          type: 'file',
          pending: true,
          attachment: null,
        }),
      ],
      onSendMessage: jest.fn(),
      currentUserId: 'user-alice',
      onDownloadAttachment: jest.fn(),
    });

    expect(findAllByTestId(tree, 'chat-attachment-download')).toHaveLength(0);
    expect(findByTestId(tree, 'chat-attachment-uploading')).not.toBeNull();
  });

  describe('delivery announcements', () => {
    const announce = announceForAccessibility as jest.Mock;

    beforeEach(() => {
      announce.mockClear();
    });

    function baseProps(overrides: any = {}) {
      return {
        peerId: 'user-bob',
        onSendMessage: jest.fn(),
        onBack: jest.fn(),
        currentUserId: 'user-alice',
        ...overrides,
      };
    }

    test('says nothing when a page of already-sent history loads', () => {
      render(
        baseProps({
          messages: [makeMessage({ senderId: 'user-alice', deliveredTo: ['user-bob'] })],
        }),
      );

      expect(announce).not.toHaveBeenCalledWith('Message sent');
    });

    test('announces a send that completes while the conversation is open', () => {
      const pending = makeMessage({ senderId: 'user-alice', pending: true });
      const tree = render(baseProps({ messages: [pending] }));

      act(() => {
        tree.update(
          <ChatConversationScreen
            {...baseProps({ messages: [{ ...pending, pending: false }] })}
          />,
        );
      });

      expect(announce).toHaveBeenCalledWith('Message sent');
    });

    test('announces a failure, which is the outcome the user must act on', () => {
      const pending = makeMessage({ senderId: 'user-alice', pending: true });
      const tree = render(baseProps({ messages: [pending] }));

      act(() => {
        tree.update(
          <ChatConversationScreen
            {...baseProps({ messages: [{ ...pending, pending: false, failed: true }] })}
          />,
        );
      });

      expect(announce).toHaveBeenCalledWith('Message failed to send');
    });

    test("never announces the peer's messages", () => {
      const peerMessage = makeMessage({ senderId: 'user-bob', pending: true });
      const tree = render(baseProps({ messages: [peerMessage] }));

      act(() => {
        tree.update(
          <ChatConversationScreen
            {...baseProps({ messages: [{ ...peerMessage, pending: false }] })}
          />,
        );
      });

      expect(announce).not.toHaveBeenCalledWith('Message sent');
    });

    test('does not repeat itself when the same state re-renders', () => {
      const pending = makeMessage({ senderId: 'user-alice', pending: true });
      const sent = { ...pending, pending: false };
      const tree = render(baseProps({ messages: [pending] }));

      act(() => {
        tree.update(<ChatConversationScreen {...baseProps({ messages: [sent] })} />);
      });
      act(() => {
        tree.update(<ChatConversationScreen {...baseProps({ messages: [{ ...sent }] })} />);
      });

      expect(announce.mock.calls.filter(([text]) => text === 'Message sent')).toHaveLength(1);
    });
  });
});

describe('ChatConversationScreen drafts', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      unmountRenderedTrees();
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  test('restores a persisted draft into the composer', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      currentUserId: 'user-alice',
      initialDraft: { text: 'unfinished thought', replyToId: null },
    });

    const input = tree.root.findByProps({ testID: 'chat-message-input' });
    expect(input.props.value).toBe('unfinished thought');
  });

  test('persists the composer text when the screen is left', () => {
    const onSaveDraft = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      currentUserId: 'user-alice',
      onSaveDraft,
    });

    const input = tree.root.findByProps({ testID: 'chat-message-input' });
    act(() => {
      input.props.onChangeText('typed but not sent');
    });
    // Nothing is written while the user is still typing.
    expect(onSaveDraft).not.toHaveBeenCalled();

    act(() => {
      tree.unmount();
    });
    expect(onSaveDraft).toHaveBeenCalledWith('typed but not sent', null);
  });

  test('debounces draft persistence while the user is typing', () => {
    const onSaveDraft = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      currentUserId: 'user-alice',
      onSaveDraft,
    });

    const input = tree.root.findByProps({ testID: 'chat-message-input' });
    act(() => {
      input.props.onChangeText('typed but');
    });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    act(() => {
      input.props.onChangeText('typed but not lost');
    });
    act(() => {
      jest.advanceTimersByTime(749);
    });
    expect(onSaveDraft).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(onSaveDraft).toHaveBeenCalledWith('typed but not lost', null);
  });

  test('clears the stored draft once the message is sent', () => {
    const onClearDraft = jest.fn();
    const onSendMessage = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      currentUserId: 'user-alice',
      onSendMessage,
      onClearDraft,
      initialDraft: { text: 'ready to go', replyToId: null },
    });

    act(() => {
      tree.root.findByProps({ testID: 'chat-message-send' }).props.onPress();
    });

    expect(onSendMessage).toHaveBeenCalledWith('ready to go', { replyTo: null });
    expect(onClearDraft).toHaveBeenCalled();
  });

  test('does not re-save a sent message as a draft when the screen closes', () => {
    const onSaveDraft = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [],
      currentUserId: 'user-alice',
      onSendMessage: jest.fn(),
      onClearDraft: jest.fn(),
      onSaveDraft,
      initialDraft: { text: 'ready to go', replyToId: null },
    });

    act(() => {
      tree.root.findByProps({ testID: 'chat-message-send' }).props.onPress();
      tree.unmount();
    });

    expect(onSaveDraft).not.toHaveBeenCalledWith('ready to go', null);
  });
});

describe('ChatConversationScreen unread divider', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  const incoming = (id: string, minutesAgo: number) =>
    makeMessage({
      messageId: id,
      senderId: 'user-bob',
      recipientId: 'user-alice',
      body: id,
      createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    });

  test('shows no divider when nothing is unread', () => {
    const tree = render({
      peerId: 'user-bob',
      currentUserId: 'user-alice',
      messages: [incoming('m2', 1), incoming('m1', 2)],
      unreadCount: 0,
    });

    expect(tree.root.findAll((n: any) => n.props?.testID === 'chat-unread-divider')).toHaveLength(
      0,
    );
  });

  test('labels the divider with the unread count', () => {
    const tree = render({
      peerId: 'user-bob',
      currentUserId: 'user-alice',
      messages: [incoming('m3', 1), incoming('m2', 2), incoming('m1', 3)],
      unreadCount: 2,
    });

    const divider = tree.root.findAll((n: any) => n.props?.testID === 'chat-unread-divider');
    expect(divider.length).toBeGreaterThan(0);
    const labels = tree.root.findAll(
      (n: any) => typeof n.props?.children === 'string' && n.props.children === '2 new messages',
    );
    expect(labels.length).toBeGreaterThan(0);
  });

  test('keeps the divider once the conversation is marked read', () => {
    const tree = render({
      peerId: 'user-bob',
      currentUserId: 'user-alice',
      messages: [incoming('m2', 1), incoming('m1', 2)],
      unreadCount: 1,
    });

    // The server acknowledges the read within a round trip; the divider must
    // not disappear out from under the reader.
    act(() => {
      tree.update(
        <ChatConversationScreen
          peerId="user-bob"
          currentUserId="user-alice"
          messages={[incoming('m2', 1), incoming('m1', 2)]}
          unreadCount={0}
          onSendMessage={jest.fn()}
          onBack={jest.fn()}
        />,
      );
    });

    expect(
      tree.root.findAll((n: any) => n.props?.testID === 'chat-unread-divider').length,
    ).toBeGreaterThan(0);
  });
});

describe('findUnreadAnchorKey', () => {
  const msg = (messageId: string, senderId: string) => ({
    messageId,
    senderId,
    conversationId: 'c1',
    recipientId: 'user-alice',
    body: messageId,
    createdAt: new Date().toISOString(),
  });

  test('anchors N incoming messages back from the end', () => {
    const ordered: any = [
      msg('m1', 'user-bob'),
      msg('m2', 'user-alice'),
      msg('m3', 'user-bob'),
      msg('m4', 'user-bob'),
    ];
    expect(findUnreadAnchorKey(ordered, 2, 'user-alice')).toBe('m3');
  });

  test('ignores the reader\u2019s own messages', () => {
    const ordered: any = [msg('m1', 'user-alice'), msg('m2', 'user-alice')];
    expect(findUnreadAnchorKey(ordered, 2, 'user-alice')).toBeNull();
  });

  test('anchors at the oldest loaded message when the count exceeds the page', () => {
    const ordered: any = [msg('m1', 'user-bob'), msg('m2', 'user-bob')];
    expect(findUnreadAnchorKey(ordered, 50, 'user-alice')).toBe('m1');
  });

  test('returns null when nothing is unread', () => {
    const ordered: any = [msg('m1', 'user-bob')];
    expect(findUnreadAnchorKey(ordered, 0, 'user-alice')).toBeNull();
  });
});

describe('ChatConversationScreen upload cancellation', () => {
  test('offers a cancel control while an attachment is uploading', () => {
    const onCancelAttachmentUpload = jest.fn();
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({
          messageId: 'file-uploading',
          senderId: 'user-alice',
          body: '',
          type: 'file',
          pending: true,
          uploadState: 'uploading',
          uploadProgress: 0.42,
          attachment: { url: 'file:///report.pdf', mimeType: 'application/pdf', name: 'report.pdf' },
        }),
      ],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      isUploadingAttachment: true,
      attachmentUploadProgress: 0.42,
      onCancelAttachmentUpload,
    });

    const cancel = findByTestId(tree, 'chat-attachment-upload-cancel');
    expect(cancel).not.toBeNull();
    act(() => {
      cancel.props.onPress();
    });
    expect(onCancelAttachmentUpload).toHaveBeenCalledTimes(1);
  });

  test('omits the cancel control when cancelling is not wired up', () => {
    const tree = render({
      peerId: 'user-bob',
      messages: [
        makeMessage({
          messageId: 'file-uploading',
          senderId: 'user-alice',
          body: '',
          type: 'file',
          pending: true,
          uploadState: 'uploading',
          uploadProgress: 0.42,
          attachment: { url: 'file:///report.pdf', mimeType: 'application/pdf', name: 'report.pdf' },
        }),
      ],
      onSendMessage: jest.fn(),
      onBack: jest.fn(),
      currentUserId: 'user-alice',
      isUploadingAttachment: true,
      attachmentUploadProgress: 0.42,
    });

    expect(findByTestId(tree, 'chat-attachment-upload-cancel')).toBeNull();
  });
});
