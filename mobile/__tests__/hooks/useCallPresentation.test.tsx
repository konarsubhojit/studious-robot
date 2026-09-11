import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { logVerbose } from '../../src/appLogger';
import type { CallEndSummary } from '../../src/call/callDecisions';
import type { CallRecoveryStatus } from '../../src/call/recoveryEpisode';
import useCallPresentation from '../../src/hooks/useCallPresentation';

jest.mock('../../src/appLogger', () => ({
  logVerbose: jest.fn(),
}));

type Presentation = ReturnType<typeof useCallPresentation>;

const summary: CallEndSummary = {
  durationSeconds: 42,
  quality: 'Good',
  endReason: 'ended',
  status: 'ended',
  direction: 'outgoing',
  peerId: 'bob',
};

function setup() {
  let current: Presentation;
  let tree: renderer.ReactTestRenderer;
  let renders = 0;
  function TestHook() {
    current = useCallPresentation();
    renders += 1;
    return null;
  }
  act(() => {
    tree = renderer.create(<TestHook />);
  });
  return {
    get current() { return current; },
    get renders() { return renders; },
    rerender: () => act(() => tree.update(<TestHook />)),
    unmount: () => act(() => tree.unmount()),
  };
}

describe('useCallPresentation', () => {
  let hook: ReturnType<typeof setup>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    hook = setup();
  });

  afterEach(() => {
    hook.unmount();
    jest.useRealTimers();
  });

  test('preserves the initial call-screen and legacy-peer defaults', () => {
    expect(hook.current).toMatchObject({
      status: { message: '', severity: 'info' },
      callSummary: null,
      isRemoteScreenSharing: false,
      isRemoteVideoEnabled: true,
      isLocalPrimary: false,
      callConnectedAtMs: null,
      isReconnecting: false,
      recoveryStatus: null,
      isConnectionLost: false,
      callDelivery: null,
    });
  });

  test.each(['info', 'success', 'warning', 'error'] as const)(
    'publishes and logs %s status, defaulting subsequent updates to info',
    severity => {
      act(() => {
        hook.current.updateStatus('Call status', severity);
      });
      expect(hook.current.status).toEqual({ message: 'Call status', severity });
      expect(logVerbose).toHaveBeenLastCalledWith('[CallFlow] Status updated', {
        message: 'Call status',
        severity,
      });

      act(() => {
        hook.current.updateStatus('Ready');
      });
      expect(hook.current.status).toEqual({ message: 'Ready', severity: 'info' });
      expect(logVerbose).toHaveBeenLastCalledWith('[CallFlow] Status updated', {
        message: 'Ready',
        severity: 'info',
      });
    },
  );

  test('dismisses a populated summary without changing other presentation state', () => {
    act(() => {
      hook.current.setCallSummary(summary);
      hook.current.updateStatus('Call ended');
      hook.current.setIsConnectionLost(true);
    });
    expect(hook.current.callSummary).toBe(summary);
    const status = hook.current.status;

    act(() => {
      hook.current.dismissCallSummary();
      hook.current.dismissCallSummary();
    });
    expect(hook.current.callSummary).toBeNull();
    expect(hook.current.status).toBe(status);
    expect(hook.current.isConnectionLost).toBe(true);
  });

  test('keeps setters and actions stable while publishing independently updated values', () => {
    const initial = hook.current;
    const recovery: CallRecoveryStatus = {
      trigger: 'ice-disconnected',
      attempts: 1,
      remainingMs: 5000,
      isPaused: true,
      pauseReason: 'socket-offline',
      isAttemptPending: false,
    };
    act(() => {
      initial.updateStatus('Reconnecting…', 'warning');
      initial.setCallSummary(summary);
      initial.setIsRemoteScreenSharing(true);
      initial.setIsRemoteVideoEnabled(false);
      initial.setIsLocalPrimary(value => !value);
      initial.setCallConnectedAtMs(1000);
      initial.setIsReconnecting(true);
      initial.setRecoveryStatus(recovery);
      initial.setIsConnectionLost(true);
      initial.setCallDelivery('push');
    });
    hook.rerender();
    expect(hook.current).toMatchObject({
      status: { message: 'Reconnecting…', severity: 'warning' },
      callSummary: summary,
      isRemoteScreenSharing: true,
      isRemoteVideoEnabled: false,
      isLocalPrimary: true,
      callConnectedAtMs: 1000,
      isReconnecting: true,
      recoveryStatus: recovery,
      isConnectionLost: true,
      callDelivery: 'push',
    });
    for (const key of Object.keys(initial) as (keyof Presentation)[]) {
      if (typeof initial[key] === 'function') {
        expect(hook.current[key]).toBe(initial[key]);
      }
    }
  });

  test('does not tick or reset connected-call presentation on its own', () => {
    act(() => {
      hook.current.setCallConnectedAtMs(Date.now());
      hook.current.setCallDelivery('ringing');
    });
    const connected = hook.current;
    const renders = hook.renders;
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(hook.renders).toBe(renders);
    expect(hook.current).toBe(connected);
    expect(jest.getTimerCount()).toBe(0);
  });
});
