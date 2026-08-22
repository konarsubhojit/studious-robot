// @ts-check
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useBlocks from '../../src/hooks/useBlocks';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logVerbose: jest.fn(),
}));

function TestHook(/** @type {any} */ { resultRef, params }) {
  resultRef.current = useBlocks(params);
  return null;
}

function setup() {
  const authedFetchRef = {
    current: jest.fn(buildRequest => {
      const request = buildRequest('sess-1');
      return global.fetch(request.url, request.options);
    }),
  };
  /** @type {any} */
  const params = {
    signalingUrl: 'https://signal.example.com',
    authedFetchRef,
    sessionIdRef: { current: 'sess-1' },
  };
  /** @type {{ current: any }} */
  const resultRef = { current: null };
  act(() => {
    renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });
  return { resultRef, params };
}

/** A minimal `fetch` response double. */
function respond(/** @type {any} */ body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = /** @type {any} */ (jest.fn(() => respond({ blockedUsers: [] })));
});

describe('useBlocks', () => {
  test('loads the blocklist from the server', async () => {
    /** @type {jest.Mock} */ (global.fetch).mockImplementation(() => respond({ blockedUsers: ['user-bob'] }));
    const { resultRef } = setup();

    await act(async () => {
      await resultRef.current.fetchBlocks();
    });

    expect(resultRef.current.blockedUsers).toEqual(['user-bob']);
    expect(resultRef.current.isUserBlocked('user-bob')).toBe(true);
    expect(resultRef.current.isUserBlocked('user-carol')).toBe(false);
  });

  test('does not request the blocklist without a session', async () => {
    const { resultRef, params } = setup();
    params.sessionIdRef.current = null;

    await act(async () => {
      await resultRef.current.fetchBlocks();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('blocks a peer and reflects it locally', async () => {
    const { resultRef } = setup();

    let applied;
    await act(async () => {
      applied = await resultRef.current.blockUser('user-bob');
    });

    expect(applied).toBe(true);
    expect(resultRef.current.isUserBlocked('user-bob')).toBe(true);
    const [url, options] = /** @type {jest.Mock} */ (global.fetch).mock.calls[0];
    expect(url).toBe('https://signal.example.com/blocks');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ sessionId: 'sess-1', blockeeId: 'user-bob' });
  });

  test('keeps the peer unblocked when the server rejects the block', async () => {
    /** @type {jest.Mock} */ (global.fetch).mockImplementation(() => respond({}, { ok: false, status: 500 }));
    const { resultRef } = setup();

    let applied;
    await act(async () => {
      applied = await resultRef.current.blockUser('user-bob');
    });

    expect(applied).toBe(false);
    expect(resultRef.current.isUserBlocked('user-bob')).toBe(false);
  });

  test('unblocks a peer, and treats an unknown block as already removed', async () => {
    const { resultRef } = setup();
    await act(async () => {
      await resultRef.current.blockUser('user-bob');
    });

    /** @type {jest.Mock} */ (global.fetch).mockImplementation(() => respond({}, { ok: false, status: 404 }));
    let removed;
    await act(async () => {
      removed = await resultRef.current.unblockUser('user-bob');
    });

    expect(removed).toBe(true);
    expect(resultRef.current.isUserBlocked('user-bob')).toBe(false);
    const [url, options] = /** @type {jest.Mock} */ (global.fetch).mock.calls[1];
    expect(url).toBe('https://signal.example.com/blocks/user-bob?sessionId=sess-1');
    expect(options.method).toBe('DELETE');
  });

  test('ignores a blank peer id', async () => {
    const { resultRef } = setup();

    await act(async () => {
      await expect(resultRef.current.blockUser('  ')).resolves.toBe(false);
      await expect(resultRef.current.unblockUser('')).resolves.toBe(false);
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('survives a network failure', async () => {
    /** @type {jest.Mock} */ (global.fetch).mockImplementation(() => Promise.reject(new Error('offline')));
    const { resultRef } = setup();

    await act(async () => {
      await expect(resultRef.current.blockUser('user-bob')).resolves.toBe(false);
      await resultRef.current.fetchBlocks();
    });

    expect(resultRef.current.blockedUsers).toEqual([]);
  });
});
