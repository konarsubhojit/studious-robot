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
  getIdToken: jest.fn(async () => 'firebase-id-token'),
}));

const { loadDeviceId } = require('../../src/settingsStorage');

function TestHook({ resultRef, params }) {
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
  const resultRef = { current: null };
  act(() => {
    renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });
  return { resultRef, params };
}

beforeEach(() => {
  jest.clearAllMocks();
  loadDeviceId.mockResolvedValue('device-test-1');
  global.fetch = jest.fn();
});

describe('useSession', () => {
  test('createOrGetSession posts to /session and stores the returned sessionId', async () => {
    global.fetch.mockResolvedValue({
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
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({
      userId: 'alice',
      deviceId: 'device-test-1',
      platform: expect.any(String),
      idToken: 'firebase-id-token',
    });
  });

  test('createOrGetSession returns the cached sessionId without refetching', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'sess-1', userId: 'alice' }),
    });
    const { resultRef } = setup();

    await act(async () => {
      await resultRef.current.createOrGetSession();
    });
    global.fetch.mockClear();

    let sessionId;
    await act(async () => {
      sessionId = await resultRef.current.createOrGetSession();
    });

    expect(sessionId).toBe('sess-1');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('createOrGetSession surfaces an identity_conflict as a friendly status message', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: 'identity_claimed' }),
    });
    const { resultRef, params } = setup();

    let caughtError;
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
    global.fetch
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
    global.fetch
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
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: 'sess-1' }) }) // createOrGetSession
      .mockResolvedValueOnce({ status: 401, ok: false }) // first authed call
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: 'sess-2' }) }) // refreshSession
      .mockResolvedValueOnce({ status: 200, ok: true }); // retried authed call
    const { resultRef } = setup();

    await act(async () => {
      await resultRef.current.createOrGetSession();
    });

    let response;
    await act(async () => {
      response = await resultRef.current.authedFetch(sessionId => ({
        url: `https://signal.example.com/thing?sessionId=${sessionId}`,
      }));
    });

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenLastCalledWith(
      'https://signal.example.com/thing?sessionId=sess-2',
      undefined,
    );
  });

  test('authedFetch returns null when no session can be established', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500 });
    const { resultRef } = setup();

    let response;
    await act(async () => {
      response = await resultRef.current.authedFetch(sessionId => ({
        url: `https://signal.example.com/thing?sessionId=${sessionId}`,
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
