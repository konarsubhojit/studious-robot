import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useMessaging from '../../src/hooks/useMessaging';
import { createSignalingClient } from '../../src/signalingClient';
import {
  dismissMessageNotification,
  markMessageSeen,
  setActiveConversation,
} from '../../src/messageNotification';
import * as chatDb from '../../src/storage/chatDb';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logVerbose: jest.fn(),
}));

jest.mock('../../src/messageNotification', () => ({
  dismissMessageNotification: jest.fn(),
  markMessageSeen: jest.fn(),
  setActiveConversation: jest.fn(),
}));

// In-memory stand-in for the durable local store, so the hook's hydration and
// persistence can be observed without touching the filesystem.
jest.mock('../../src/storage/chatDb', () => {
  const snapshot = { conversations: [], messagesByPeer: {}, outbox: [] };
  return {
    __snapshot: snapshot,
    loadChatSnapshot: jest.fn(async () => snapshot),
    saveChatSnapshot: jest.fn(partial => Object.assign(snapshot, partial)),
  };
});

function TestHook({ resultRef, params }: any) {
  resultRef.current = useMessaging(params);
  return null;
}

function makeSocket({ connected = true, ackResponse = { ok: true, message: null } }: any = {}) {
  return {
    connected,
    emit: jest.fn((event, payload, callback) => {
      if (typeof callback === 'function') callback(ackResponse);
    }),
  };
}

function setup(overrides = {}) {
  const params: any = {
    authedFetchRef: { current: jest.fn() },
    sessionIdRef: { current: 'sess-1' },
    signalingUrl: 'https://signal.example.com',
    socketRef: { current: makeSocket() },
    userId: 'alice',
    updateStatus: jest.fn(),
    ...overrides,
  };
  // The hook emits through the typed signaling client, which wraps the socket
  // under test, so socket-level assertions still observe every emit.
  params.signalingRef = params.signalingRef ?? {
    current: createSignalingClient(params.socketRef.current),
  };
  const resultRef: { current: any; } = { current: null };
  let tree;
  act(() => {
    tree = renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });
  mountedTrees.push(tree);
  return { resultRef, params, tree };
}

/** Rendered hooks, unmounted after each test so the outbox retry timer that
 * an unsent message arms cannot outlive the test that queued it. */
const mountedTrees: any = [];

beforeEach(() => {
  jest.clearAllMocks();
  (chatDb as any).__snapshot.conversations = [];
  (chatDb as any).__snapshot.messagesByPeer = {};
  (chatDb as any).__snapshot.outbox = [];
});

