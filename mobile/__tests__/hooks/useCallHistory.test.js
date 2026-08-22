// @ts-check
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useCallHistory from '../../src/hooks/useCallHistory';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logVerbose: jest.fn(),
}));

function TestHook(/** @type {any} */ { resultRef, params }) {
  resultRef.current = useCallHistory(params);
  return null;
}

function setup(overrides = {}) {
  const params = {
    authedFetchRef: { current: jest.fn() },
    sessionIdRef: { current: 'sess-1' },
    signalingUrl: 'https://signal.example.com',
    userId: 'alice',
    ...overrides,
  };
  /** @type {{ current: any }} */
  const resultRef = { current: null };
  act(() => {
    renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });
  return { resultRef, params };
}

describe('useCallHistory', () => {
  test('initialises with an empty history and zero missed calls', () => {
    const { resultRef } = setup();
    expect(resultRef.current.callHistory).toEqual([]);
    expect(resultRef.current.missedCallCount).toBe(0);
  });

  test('addToHistory prepends a new entry', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.addToHistory({ callId: 'c1', direction: 'outgoing', status: 'ended' });
    });
    expect(resultRef.current.callHistory).toEqual([
      { callId: 'c1', direction: 'outgoing', status: 'ended' },
    ]);
  });

  test('addToHistory deduplicates by callId, keeping the newest version first', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.addToHistory({ callId: 'c1', status: 'ringing' });
    });
    act(() => {
      resultRef.current.addToHistory({ callId: 'c2', status: 'ended' });
    });
    act(() => {
      resultRef.current.addToHistory({ callId: 'c1', status: 'ended' });
    });
    expect(resultRef.current.callHistory).toEqual([
      { callId: 'c1', status: 'ended' },
      { callId: 'c2', status: 'ended' },
    ]);
  });

  test('addToHistory caps the list at 50 entries', () => {
    const { resultRef } = setup();
    act(() => {
      for (let i = 0; i < 55; i += 1) {
        resultRef.current.addToHistory({ callId: `c${i}`, status: 'ended' });
      }
    });
    expect(resultRef.current.callHistory).toHaveLength(50);
    expect(resultRef.current.callHistory[0].callId).toBe('c54');
  });

  test('missedCallCount counts only unread missed/timeout incoming calls', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.addToHistory({
        callId: 'c1',
        direction: 'incoming',
        status: 'missed',
        isRead: false,
      });
      resultRef.current.addToHistory({
        callId: 'c2',
        direction: 'incoming',
        endReason: 'timeout',
        isRead: false,
      });
      resultRef.current.addToHistory({
        callId: 'c3',
        direction: 'incoming',
        status: 'missed',
        isRead: true,
      });
      resultRef.current.addToHistory({
        callId: 'c4',
        direction: 'outgoing',
        status: 'missed',
        isRead: false,
      });
    });
    expect(resultRef.current.missedCallCount).toBe(2);
  });

  test('markMissedCallsRead marks every entry as read', () => {
    const { resultRef } = setup();
    act(() => {
      resultRef.current.addToHistory({
        callId: 'c1',
        direction: 'incoming',
        status: 'missed',
        isRead: false,
      });
    });
    expect(resultRef.current.missedCallCount).toBe(1);
    act(() => {
      resultRef.current.markMissedCallsRead();
    });
    expect(resultRef.current.missedCallCount).toBe(0);
    expect(resultRef.current.callHistory[0].isRead).toBe(true);
  });

  test('fetchCallHistory is a no-op when there is no session', async () => {
    const { resultRef, params } = setup({ sessionIdRef: { current: null } });
    await act(async () => {
      await resultRef.current.fetchCallHistory();
    });
    expect(params.authedFetchRef.current).not.toHaveBeenCalled();
    expect(resultRef.current.callHistory).toEqual([]);
  });

  test('fetchCallHistory populates callHistory, tagging direction/isRead per entry', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({
      ok: true,
      json: async () => ({
        calls: [
          {
            callId: 'c1',
            callerId: 'alice',
            calleeId: 'bob',
            status: 'ended',
            endReason: 'hangup',
            createdAt: '2024-01-01T00:00:00Z',
          },
          {
            callId: 'c2',
            callerId: 'bob',
            calleeId: 'alice',
            status: 'missed',
            endReason: 'timeout',
            createdAt: '2024-01-02T00:00:00Z',
          },
        ],
      }),
    });

    await act(async () => {
      await resultRef.current.fetchCallHistory(10);
    });

    expect(params.authedFetchRef.current).toHaveBeenCalledWith(expect.any(Function));
    expect(resultRef.current.callHistory).toEqual([
      {
        callId: 'c1',
        callerId: 'alice',
        calleeId: 'bob',
        direction: 'outgoing',
        status: 'ended',
        endReason: 'hangup',
        createdAt: '2024-01-01T00:00:00Z',
        durationSeconds: null,
        isRead: true,
      },
      {
        callId: 'c2',
        callerId: 'bob',
        calleeId: 'alice',
        direction: 'incoming',
        status: 'missed',
        endReason: 'timeout',
        createdAt: '2024-01-02T00:00:00Z',
        durationSeconds: null,
        isRead: false,
      },
    ]);
  });

  test('fetchCallHistory silently no-ops on a fetch error', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockRejectedValue(new Error('network down'));

    await act(async () => {
      await resultRef.current.fetchCallHistory();
    });

    expect(resultRef.current.callHistory).toEqual([]);
  });

  test('fetchCallHistory no-ops when the response is not ok', async () => {
    const { resultRef, params } = setup();
    params.authedFetchRef.current.mockResolvedValue({ ok: false });

    await act(async () => {
      await resultRef.current.fetchCallHistory();
    });

    expect(resultRef.current.callHistory).toEqual([]);
  });
});
