import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useChatSync from '../../src/hooks/useChatSync';

function TestHook({ resultRef, params }: any) {
  resultRef.current = useChatSync(params);
  return null;
}

async function setup(overrides = {}) {
  const params = {
    chatPeerId: null,
    isRegistered: true,
    messagesByPeer: {},
    fetchConversations: jest.fn(async () => {}),
    setActiveChatPeerId: jest.fn(),
    fetchMessagesForPeer: jest.fn(async () => []),
    markConversationRead: jest.fn(async () => {}),
    checkPresence: jest.fn(async () => ({ status: 'online', online: true })),
    ...overrides,
  };
  const resultRef: { current: any; } = { current: null };
  let tree: any;
  await act(async () => {
    tree = renderer.create(<TestHook resultRef={resultRef} params={params} />);
    await Promise.resolve();
  });
  return { resultRef, params, tree };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useChatSync', () => {
  test('fetches conversations on mount when already registered', async () => {
    const { params } = await setup({ isRegistered: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(params.fetchConversations).toHaveBeenCalledTimes(1);
  });

  test('does not fetch conversations when not registered', async () => {
    const { params } = await setup({ isRegistered: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(params.fetchConversations).not.toHaveBeenCalled();
  });

  test('re-fetches conversations once isRegistered flips from false to true', async () => {
    const { params, tree, resultRef } = await setup({ isRegistered: false });
    expect(params.fetchConversations).not.toHaveBeenCalled();

    await act(async () => {
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, isRegistered: true }} />);
      await Promise.resolve();
    });
    expect(params.fetchConversations).toHaveBeenCalledTimes(1);
  });

  test('opening a conversation syncs activeChatPeerId, loads history, and marks it read', async () => {
    const { params, tree, resultRef } = await setup({ chatPeerId: null });

    await act(async () => {
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, chatPeerId: 'bob' }} />);
      await Promise.resolve();
    });

    expect(params.setActiveChatPeerId).toHaveBeenCalledWith('bob');
    expect(params.fetchMessagesForPeer).toHaveBeenCalledWith('bob');
    expect(params.markConversationRead).toHaveBeenCalledWith('bob');
  });

  test('closing a conversation clears activeChatPeerId on cleanup', async () => {
    const { params, tree, resultRef } = await setup({ chatPeerId: 'bob' });
    params.setActiveChatPeerId.mockClear();

    await act(async () => {
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, chatPeerId: null }} />);
      await Promise.resolve();
    });

    expect(params.setActiveChatPeerId).toHaveBeenCalledWith(null);
  });

  test('fetches and stores peer presence for the open conversation', async () => {
    const { resultRef } = await setup({ chatPeerId: 'bob' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(resultRef.current.peerPresence).toEqual({ status: 'online', online: true });
  });

  test('clears peerPresence when the conversation is closed', async () => {
    const { resultRef, tree, params } = await setup({ chatPeerId: 'bob' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(resultRef.current.peerPresence).toEqual({ status: 'online', online: true });

    act(() => {
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, chatPeerId: null }} />);
    });
    expect(resultRef.current.peerPresence).toBeNull();
  });

  test('isLoadingConversations is true only while the first conversation fetch is in flight', async () => {
    let resolveFetch: any;
    const fetchConversations = jest.fn(
      () =>
        new Promise(resolve => {
          resolveFetch = resolve;
        }),
    );
    const { resultRef } = await setup({ fetchConversations });
    expect(resultRef.current.isLoadingConversations).toBe(true);

    await act(async () => {
      resolveFetch();
      await Promise.resolve();
    });
    expect(resultRef.current.isLoadingConversations).toBe(false);
  });

  test('isLoadingMessages tracks the open conversation history fetch', async () => {
    let resolveFetch: any;
    const fetchMessagesForPeer = jest.fn(
      () =>
        new Promise(resolve => {
          resolveFetch = resolve;
        }),
    );
    const { resultRef, params, tree } = await setup({ fetchMessagesForPeer });
    expect(resultRef.current.isLoadingMessages).toBe(false);

    await act(async () => {
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, chatPeerId: 'user-bob' }} />);
      await Promise.resolve();
    });
    expect(resultRef.current.isLoadingMessages).toBe(true);

    await act(async () => {
      resolveFetch([]);
      await Promise.resolve();
    });
    expect(resultRef.current.isLoadingMessages).toBe(false);
  });

  test('handleRefreshConversations toggles isRefreshingConversations around the fetch', async () => {
    let resolveFetch: any;
    const fetchConversations = jest.fn(
      () =>
        new Promise(resolve => {
          resolveFetch = resolve;
        }),
    );
    const { resultRef } = await setup({ fetchConversations });

    let refreshPromise: any;
    act(() => {
      refreshPromise = resultRef.current.handleRefreshConversations();
    });
    expect(resultRef.current.isRefreshingConversations).toBe(true);

    await act(async () => {
      resolveFetch();
      await refreshPromise;
    });
    expect(resultRef.current.isRefreshingConversations).toBe(false);
  });

  test('handleLoadOlderMessages is a no-op with no open conversation', async () => {
    const { resultRef, params } = await setup({ chatPeerId: null });
    act(() => {
      resultRef.current.handleLoadOlderMessages();
    });
    expect(params.fetchMessagesForPeer).not.toHaveBeenCalled();
  });

  test('handleLoadOlderMessages pages further back using the oldest message createdAt', async () => {
    const { resultRef, params } = await setup({
      chatPeerId: 'bob',
      messagesByPeer: { bob: [{ createdAt: '2024-01-02' }, { createdAt: '2024-01-01' }] },
    });
    act(() => {
      resultRef.current.handleLoadOlderMessages();
    });
    expect(params.fetchMessagesForPeer).toHaveBeenCalledWith('bob', { before: '2024-01-01' });
  });

  test('handleLoadOlderMessages does nothing when the oldest message has no createdAt', async () => {
    const { resultRef, params } = await setup({
      chatPeerId: 'bob',
      messagesByPeer: { bob: [{ createdAt: undefined }] },
    });
    params.fetchMessagesForPeer.mockClear();
    act(() => {
      resultRef.current.handleLoadOlderMessages();
    });
    expect(params.fetchMessagesForPeer).not.toHaveBeenCalled();
  });
});