afterEach(() => {
  act(() => {
    mountedTrees.splice(0).forEach((tree: any) => tree.unmount());
  });
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
    (params.authedFetchRef.current as jest.Mock)
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

  test('fetchMessagesForPeer requests the merged timeline and dedupes call entries', async () => {
    const { resultRef, params } = setup();
    (params.authedFetchRef.current as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [{ type: 'call', callId: 'c2', createdAt: '2024-01-02' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [
            // The server repeats the cursor entry defensively; it must not
            // appear twice in the merged list.
            { type: 'call', callId: 'c2', createdAt: '2024-01-02' },
            { type: 'text', messageId: 'm1', createdAt: '2024-01-01' },
          ],
        }),
      });

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob');
    });
    const request = params.authedFetchRef.current.mock.calls[0][0]('session-1');
    expect(request.url).toContain('include=calls');

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob', { before: '2024-01-02' });
    });
    expect(resultRef.current.messagesByPeer.bob).toEqual([
      { type: 'call', callId: 'c2', createdAt: '2024-01-02' },
      { type: 'text', messageId: 'm1', createdAt: '2024-01-01' },
    ]);
  });

  test('fetchMessagesForPeer reconciles by messageId, replacing an optimistic entry', async () => {
    const socket = makeSocket({ connected: false });
    const { resultRef, params } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'sent while offline');
    });
    const messageId = resultRef.current.messagesByPeer.bob[0].messageId;

    // The server page contains the server's copy of that same message, plus one
    // the client has never seen, and a still-queued local message it cannot
    // know about yet.
    await act(async () => {
      await resultRef.current.sendMessage('bob', 'still queued');
    });
    params.authedFetchRef.current.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        messages: [
          {
            messageId,
            body: 'sent while offline',
            senderId: 'alice',
            createdAt: '2024-01-02T00:00:00.000Z',
          },
          { messageId: 'server-1', body: 'hello', createdAt: '2024-01-01T00:00:00.000Z' },
        ],
      }),
    });

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob');
    });

    const bodies = resultRef.current.messagesByPeer.bob.map((m: any) => m.body);
    expect(bodies).toContain('still queued');
    // Replaced, never duplicated.
    expect(bodies.filter((body: any) => body === 'sent while offline')).toHaveLength(1);
    expect(bodies).toContain('hello');
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

  test('sendMessage queues durably while offline instead of failing', async () => {
    const socketRef = { current: makeSocket({ connected: false }) };
    const { resultRef, params } = setup({ socketRef });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi');
    });

    // Still pending, not failed: it goes out when connectivity returns.
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({
      body: 'hi',
      pending: true,
      syncState: 'pending',
    });
    expect(params.updateStatus).not.toHaveBeenCalled();
    // Written to the durable outbox before anything was emitted, so a
    // force-quit here cannot lose the message.
    expect((chatDb as any).__snapshot.outbox).toEqual([
      expect.objectContaining({ body: 'hi', recipientId: 'bob', attempts: 0 }),
    ]);
    expect(resultRef.current.pendingSendCount).toBe(1);
  });

  test('a queued message is sent once when the socket connects, and leaves the outbox', async () => {
    const socket = makeSocket({ connected: false });
    const socketRef = { current: socket };
    const { resultRef } = setup({ socketRef });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'from the train');
    });
    const queuedId = (chatDb as any).__snapshot.outbox[0].messageId;

    socket.connected = true;
    await act(async () => {
      resultRef.current.handleSocketConnected();
    });

    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith(
      'message.send',
      expect.objectContaining({ messageId: queuedId, body: 'from the train' }),
      expect.any(Function),
    );
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({ syncState: 'synced' });
  });

  test('a send queued by a previous run is replayed on mount', async () => {
    (chatDb as any).__snapshot.outbox = [
      {
        messageId: 'queued-1',
        conversationId: 'c1',
        recipientId: 'bob',
        body: 'survived a force quit',
        createdAt: '2024-01-01T00:00:00.000Z',
        attempts: 0,
      },
    ];
    (chatDb as any).__snapshot.messagesByPeer = {
      bob: [
        {
          messageId: 'queued-1',
          senderId: 'alice',
          recipientId: 'bob',
          body: 'survived a force quit',
          createdAt: '2024-01-01T00:00:00.000Z',
          syncState: 'pending',
          pending: true,
        },
      ],
    };
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    await act(async () => {});

    expect(socket.emit).toHaveBeenCalledWith(
      'message.send',
      expect.objectContaining({ messageId: 'queued-1' }),
      expect.any(Function),
    );
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test('hydrates conversations and history from the local store before any fetch', async () => {
    (chatDb as any).__snapshot.conversations = [{ conversationId: 'c1', peerId: 'bob', unreadCount: 2 }];
    (chatDb as any).__snapshot.messagesByPeer = {
      bob: [{ messageId: 'm1', body: 'cached', createdAt: '2024-01-01T00:00:00.000Z' }],
    };
    const { resultRef, params } = setup();

    await act(async () => {});

    expect(resultRef.current.conversations).toEqual((chatDb as any).__snapshot.conversations);
    expect(resultRef.current.messagesByPeer.bob[0].body).toBe('cached');
    expect(resultRef.current.unreadTotal).toBe(2);
    expect(params.authedFetchRef.current).not.toHaveBeenCalled();
  });

  test('retryMessage re-queues an exhausted send and discardMessage drops it', async () => {
    const socket = makeSocket({ ackResponse: { ok: false, error: { message: 'nope' } } });
    const { resultRef, params } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi');
    });
    // Exhaust the automatic retries.
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await act(async () => {
        await resultRef.current.drainOutbox();
      });
    }

    const messageId = resultRef.current.messagesByPeer.bob[0].messageId;
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({
      failed: true,
      syncState: 'failed',
    });
    expect(params.updateStatus).toHaveBeenCalledWith('Message failed to send', 'error');

    await act(async () => {
      await resultRef.current.retryMessage('bob', messageId);
    });
    // The retry re-sends the *same* id, so the server upsert cannot duplicate it.
    expect(socket.emit).toHaveBeenLastCalledWith(
      'message.send',
      expect.objectContaining({ messageId }),
      expect.any(Function),
    );

    act(() => {
      resultRef.current.discardMessage('bob', messageId);
    });
    expect(resultRef.current.messagesByPeer.bob).toEqual([]);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test('deleteMessage tombstones a sent message on the server and locally', async () => {
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'oops');
    });
    const messageId = resultRef.current.messagesByPeer.bob[0].messageId;

    let deleted;
    await act(async () => {
      deleted = await resultRef.current.deleteMessage('bob', messageId);
    });

    expect(deleted).toBe(true);
    expect(socket.emit).toHaveBeenLastCalledWith(
      'message.delete',
      expect.objectContaining({ peerId: 'bob', messageId }),
      expect.any(Function),
    );
    // A delete leaves a tombstone rather than a hole, so a reply that quotes
    // the message still resolves to something renderable.
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0].body).toBe('');
    expect(resultRef.current.messagesByPeer.bob[0].deletedAt).toBeTruthy();
  });

  test('deleteMessage discards a still-queued message without contacting the server', async () => {
    const socket = makeSocket({ connected: false });
    const { resultRef } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'never sent');
    });
    const messageId = resultRef.current.messagesByPeer.bob[0].messageId;

    await act(async () => {
      await resultRef.current.deleteMessage('bob', messageId);
    });

    expect(socket.emit).not.toHaveBeenCalled();
    expect(resultRef.current.messagesByPeer.bob).toEqual([]);
    expect((chatDb as any).__snapshot.outbox).toEqual([]);
  });

  test('deleteMessage reports an error when a sent message cannot be deleted', async () => {
    const socket = makeSocket();
    const { resultRef, params } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'keep me');
    });
    const messageId = resultRef.current.messagesByPeer.bob[0].messageId;

    socket.emit = jest.fn((event, payload, callback) =>
      callback({ ok: false, error: { message: 'nope' } }),
    );
    let deleted;
    await act(async () => {
      deleted = await resultRef.current.deleteMessage('bob', messageId);
    });

    expect(deleted).toBe(false);
    expect(params.updateStatus).toHaveBeenCalledWith('Could not delete message', 'error');
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
  });

  test('handleMessageDeleted tombstones a message the peer deleted', () => {
    const { resultRef } = setup();

    act(() => {
      resultRef.current.handleMessageReceived({
        messageId: 'm-1',
        conversationId: 'c1',
        senderId: 'bob',
        body: 'hi',
      });
    });
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);

    act(() => {
      resultRef.current.handleMessageDeleted({
        conversationId: 'c1',
        messageId: 'm-1',
        deletedBy: 'bob',
        message: { messageId: 'm-1', body: '', deletedAt: '2024-01-01T00:00:00.000Z' },
      });
    });
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0].body).toBe('');
    expect(resultRef.current.messagesByPeer.bob[0].deletedAt).toBe('2024-01-01T00:00:00.000Z');
  });

  test('isOffline follows the socket lifecycle', async () => {
    const { resultRef } = setup();
    expect(resultRef.current.isOffline).toBe(false);

    act(() => {
      resultRef.current.handleSocketDisconnected();
    });
    expect(resultRef.current.isOffline).toBe(true);

    await act(async () => {
      resultRef.current.handleSocketConnected();
    });
    expect(resultRef.current.isOffline).toBe(false);
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

    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({
      ...confirmedMessage,
      pending: false,
      syncState: 'synced',
    });
    expect(socketRef.current.emit).toHaveBeenCalledWith(
      'message.send',
      {
        version: 1,
        recipientId: 'bob',
        body: 'hi',
        messageId: expect.any(String),
      },
      expect.any(Function),
    );
  });

  test('sendMessage keeps retrying a rejected ack and only fails after the attempt budget', async () => {
    const socketRef = {
      current: makeSocket({ ackResponse: { ok: false, error: { message: 'nope' } } }),
    };
    const { resultRef, params } = setup({ socketRef });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi');
    });
    // One attempt spent: still pending, still queued.
    expect(resultRef.current.messagesByPeer.bob[0]).toMatchObject({ pending: true });
    expect((chatDb as any).__snapshot.outbox[0].attempts).toBe(1);
    expect(params.updateStatus).not.toHaveBeenCalled();

    for (let attempt = 1; attempt < 5; attempt += 1) {
      await act(async () => {
        await resultRef.current.drainOutbox();
      });
    }

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
      syncState: 'synced',
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

  test('handleMessageDelivered merges a delivery receipt into the message already held', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleMessageDelivered({
        messageId: 'm1',
        recipientId: 'bob',
        deliveredTo: [],
      });
    });
    act(() => {
      resultRef.current.handleMessageDelivered({
        messageId: 'm1',
        recipientId: 'bob',
        deliveredTo: ['bob'],
      });
    });
    expect(resultRef.current.messagesByPeer.bob).toHaveLength(1);
    expect(resultRef.current.messagesByPeer.bob[0].deliveredTo).toEqual(['bob']);
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

