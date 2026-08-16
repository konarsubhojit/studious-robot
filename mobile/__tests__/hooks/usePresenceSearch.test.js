import React from 'react';
import renderer, { act } from 'react-test-renderer';
import usePresenceSearch from '../../src/hooks/usePresenceSearch';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logVerbose: jest.fn(),
}));

function TestHook({ resultRef, params }) {
  resultRef.current = usePresenceSearch(params);
  return null;
}

function setup(overrides = {}) {
  const authedFetchRef = {
    current: jest.fn(buildRequest => {
      const request = buildRequest('sess-1');
      return global.fetch(request.url, request.options);
    }),
  };
  const params = {
    signalingUrl: 'https://signal.example.com',
    authedFetchRef,
    sessionIdRef: { current: 'sess-1' },
    calleeId: '',
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
  global.fetch = jest.fn();
});

describe('usePresenceSearch', () => {
  test('checkPresence returns online/offline snapshot on success', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'online', online: true }),
    });
    const { resultRef } = setup();

    let presence;
    await act(async () => {
      presence = await resultRef.current.checkPresence('bob');
    });

    expect(presence).toEqual({ status: 'online', online: true });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://signal.example.com/presence/bob?sessionId=sess-1',
      undefined,
    );
  });

  test('checkPresence returns unknown:true for a 404', async () => {
    global.fetch.mockResolvedValue({ status: 404, ok: false });
    const { resultRef } = setup();

    let presence;
    await act(async () => {
      presence = await resultRef.current.checkPresence('bob');
    });

    expect(presence).toEqual({ status: 'offline', online: false, unknown: true });
  });

  test('checkPresence returns null for an empty userId or on error', async () => {
    const { resultRef } = setup();

    let presence;
    await act(async () => {
      presence = await resultRef.current.checkPresence('  ');
    });
    expect(presence).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();

    global.fetch.mockRejectedValue(new Error('network down'));
    await act(async () => {
      presence = await resultRef.current.checkPresence('bob');
    });
    expect(presence).toBeNull();
  });

  test('searchUsers resolves to an empty array when there is no session', async () => {
    const { resultRef } = setup({ sessionIdRef: { current: null } });

    let users;
    await act(async () => {
      users = await resultRef.current.searchUsers('bo');
    });

    expect(users).toEqual([]);
  });

  test('searchUsers issues an authenticated request and returns the users array', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({
      ok: true,
      json: async () => ({ users: [{ userId: 'bob', status: 'online', online: true }] }),
    });

    let users;
    await act(async () => {
      users = await resultRef.current.searchUsers('bo', 10);
    });

    expect(users).toEqual([{ userId: 'bob', status: 'online', online: true }]);
    expect(params.authedFetchRef.current).toHaveBeenCalledWith(expect.any(Function));
    const buildRequest = params.authedFetchRef.current.mock.calls[0][0];
    expect(buildRequest('sess-1').url).toBe(
      'https://signal.example.com/users?sessionId=sess-1&limit=10&search=bo',
    );
  });

  test('searchUsers returns an empty array on a failed response or network error', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({ ok: false });

    let users;
    await act(async () => {
      users = await resultRef.current.searchUsers();
    });
    expect(users).toEqual([]);

    params.authedFetchRef.current.mockRejectedValue(new Error('boom'));
    await act(async () => {
      users = await resultRef.current.searchUsers();
    });
    expect(users).toEqual([]);
  });

  test('debounced calleeId presence effect ignores stale responses for older calleeIds', async () => {
    jest.useFakeTimers();
    global.fetch.mockImplementation(url => {
      if (url.endsWith('/presence/first')) {
        return new Promise(resolve => {
          setTimeout(
            () => resolve({ ok: true, json: async () => ({ status: 'online', online: true }) }),
            1000,
          );
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: 'offline', online: false }),
      });
    });

    const { resultRef, tree, params } = setup({ calleeId: 'first' });

    act(() => {
      jest.advanceTimersByTime(400);
    });

    // Change calleeId before the first (slow) presence lookup resolves.
    act(() => {
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, calleeId: 'second' }} />);
    });

    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
    });

    expect(resultRef.current.calleePresence).toEqual({ status: 'offline', online: false });

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    // The stale "first" response must not overwrite the "second" result.
    expect(resultRef.current.calleePresence).toEqual({ status: 'offline', online: false });

    jest.useRealTimers();
  });

  test('clears calleePresence immediately when calleeId is emptied', async () => {
    jest.useFakeTimers();
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'online', online: true }),
    });
    const { resultRef, tree, params } = setup({ calleeId: 'bob' });

    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(resultRef.current.calleePresence).toEqual({ status: 'online', online: true });

    act(() => {
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, calleeId: '' }} />);
    });

    expect(resultRef.current.calleePresence).toBeNull();
    jest.useRealTimers();
  });

  test('recordConnectSuccess clears the offline indicator and error count', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.recordConnectError();
      resultRef.current.recordConnectError();
      resultRef.current.recordConnectError();
    });
    expect(resultRef.current.isServerUnreachable).toBe(true);

    act(() => {
      resultRef.current.recordConnectSuccess();
    });
    expect(resultRef.current.isServerUnreachable).toBe(false);
  });

  test('recordConnectError only flips isServerUnreachable after the threshold', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.recordConnectError();
    });
    expect(resultRef.current.isServerUnreachable).toBe(false);

    act(() => {
      resultRef.current.recordConnectError();
    });
    expect(resultRef.current.isServerUnreachable).toBe(false);

    act(() => {
      resultRef.current.recordConnectError();
    });
    expect(resultRef.current.isServerUnreachable).toBe(true);
  });

  test('resetOfflineTracking clears the indicator and error count', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.recordConnectError();
      resultRef.current.recordConnectError();
      resultRef.current.recordConnectError();
    });
    expect(resultRef.current.isServerUnreachable).toBe(true);

    act(() => {
      resultRef.current.resetOfflineTracking();
    });
    expect(resultRef.current.isServerUnreachable).toBe(false);

    // Error count was reset too: a single subsequent error should not flip it.
    act(() => {
      resultRef.current.recordConnectError();
    });
    expect(resultRef.current.isServerUnreachable).toBe(false);
  });

  test('markServerUnreachable immediately flags the server as unreachable', () => {
    const { resultRef } = setup();
    expect(resultRef.current.isServerUnreachable).toBe(false);
    act(() => {
      resultRef.current.markServerUnreachable();
    });
    expect(resultRef.current.isServerUnreachable).toBe(true);
  });
});
