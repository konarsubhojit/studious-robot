import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useCallHeartbeat from '../../src/hooks/useCallHeartbeat';
import { CALL_HEARTBEAT_DUE_MS } from '../../../shared';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logVerbose: jest.fn(),
  logWarn: jest.fn(),
}));

function TestHook({ resultRef, params }: any) {
  resultRef.current = useCallHeartbeat(params);
  return null;
}

function setup(overrides: any = {}) {
  const request = jest.fn((..._args: any[]) => Promise.resolve());
  const params: any = {
    activeCallIdRef: { current: 'call-1' },
    socketRef: { current: { connected: true } },
    signalingRef: { current: { request } },
    isScreenSharingRef: { current: false },
    ...overrides,
  };
  const resultRef: { current: any } = { current: null };
  act(() => {
    renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });
  return { resultRef, params, request };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useCallHeartbeat', () => {
  test('exposes the start/stop/wake contract', () => {
    const { resultRef } = setup();
    expect(typeof resultRef.current.startCallHeartbeat).toBe('function');
    expect(typeof resultRef.current.stopCallHeartbeat).toBe('function');
    expect(typeof resultRef.current.wakeCallHeartbeat).toBe('function');
  });

  test('a wake inside the due window does not beat, but one past it does', () => {
    const { resultRef, request } = setup();

    act(() => {
      resultRef.current.startCallHeartbeat('media-connected');
    });
    // Just started: a beat is not yet due.
    act(() => {
      resultRef.current.wakeCallHeartbeat('socket-ping');
    });
    expect(request).not.toHaveBeenCalled();

    // Past the due window (but before the 30s interval fires): a wake beats.
    act(() => {
      jest.advanceTimersByTime(CALL_HEARTBEAT_DUE_MS + 10);
      resultRef.current.wakeCallHeartbeat('socket-ping');
    });
    expect(request).toHaveBeenCalledTimes(1);
    const [event, payload] = request.mock.calls[0];
    expect(event).toBe('call.media-state');
    expect(payload.callId).toBe('call-1');
    expect(payload.mediaState.heartbeat).toBe(true);
  });

  test('a stopped heartbeat does not beat on wake', () => {
    const { resultRef, request } = setup();
    act(() => {
      resultRef.current.startCallHeartbeat('media-connected');
      resultRef.current.stopCallHeartbeat('call-ended');
    });
    act(() => {
      jest.advanceTimersByTime(CALL_HEARTBEAT_DUE_MS + 10);
      resultRef.current.wakeCallHeartbeat('socket-ping');
    });
    expect(request).not.toHaveBeenCalled();
  });

  test('a wake with the socket offline does not beat and does not advance the clock', () => {
    const { resultRef, params, request } = setup();
    params.socketRef.current = { connected: false };
    act(() => {
      resultRef.current.startCallHeartbeat('media-connected');
    });
    act(() => {
      jest.advanceTimersByTime(CALL_HEARTBEAT_DUE_MS + 10);
      resultRef.current.wakeCallHeartbeat('socket-ping');
    });
    expect(request).not.toHaveBeenCalled();

    // The missed beat is retried immediately once the socket returns, rather
    // than waiting a further full window.
    params.socketRef.current = { connected: true };
    act(() => {
      resultRef.current.wakeCallHeartbeat('socket-connect');
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