describe('useMessaging push-notification coordination', () => {
  test('mirrors the open conversation into the push layer and clears its notification', async () => {
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

    params.authedFetchRef.current.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      resultRef.current.setActiveChatPeerId('bob');
      await Promise.resolve();
    });

    expect(setActiveConversation).toHaveBeenCalledWith({
      peerId: 'bob',
      conversationId: 'c1',
    });
    expect(dismissMessageNotification).toHaveBeenCalledWith('c1');

    await act(async () => {
      resultRef.current.setActiveChatPeerId(null);
      await Promise.resolve();
    });
    expect(setActiveConversation).toHaveBeenLastCalledWith(null);
  });

  test('handleMessageReceived marks the message seen so its push does not notify', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.handleMessageReceived({
        messageId: 'm1',
        conversationId: 'c1',
        senderId: 'bob',
        body: 'hi',
      });
    });
    expect(markMessageSeen).toHaveBeenCalledWith('m1');
  });

  test('handleMessageReceived dismisses the notification for the open conversation', async () => {
    const { resultRef, params } = setup();
    act(() => {
      resultRef.current.setActiveChatPeerId('bob');
    });
    params.authedFetchRef.current.mockResolvedValue({ ok: true });

    await act(async () => {
      resultRef.current.handleMessageReceived({
        messageId: 'm1',
        conversationId: 'c1',
        senderId: 'bob',
        body: 'hi',
      });
      await Promise.resolve();
    });

    expect(dismissMessageNotification).toHaveBeenCalledWith('c1');
  });
});

