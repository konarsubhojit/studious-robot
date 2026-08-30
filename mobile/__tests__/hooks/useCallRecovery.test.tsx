import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useCallRecovery from '../../src/hooks/useCallRecovery';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logVerbose: jest.fn(),
  logWarn: jest.fn(),
}));
jest.mock('../../src/observability', () => ({
  emitMetric: jest.fn(),
}));
jest.mock('../../src/telemetry', () => ({
  trackIceRestart: jest.fn(),
}));
jest.mock('../../src/networkMonitor', () => ({
  subscribeNetworkChanges: jest.fn(() => jest.fn()),
}));
jest.mock('../../src/webrtcConfig', () => ({
  getIceServersForCall: jest.fn(() => Promise.resolve([])),
  getTurnServerEndpoints: jest.fn(() => []),
  resetIceServersForCallCache: jest.fn(),
}));

function TestHook({ resultRef, params }: any) {
  resultRef.current = useCallRecovery(params);
  return null;
}

function setup(overrides: any = {}) {
  const emit = jest.fn((_event: string, _payload: unknown, ack?: (a: any) => void) => {
    ack?.({ ok: true });
  });
  const startCallHeartbeat = jest.fn();
  const setRecoveryStatus = jest.fn();
  const setIsReconnecting = jest.fn();
  const setIsConnectionLost = jest.fn();
  const params: any = {
    activeCallIdRef: { current: 'call-1' },
    activeCallRef: { current: { callerId: 'a', calleeId: 'b' } },
    isCallerRef: { current: true },
    peerConnectionRef: { current: { iceConnectionState: 'failed', connectionState: 'failed' } },
    socketRef: { current: { connected: true } },
    signalingRef: { current: { emit } },
    isNegotiatingRef: { current: false },
    userIdRef: { current: 'a' },
    connectedReportedCallIdRef: { current: null },
    isConnectionLostRef: { current: false },
    signalingUrl: 'https://signal.example',
    activeIceTransportPolicy: 'all',
    ensureIceSessionId: jest.fn(() => Promise.resolve('session-1')),
    startCallHeartbeat,
    setRecoveryStatus,
    setIsReconnecting,
    setIsConnectionLost,
    ...overrides,
  };
  const resultRef: { current: any } = { current: null };
  act(() => {
    renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });
  return { resultRef, params, emit, startCallHeartbeat, setRecoveryStatus, setIsReconnecting };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('useCallRecovery', () => {
  test('exposes the recovery callbacks and forward-refs', () => {
    const { resultRef } = setup();
    const r = resultRef.current;
    for (const name of [
      'closeRecoveryEpisode',
      'reportCallConnected',
      'noteRecoverySymptom',
      'beginIceRecovery',
      'cancelIceRestarts',
    ]) {
      expect(typeof r[name]).toBe('function');
    }
    // The forward-refs are wired to the current callback identity via effect.
    expect(r.noteRecoverySymptomRef.current).toBe(r.noteRecoverySymptom);
    expect(r.beginIceRecoveryRef.current).toBe(r.beginIceRecovery);
    expect(r.cancelIceRestartsRef.current).toBe(r.cancelIceRestarts);
    expect(typeof r.pauseRecoveryBudgetRef.current).toBe('function');
    expect(typeof r.resumeRecoveryBudgetRef.current).toBe('function');
  });

  test('a symptom opens an episode and shows the reconnecting banner', () => {
    const { resultRef, setIsReconnecting, setRecoveryStatus } = setup();
    act(() => {
      resultRef.current.noteRecoverySymptom('ice-failure', 'failed');
    });
    expect(setIsReconnecting).toHaveBeenCalledWith(true);
    // The banner is published with a non-null status once an episode is open.
    const published = setRecoveryStatus.mock.calls.map(c => c[0]).filter(Boolean);
    expect(published.length).toBeGreaterThan(0);
    expect(published[published.length - 1].trigger).toBe('ice-failure');
  });

  test('reporting media connected starts the heartbeat and tells the server', () => {
    const { resultRef, emit, startCallHeartbeat, params } = setup();
    act(() => {
      resultRef.current.reportCallConnected('connected');
    });
    expect(startCallHeartbeat).toHaveBeenCalledWith('media-connected:connected');
    expect(params.connectedReportedCallIdRef.current).toBe('call-1');
    const connectedEmit = emit.mock.calls.find(c => c[0] === 'call.connected');
    expect(connectedEmit).toBeTruthy();
    expect(connectedEmit?.[1]).toMatchObject({ callId: 'call-1', iceState: 'connected' });
  });

  test('a second connected report for the same call is not re-emitted', () => {
    const { resultRef, emit } = setup();
    act(() => {
      resultRef.current.reportCallConnected('connected');
      resultRef.current.reportCallConnected('completed');
    });
    const connectedEmits = emit.mock.calls.filter(c => c[0] === 'call.connected');
    expect(connectedEmits).toHaveLength(1);
  });

  test('cancelling the ladder refreshes the recovery banner', () => {
    const { resultRef, setRecoveryStatus } = setup();
    setRecoveryStatus.mockClear();
    act(() => {
      resultRef.current.cancelIceRestarts('ice-connected');
    });
    expect(setRecoveryStatus).toHaveBeenCalled();
  });

  test('with no active call, a symptom is ignored', () => {
    const { resultRef, setIsReconnecting } = setup({ activeCallIdRef: { current: null } });
    act(() => {
      resultRef.current.noteRecoverySymptom('ice-failure', 'failed');
    });
    expect(setIsReconnecting).not.toHaveBeenCalled();
  });
});
