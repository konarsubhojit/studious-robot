import React from 'react';
import { AppState } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import useConnectionQuality from '../../src/hooks/useConnectionQuality';

jest.mock('../../src/appLogger', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('../../src/telemetry', () => ({
  trackSelectedCandidatePair: jest.fn(),
}));

const Telemetry = require('../../src/telemetry');

function makeReport(stats: any[]) {
  const byId = new Map(stats.map(stat => [stat.id, stat]));
  return {
    forEach: (fn: (stat: any) => void) => stats.forEach(fn),
    get: (id: unknown) => byId.get(id),
  };
}

function makeStatsReport({
  rtt = 0.05,
  packetsLost = 0,
  packetsReceived = 100,
  bytesReceived = 100_000,
  localType = 'relay',
  remoteType = 'srflx',
} = {}) {
  return makeReport([
    {
      id: 'pair-1',
      type: 'candidate-pair',
      state: 'succeeded',
      selected: true,
      localCandidateId: 'local-1',
      remoteCandidateId: 'remote-1',
      currentRoundTripTime: rtt,
    },
    {
      id: 'local-1',
      type: 'local-candidate',
      candidateType: localType,
      protocol: 'udp',
      relayProtocol: localType === 'relay' ? 'udp' : undefined,
    },
    {
      id: 'remote-1',
      type: 'remote-candidate',
      candidateType: remoteType,
      protocol: 'udp',
    },
    {
      id: 'inbound-video',
      type: 'inbound-rtp',
      kind: 'video',
      packetsLost,
      packetsReceived,
      bytesReceived,
    },
  ]);
}

function TestHook({ resultRef, params, renderCountRef }: any) {
  renderCountRef.current += 1;
  resultRef.current = useConnectionQuality(params);
  return null;
}

function setAppState(state: string) {
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: state,
  });
}

function setup(overrides: any = {}) {
  const getStats = jest.fn(() => Promise.resolve(makeStatsReport()));
  const params: any = {
    activeCallIdRef: { current: 'call-1' },
    activeIceTransportPolicy: 'all',
    isInCall: true,
    peerConnectionRef: { current: { getStats } },
    remoteStreamRef: { current: null },
    updateStatus: jest.fn(),
    ...overrides,
  };
  const resultRef: { current: any } = { current: null };
  const renderCountRef = { current: 0 };
  let instance: renderer.ReactTestRenderer;
  act(() => {
    instance = renderer.create(
      <TestHook resultRef={resultRef} params={params} renderCountRef={renderCountRef} />,
    );
  });
  return { getStats, instance: instance!, params, renderCountRef, resultRef };
}

let capturedAppStateListener: ((state: string) => void) | null;
let removeAppStateListener: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-10T16:00:00.000Z'));
  jest.clearAllMocks();
  capturedAppStateListener = null;
  removeAppStateListener = jest.fn();
  setAppState('active');
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    capturedAppStateListener = listener as (state: string) => void;
    return { remove: removeAppStateListener } as any;
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('useConnectionQuality', () => {
  test('polls immediately in foreground and publishes quality plus candidate pair', async () => {
    const { getStats, resultRef } = setup();

    await act(async () => {});

    expect(getStats).toHaveBeenCalledTimes(1);
    expect(resultRef.current.connectionQuality).toEqual({ bars: 3, label: 'Strong' });
    expect(resultRef.current.selectedCandidatePair).toEqual({
      local: 'relay',
      remote: 'srflx',
      protocol: 'udp',
      relayProtocol: 'udp',
      usingTurn: true,
      relaySide: 'local',
    });
    expect(Telemetry.trackSelectedCandidatePair).toHaveBeenCalledWith('call-1', 'relay');
  });

  test('does not poll while backgrounded until the app returns foreground', async () => {
    setAppState('background');
    const { getStats } = setup();
    await act(async () => {});
    expect(getStats).not.toHaveBeenCalled();

    act(() => {
      capturedAppStateListener?.('active');
    });
    await act(async () => {});

    expect(getStats).toHaveBeenCalledTimes(1);
  });

  test('warns when packet loss crosses the poor-connection threshold', async () => {
    const getStats = jest.fn(() => Promise.resolve(makeStatsReport({
      packetsLost: 30,
      packetsReceived: 100,
    })));
    const { params } = setup({ peerConnectionRef: { current: { getStats } } });

    await act(async () => {});

    expect(params.updateStatus).toHaveBeenCalledWith(
      'Poor connection — high packet loss detected',
      'error',
    );
  });

  test('keeps the quality object identity when a repeated sample is unchanged', async () => {
    const { resultRef } = setup();
    await act(async () => {});
    const firstQuality = resultRef.current.connectionQuality;

    act(() => {
      jest.advanceTimersByTime(7000);
    });
    await act(async () => {});

    expect(resultRef.current.connectionQuality).toBe(firstQuality);
  });

  test('resets quality and selected pair when the call ends', async () => {
    const { instance, params, resultRef } = setup();
    await act(async () => {});
    expect(resultRef.current.connectionQuality.label).toBe('Strong');

    act(() => {
      instance.update(
        <TestHook
          resultRef={resultRef}
          params={{ ...params, isInCall: false }}
          renderCountRef={{ current: 0 }}
        />,
      );
    });
    await act(async () => {});

    expect(resultRef.current.connectionQuality).toEqual({ bars: 0, label: 'No link' });
    expect(resultRef.current.selectedCandidatePair).toBeNull();
    expect(removeAppStateListener).toHaveBeenCalledTimes(1);
  });
});