describe('useMessaging searchMessages', () => {
  test('queries the search endpoint and returns the results', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ messageId: 'm1', peerId: 'bob', body: 'hello bob' }] }),
    });

    let results;
    await act(async () => {
      results = await resultRef.current.searchMessages('bob', { limit: 5 });
    });

    expect(results).toEqual([{ messageId: 'm1', peerId: 'bob', body: 'hello bob' }]);
    const request = params.authedFetchRef.current.mock.calls[0][0]('sess-1');
    expect(request.url).toContain('/messages/search?');
    expect(request.url).toContain('q=bob');
    expect(request.url).toContain('limit=5');
  });

  test('passes the abort signal through so a stale query can be cancelled', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({ ok: true, json: async () => ({}) });
    const controller = new AbortController();

    await act(async () => {
      await resultRef.current.searchMessages('bob', { signal: controller.signal });
    });

    const request = params.authedFetchRef.current.mock.calls[0][0]('sess-1');
    expect(request.options).toEqual({ signal: controller.signal });
  });

  test('returns nothing for a blank term, without calling the server', async () => {
    const { resultRef, params } = setup();
    await act(async () => {
      await expect(resultRef.current.searchMessages('   ')).resolves.toEqual([]);
    });
    expect(params.authedFetchRef.current).not.toHaveBeenCalled();
  });

  test('degrades to no results when the search request fails', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await expect(resultRef.current.searchMessages('bob')).resolves.toEqual([]);
    });
  });

  test('sendMessage queues an attachment message with its rich fields', async () => {
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    const attachment = {
      url: 'https://media.test/chatblobs/alice:bob/photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    };
    await act(async () => {
      await resultRef.current.sendMessage('bob', '', { type: 'image', attachment });
    });

    // An attachment message needs no body: the attachment is the content.
    const [queued] = resultRef.current.messagesByPeer.bob;
    expect(queued.type).toBe('image');
    expect(queued.attachment).toEqual(attachment);
    expect(socket.emit).toHaveBeenLastCalledWith(
      'message.send',
      expect.objectContaining({ type: 'image', attachment }),
      expect.any(Function),
    );
  });

  test('sendMessage still ignores an empty text message', async () => {
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', '   ');
    });

    expect(resultRef.current.messagesByPeer.bob).toBeUndefined();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('sendMessage forwards replyTo so a reply quotes the original', async () => {
    const socket = makeSocket();
    const { resultRef } = setup({ socketRef: { current: socket } });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'answering', { replyTo: 'm-original' });
    });

    expect(resultRef.current.messagesByPeer.bob[0].replyTo).toBe('m-original');
    expect(socket.emit).toHaveBeenLastCalledWith(
      'message.send',
      expect.objectContaining({ replyTo: 'm-original' }),
      expect.any(Function),
    );
  });

  test('reactToMessage stores the server reaction set', async () => {
    const socket = makeSocket({
      ackResponse: { ok: true, reactions: { '\u{1F44D}': ['alice'] } },
    });
    const { resultRef } = setup({ socketRef: { current: socket } });

    act(() => {
      resultRef.current.handleMessageReceived({
        messageId: 'm-1',
        conversationId: 'c1',
        senderId: 'bob',
        body: 'react to me',
      });
    });

    let reacted;
    await act(async () => {
      reacted = await resultRef.current.reactToMessage('bob', 'm-1', '\u{1F44D}', 'add');
    });

    expect(reacted).toBe(true);
    expect(socket.emit).toHaveBeenLastCalledWith(
      'message.react',
      expect.objectContaining({
        peerId: 'bob',
        messageId: 'm-1',
        emoji: '\u{1F44D}',
        action: 'add',
      }),
      expect.any(Function),
    );
    expect(resultRef.current.messagesByPeer.bob[0].reactions).toEqual({
      '\u{1F44D}': ['alice'],
    });
  });

  test('handleMessageReaction converges a reaction made on another device', () => {
    const { resultRef } = setup();

    act(() => {
      resultRef.current.handleMessageReceived({
        messageId: 'm-1',
        conversationId: 'c1',
        senderId: 'bob',
        body: 'hi',
      });
    });

    act(() => {
      resultRef.current.handleMessageReaction({
        messageId: 'm-1',
        reactions: { '\u{2764}\u{FE0F}': ['alice', 'bob'] },
      });
    });

    expect(resultRef.current.messagesByPeer.bob[0].reactions).toEqual({
      '\u{2764}\u{FE0F}': ['alice', 'bob'],
    });
  });
});
