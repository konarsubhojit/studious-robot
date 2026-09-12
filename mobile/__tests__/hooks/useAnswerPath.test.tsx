import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useAnswerPath from '../../src/hooks/useAnswerPath';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('../../src/callKeep', () => ({
  bringAppToForeground: jest.fn(),
  clearPendingAnswer: jest.fn(),
  consumePendingAnswer: jest.fn(() => false),
  endCall: jest.fn(),
  peekPendingAnswer: jest.fn(() => null),
  recordPendingAnswer: jest.fn(),
  reportCallConnected: jest.fn(),
  setCallActionHandlers: jest.fn(() => jest.fn()),
  setupCallKeep: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/incomingCallNotification', () => ({
  consumePendingCallAction: jest.fn(() => Promise.resolve(null)),
  dismissIncomingCallNotification: jest.fn(() => true),
}));

jest.mock('../../src/observability', () => ({
  emitEvent: jest.fn(),
}));

jest.mock('../../src/permissions', () => ({
  getMissingCallPermissions: jest.fn(() => Promise.resolve({ missing: [] })),
}));

jest.mock('../../src/pushNotifications', () => ({
  installForegroundMessageHandler: jest.fn(() => jest.fn()),
  sendPushReceipt: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/ringtone', () => ({
  stopIncomingRingtone: jest.fn(),
}));

jest.mock('../../src/telemetry', () => ({
  trackCallStart: jest.fn(),
}));

const callKeep = require('../../src/callKeep');
const incomingCallNotification = require('../../src/incomingCallNotification');
const { sendPushReceipt } = require('../../src/pushNotifications');

function TestHook({ params, resultRef }: any) {
  resultRef.current = useAnswerPath(params);
  return null;
}

function setup(overrides: any = {}) {
  const incomingCall = {
    callId: 'call-1',
    callerId: 'bob',
    calleeId: 'alice',
    status: 'ringing',
  };
  const signaling = {
    request: jest.fn(() =>
      Promise.resolve({
        call: { ...incomingCall, status: 'accepted' },
      }),
    ),
  };
  const params = {
    acceptInFlightCallIdRef: { current: null },
    activeCallIdRef: { current: null },
    activeCallRef: { current: null },
    authedFetchRef: { current: jest.fn() },
    answeredCallIdsRef: { current: new Set<string>() },
    connectSocket: jest.fn(),
    createOrGetSession: jest.fn(() => Promise.resolve('session-1')),
    dismissIncomingCallElsewhere: jest.fn(),
    endActiveCall: jest.fn(),
    endActiveCallRef: { current: jest.fn() },
    ensurePeerConnection: jest.fn(() => Promise.resolve(null)),
    incomingCall,
    incomingCallRef: { current: incomingCall },
    isCallerRef: { current: true },
    rehydrateCallFromPushRef: { current: jest.fn(() => Promise.resolve('ringing')) },
    replayedAnswerCallIdsRef: { current: new Set<string>() },
    sessionIdRef: { current: 'session-1' },
    setActiveCall: jest.fn(),
    setCallSummary: jest.fn(),
    setIncomingCall: jest.fn(),
    signalingRef: { current: signaling },
    signalingUrl: 'https://signal.example.test',
    socketRef: { current: { connected: true } },
    startLocalPreview: jest.fn(() => Promise.resolve({})),
    triggerHaptic: jest.fn(),
    updateStatus: jest.fn(),
    userIdRef: { current: 'alice' },
    recordTimelineCallRef: { current: jest.fn() },
    ...overrides,
  };
  const resultRef: { current: any } = { current: null };
  let instance: renderer.ReactTestRenderer;
  act(() => {
    instance = renderer.create(<TestHook params={params} resultRef={resultRef} />);
  });
  return { instance: instance!, params, resultRef, signaling };
}

beforeEach(() => {
  jest.clearAllMocks();
  callKeep.consumePendingAnswer.mockReturnValue(false);
  callKeep.peekPendingAnswer.mockReturnValue(null);
  callKeep.setupCallKeep.mockResolvedValue(undefined);
  callKeep.setCallActionHandlers.mockReturnValue(jest.fn());
});

describe('useAnswerPath', () => {
  test('skips a duplicate accept without calling the server', async () => {
    const answeredCallIdsRef = { current: new Set(['call-1']) };
    const { params, resultRef, signaling } = setup({ answeredCallIdsRef });

    await act(async () => {
      await resultRef.current.acceptIncomingCall();
    });

    expect(signaling.request).not.toHaveBeenCalled();
    expect(sendPushReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-1',
        stage: 'answer_skipped_duplicate',
      }),
    );
    expect(params.setActiveCall).not.toHaveBeenCalled();
  });

  test('declines the current incoming call over the live socket and ends locally', async () => {
    const { params, resultRef, signaling } = setup();

    await act(async () => {
      await resultRef.current.declineIncomingCall();
    });

    expect(signaling.request).toHaveBeenCalledWith('call.decline', {
      version: 1,
      callId: 'call-1',
    });
    expect(incomingCallNotification.dismissIncomingCallNotification).toHaveBeenCalledWith('call-1');
    expect(params.endActiveCall).toHaveBeenCalledWith('Call declined', 'info', 'declined');
  });

  test('replays a queued answer once the matching incoming call is known', async () => {
    callKeep.consumePendingAnswer.mockReturnValue(true);
    const { params } = setup();

    await act(async () => {});

    expect(callKeep.consumePendingAnswer).toHaveBeenCalledWith('call-1');
    expect(params.setActiveCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-1', status: 'accepted' }),
    );
  });

  test('CallKeep answer for an unknown call records the single shared queue and rehydrates', () => {
    const { params } = setup();
    const handlers = callKeep.setCallActionHandlers.mock.calls[0][0];

    act(() => {
      handlers.onAnswer('call-unknown');
    });

    expect(callKeep.recordPendingAnswer).toHaveBeenCalledWith(
      'call-unknown',
      'call_flow_unknown_call',
    );
    expect(params.rehydrateCallFromPushRef.current).toHaveBeenCalledWith('call-unknown');
  });

  test('CallKeep end declines a ringing call through the latest decline handler', async () => {
    const { params } = setup();
    const handlers = callKeep.setCallActionHandlers.mock.calls[0][0];

    await act(async () => {
      handlers.onEnd('call-1');
    });

    expect(callKeep.clearPendingAnswer).toHaveBeenCalledWith('call-1', 'ended_before_answer');
    expect(params.endActiveCall).toHaveBeenCalledWith('Call declined', 'info', 'declined');
  });
});
