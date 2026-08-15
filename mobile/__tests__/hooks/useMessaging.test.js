import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useMessaging from '../../src/hooks/useMessaging';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logVerbose: jest.fn(),
}));

function TestHook({ resultRef, params }) {
  resultRef.current = useMessaging(params);
  return null;
}

function makeSocket({ connected = true, ackResponse = { ok: true, message: null } } = {}) {
  return {
    connected,
    emit: jest.fn((event, payload, callback) => {
      if (typeof callback === 'function') callback(ackResponse);
    }),
  };
}

function setup(overrides = {}) {
  const params = {
    authedFetchRef: { current: jest.fn() },
    sessionIdRef: { current: 'sess-1' },
    signalingUrl: 'https://signal.example.com',
    socketRef: { current: makeSocket() },
    userId: 'alice',
    updateStatus: jest.fn(),
    ...overrides,
  };
  const resultRef = { current: null };
  let tree;
  act(() => {
    tree = renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });
  return { resultRef, params, tree };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useMessaging', () => {
  test('fetchConversations is a no-op when there is no session', async () => {
    const { resultRef, params } = setup({ sessionIdRef: { current: null } });
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    expect(params.authedFetchRef.current).not.toHaveBeenCalled();
    expect(resultRef.current.conversations).toEqual([]);
  });

  test('fetchConversations populates conversations and unreadTotal on success', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({
      ok: true,
      json: async () => ({
        conversations: [
          { conversationId: 'c1', peerId: 'bob', unreadCount: 2 },
          { conversationId: 'c2', peerId: 'carol', unreadCount: 3 },
        ],
      }),
    });

    await act(async () => {
      await resultRef.current.fetchConversations();
    });

    expect(resultRef.current.conversations).toHaveLength(2);
    expect(resultRef.current.unreadTotal).toBe(5);
  });

  test('fetchConversations silently no-ops on a fetch error', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockRejectedValue(new Error('boom'));
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    expect(resultRef.current.conversations).toEqual([]);
  });

  test('fetchMessagesForPeer sets the first page and pages older messages with `before`', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [{ messageId: 'm2', createdAt: '2024-01-02' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [{ messageId: 'm1', createdAt: '2024-01-01' }],
        }),
      });

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob');
    });
    expect(resultRef.current.messagesByPeer.bob).toEqual([
      { messageId: 'm2', createdAt: '2024-01-02' },
    ]);

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob', { before: '2024-01-02' });
    });
    expect(resultRef.current.messagesByPeer.bob).toEqual([
      { messageId: 'm2', createdAt: '2024-01-02' },
      { messageId: 'm1', createdAt: '2024-01-01' },
    ]);
  });

  test('fetchMessagesForPeer resolves to an empty array with no session or peerId', async () => {
    const { resultRef } = setup({ sessionIdRef: { current: null } });
    let messages;
    await act(async () => {
      messages = await resultRef.current.fetchMessagesForPeer('bob');
    });
    expect(messages).toEqual([]);
  });

  test('markConversationRead posts to /messages/read and zeroes the local unread count', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({ ok: true });
    act(() => {
      resultRef.current.setActiveChatPeerId(null);
    });
    // Seed a conversation via fetchConversations first.
    params.authedFetchRef.current.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', unreadCount: 4 }],
      }),
    });
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    params.authedFetchRef.current.mockResolvedValueOnce({ ok: true });

    await act(async () => {
      await resultRef.current.markConversationRead('bob');
    });

    expect(resultRef.current.conversations[0].unreadCount).toBe(0);
  });

  test('sendMessage fails immediately when there is no connected socket', async () => {
    const socketRef = { current: makeSocket({ connected: false }) };
    const { resultRef, params } = setup({ socketRef });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi');
    });

    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({ pending: false, failed: true });
    expect(params.updateStatus).toHaveBeenCalledWith('Message failed to send', 'error');
  });

  test('sendMessage optimistically appends then reconciles with the server-confirmed message on ack', async () => {
    const confirmedMessage = { messageId: 'm-real', body: 'hi', senderId: 'alice' };
    const socketRef = {
      current: makeSocket({ ackResponse: { ok: true, message: confirmedMessage } }),
    };
    const { resultRef } = setup({ socketRef });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi');
    });

    expect(resultRef.current.messagesByPeer.bob[0]).toEqual({
      ...confirmedMessage,
      pending: false,
    });
    expect(socketRef.current.emit).toHaveBeenCalledWith(
      'message.send',
      { version: 1, recipientId: 'bob', body: 'hi' },
      expect.any(Function),
    );
  });

  test('sendMessage marks the optimistic message failed when the ack rejects', async () => {
    const socketRef = {
      current: makeSocket({ ackResponse: { ok: false, error: { message: 'nope' } } }),
    };
    const { resultRef, params } = setup({ socketRef });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi');
    });

    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({ pending: false, failed: true });
    expect(params.updateStatus).toHaveBeenCalledWith('Message failed to send', 'error');
  });

  test('sendMessage ignores an empty/whitespace-only body', async () => {
    const { resultRef } = setup();
    await act(async () => {
      await resultRef.current.sendMessage('bob', '   ');
    });
    expect(resultRef.current.messagesByPeer.bob).toBeUndefined();
  });

  test('sendTypingIndicator emits message.typing and throttles repeated true calls per peer', () => {
    jest.useFakeTimers();
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    expect(socket.emit).toHaveBeenCalledTimes(1);

    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    expect(socket.emit).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(2000);
      resultRef.current.sendTypingIndicator('bob', true);
    });
    expect(socket.emit).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  test('sendTypingIndicator always emits isTyping:false immediately, bypassing the throttle', () => {
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
      resultRef.current.sendTypingIndicator('bob', false);
    });
    expect(socket.emit).toHaveBeenCalledTimes(2);
    expect(socket.emit).toHaveBeenLastCalledWith('message.typing', {
      version: 1,
      recipientId: 'bob',
      isTyping: false,
    });
  });

  test('sendTypingIndicator is a no-op when there is no connected socket', () => {
    const socket = makeSocket({ connected: false });
    const { resultRef } = setup({ socketRef: { current: socket } });
    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('handleMessageReceived bumps unreadCount for an existing conversation when it is not the active chat', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', unreadCount: 0 }],
      }),
    });
    await act(async () => {
      await resultRef.current.fetchConversations();
    });

    act(() => {
      resultRef.current.handleMessageReceived({ messageId: 'm1', senderId: 'bob', body: 'hi' });
    });

    expect(resultRef.current.messagesByPeer.bob[0]).toEqual({
      messageId: 'm1',
      senderId: 'bob',
      body: 'hi',
    });
    expect(resultRef.current.conversations[0].unreadCount).toBe(1);
  });

  test('handleMessageReceived auto-marks-read and does not bump unread when the conversation is active', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', unreadCount: 0 }],
      }),
    });
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    act(() => {
      resultRef.current.setActiveChatPeerId('bob');
    });
    params.authedFetchRef.current.mockResolvedValueOnce({ ok: true });

    await act(async () => {
      resultRef.current.handleMessageReceived({ messageId: 'm1', senderId: 'bob', body: 'hi' });
      await Promise.resolve();
    });

    expect(resultRef.current.conversations[0].unreadCount).toBe(0);
  });

  test('handleMessageReceived refetches conversations for a brand-new peer not already in the list', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({
      ok: true,
      json: async () => ({ conversations: [] }),
    });

    await act(async () => {
      resultRef.current.handleMessageReceived({ messageId: 'm1', senderId: 'newpeer', body: 'hi' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(params.authedFetchRef.current).toHaveBeenCalled();
  });

  test('handleMessageDelivered appends to the outgoing peer thread, deduping by messageId', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleMessageDelivered({ messageId: 'm1', recipientId: 'bob' });
      resultRef.current.handleMessageDelivered({ messageId: 'm1', recipientId: 'bob' });
    });
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
  });

  test('handleMessageRead marks own sent messages to that peer as read', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleMessageDelivered({
        messageId: 'm1',
        recipientId: 'bob',
        senderId: 'alice',
        readAt: null,
      });
    });
    act(() => {
      resultRef.current.handleMessageRead({ readerId: 'bob', readAt: '2024-01-01T00:00:00Z' });
    });
    expect(resultRef.current.messagesByPeer.bob[0].readAt).toBe('2024-01-01T00:00:00Z');
  });

  test('handleMessageRead is a no-op when there is no readerId', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleMessageRead({ readerId: undefined });
    });
    expect(resultRef.current.messagesByPeer).toEqual({});
  });

  test('handleTypingEvent sets typingByPeer and auto-clears after the safety timeout', () => {
    jest.useFakeTimers();
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleTypingEvent({ senderId: 'bob', isTyping: true });
    });
    expect(resultRef.current.typingByPeer.bob).toBe(true);

    act(() => {
      jest.advanceTimersByTime(6000);
    });
    expect(resultRef.current.typingByPeer.bob).toBe(false);
    jest.useRealTimers();
  });

  test('handleTypingEvent with isTyping:false clears the indicator immediately', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleTypingEvent({ senderId: 'bob', isTyping: true });
    });
    expect(resultRef.current.typingByPeer.bob).toBe(true);
    act(() => {
      resultRef.current.handleTypingEvent({ senderId: 'bob', isTyping: false });
    });
    expect(resultRef.current.typingByPeer.bob).toBe(false);
  });

  test('resetTypingState clears pending safety-net timers', () => {
    jest.useFakeTimers();
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleTypingEvent({ senderId: 'bob', isTyping: true });
    });
    act(() => {
      resultRef.current.resetTypingState();
    });
    act(() => {
      jest.advanceTimersByTime(6000);
    });
    // Still true: the safety-net timer that would have cleared it was reset.
    expect(resultRef.current.typingByPeer.bob).toBe(true);
    jest.useRealTimers();
  });
});
