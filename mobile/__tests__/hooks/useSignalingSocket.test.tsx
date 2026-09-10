import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useSignalingSocket from '../../src/hooks/useSignalingSocket';

jest.mock('../../src/appLogger', () => ({
  logInfo: jest.fn(),
}));

function TestHook({ params, resultRef }: any) {
  resultRef.current = useSignalingSocket(params);
  return null;
}

function setup(overrides: any = {}) {
  const detachManagerPing = jest.fn();
  const disconnect = jest.fn();
  const dispose = jest.fn();
  const params = {
    detachManagerPingRef: { current: detachManagerPing },
    resetTypingStateRef: { current: jest.fn() },
    signalingRef: { current: { dispose } },
    socketRef: { current: { disconnect } },
    ...overrides,
  };
  const resultRef: { current: any } = { current: null };
  act(() => {
    renderer.create(<TestHook params={params} resultRef={resultRef} />);
  });
  return { detachManagerPing, disconnect, dispose, params, resultRef };
}

describe('useSignalingSocket', () => {
  test('disconnects the socket, disposes signaling listeners and resets typing state', () => {
    const { detachManagerPing, disconnect, dispose, params, resultRef } = setup();

    act(() => {
      resultRef.current.disconnectSocket();
    });

    expect(detachManagerPing).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(params.socketRef.current).toBeNull();
    expect(params.signalingRef.current).toBeNull();
    expect(params.detachManagerPingRef.current).toBeNull();
    expect(params.resetTypingStateRef.current).toHaveBeenCalledTimes(1);
  });

  test('still resets typing state when no socket is present', () => {
    const { detachManagerPing, params, resultRef } = setup({
      signalingRef: { current: null },
      socketRef: { current: null },
    });

    act(() => {
      resultRef.current.disconnectSocket();
    });

    expect(detachManagerPing).toHaveBeenCalledTimes(1);
    expect(params.resetTypingStateRef.current).toHaveBeenCalledTimes(1);
  });
});
