import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useSession from '../../src/hooks/useSession';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logVerbose: jest.fn(),
}));

jest.mock('../../src/settingsStorage', () => ({
  loadDeviceId: jest.fn(async () => 'device-test-1'),
}));
jest.mock('../../src/authService', () => ({
  isGoogleSignInConfigured: jest.fn(() => true),
  isMicrosoftSignInConfigured: jest.fn(() => true),
  getIdToken: jest.fn(async () => 'firebase-id-token'),
}));

const { loadDeviceId } = require('../../src/settingsStorage');

function TestHook({ resultRef, params }: any) {
  resultRef.current = useSession(params);
  return null;
}

function setup(overrides = {}) {
  const params = {
    signalingUrl: 'https://signal.example.com',
    userId: 'alice',
    updateStatus: jest.fn(),
    ...overrides,
  };
  const resultRef: { current: any; } = { current: null };
  let tree: any;
  act(() => {
    tree = renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });
  return { resultRef, params, tree };
}

beforeEach(() => {
  jest.clearAllMocks();
  (loadDeviceId as jest.Mock).mockResolvedValue('device-test-1');
  global.fetch = (jest.fn() as any);
});

describe('useSession', () => {
  test('createOrGetSession posts to /session and stores the returned sessionId', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'sess-1', userId: 'alice' }),
    });
    const { resultRef } = setup();

    let sessionId;
    await act(async () => {
      sessionId = await resultRef.current.createOrGetSession();
    });

    expect(sessionId).toBe('sess-1');
    expect(resultRef.current.sessionIdRef.current).toBe('sess-1');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://signal.example.com/session',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toEqual({
      userId: 'alice',
      deviceId: 'device-test-1',
      platform: expect.any(String),
      idToken: 'firebase-id-token',
    });
  });

  test('createOrGetSession returns the cached sessionId without refetching', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'sess-1', userId: 'alice' }),
    });
    const { resultRef } = setup();

    await act(async () => {
      await resultRef.current.createOrGetSession();
    });
    (global.fetch as jest.Mock).mockClear();

    let sessionId;
    await act(async () => {
      sessionId = await resultRef.current.createOrGetSession();
    });

    expect(sessionId).toBe('sess-1');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('concurrent session consumers share one POST /session and authoritative id', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'sess-shared', userId: 'alice' }),
    });
    const { resultRef } = setup();

    let sessions!: string[];
    await act(async () => {
      sessions = await Promise.all([
        resultRef.current.createOrGetSession(),
        resultRef.current.createOrGetSession(),
        resultRef.current.createOrGetSession(),
      ]);
    });

    expect(sessions).toEqual(['sess-shared', 'sess-shared', 'sess-shared']);
    expect(resultRef.current.sessionIdRef.current).toBe('sess-shared');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('identity changes invalidate the cached session and mint a new one', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessionId: 'sess-alice', userId: 'alice' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessionId: 'sess-bob', userId: 'bob' }),
      });
    const { resultRef, params, tree } = setup();

    await act(async () => {
      await resultRef.current.createOrGetSession();
    });
    act(() => {
      tree.update(
        <TestHook resultRef={resultRef} params={{ ...params, userId: 'bob' }} />,
      );
    });
    let sessionId;
    await act(async () => {
      sessionId = await resultRef.current.createOrGetSession();
    });

    expect(sessionId).toBe('sess-bob');
    expect(resultRef.current.sessionIdRef.current).toBe('sess-bob');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('a late response for the previous identity cannot replace the authoritative id', async () => {
    let resolveAlice!: (data: any) => void;
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: () => new Promise(resolve => {
          resolveAlice = resolve;
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessionId: 'sess-bob', userId: 'bob' }),
      });
    const { resultRef, params, tree } = setup();

    let aliceSessionPromise!: Promise<string>;
    await act(async () => {
      aliceSessionPromise = resultRef.current.createOrGetSession();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      tree.update(
        <TestHook resultRef={resultRef} params={{ ...params, userId: 'bob' }} />,
      );
    });
    await act(async () => {
      await resultRef.current.createOrGetSession();
    });
    await act(async () => {
      resolveAlice({ sessionId: 'sess-alice', userId: 'alice' });
      await aliceSessionPromise;
    });

    expect(resultRef.current.sessionIdRef.current).toBe('sess-bob');
  });

  test('createOrGetSession surfaces an identity_conflict as a friendly status message', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: 'identity_claimed' }),
    });
    const { resultRef, params } = setup();

    let caughtError: any;
    await act(async () => {
      try {
        await resultRef.current.createOrGetSession();
      } catch (error) {
        caughtError = error;
      }
    });

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError.message).toContain('Session creation failed');
    expect(params.updateStatus).toHaveBeenCalledWith(
      expect.stringContaining('bound'),
      'error',
    );
  });

  test('refreshSession rotates the sessionId on success', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: 'sess-1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: 'sess-2' }) });
    const { resultRef } = setup();

    await act(async () => {
      await resultRef.current.createOrGetSession();
    });

    let refreshed;
    await act(async () => {
      refreshed = await resultRef.current.refreshSession();
    });

    expect(refreshed).toBe('sess-2');
    expect(resultRef.current.sessionIdRef.current).toBe('sess-2');
  });

  test('refreshSession clears the sessionId and returns null on failure', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: 'sess-1' }) })
      .mockResolvedValueOnce({ ok: false, status: 410 });
    const { resultRef } = setup();

    await act(async () => {
      await resultRef.current.createOrGetSession();
    });

    let refreshed;
    await act(async () => {
      refreshed = await resultRef.current.refreshSession();
    });

    expect(refreshed).toBeNull();
    expect(resultRef.current.sessionIdRef.current).toBeNull();
  });

  test('refreshSession is a no-op when there is no current session', async () => {
    const { resultRef } = setup();

    let refreshed;
    await act(async () => {
      refreshed = await resultRef.current.refreshSession();
    });

    expect(refreshed).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('authedFetch retries once after a 401 by refreshing the session', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: 'sess-1' }) }) // createOrGetSession
      .mockResolvedValueOnce({ status: 401, ok: false }) // first authed call
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: 'sess-2' }) }) // refreshSession
      .mockResolvedValueOnce({ status: 200, ok: true }); // retried authed call
    const { resultRef } = setup();

    await act(async () => {
      await resultRef.current.createOrGetSession();
    });

    let response: any;
    await act(async () => {
      response = await resultRef.current.authedFetch((sessionId: any) => ({
        url: 'https://signal.example.com/thing',
        options: { headers: { Authorization: `Bearer ${sessionId}` } },
      }));
    });

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenLastCalledWith('https://signal.example.com/thing', {
      headers: { Authorization: 'Bearer sess-2' },
    });
  });

  test('authedFetch returns null when no session can be established', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const { resultRef } = setup();

    let response: any;
    await act(async () => {
      response = await resultRef.current.authedFetch((sessionId: any) => ({
        url: `https://signal.example.com/thing#${sessionId}`,
      }));
    });

    expect(response).toBeNull();
  });

  test('authedFetchRef.current mirrors the latest authedFetch implementation', async () => {
    const { resultRef } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    expect(resultRef.current.authedFetchRef.current).toBe(resultRef.current.authedFetch);
  });
});
