import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useCallFlow, { CALL_PHASES } from '../../src/hooks/useCallFlow';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('socket.io-client', () => ({
  io: jest.fn(() => ({
    connected: true,
    id: 'mock-socket-id',
    disconnect: jest.fn(),
    off: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(),
  })),
}));

jest.mock('react-native-webrtc', () => ({
  mediaDevices: { getUserMedia: jest.fn() },
  RTCIceCandidate: jest.fn(),
  RTCPeerConnection: jest.fn(),
  RTCSessionDescription: jest.fn(),
}));

jest.mock('../../src/appLogger', () => ({
  clearLogs: jest.fn(),
  getLogsAsText: jest.fn(),
  logDebug: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('../../src/audioRouting', () => ({
  AUDIO_ROUTES: { SPEAKER_PHONE: 'speakerphone' },
  chooseAudioRoute: jest.fn(),
  setAudioRoute: jest.fn(() => ({ ok: true })),
  startAudioSession: jest.fn(() => ({ ok: true })),
  stopAudioSession: jest.fn(() => ({ ok: true })),
  subscribeAudioDevices: jest.fn(() => jest.fn()),
}));

jest.mock('../../src/callService', () => ({
  startCallService: jest.fn(() => true),
  stopCallService: jest.fn(),
}));

jest.mock('../../src/hooks/useCompactCallView', () =>
  jest.fn(() => ({ isCompactView: false, setIsCompactView: jest.fn() })),
);

jest.mock('../../src/callUx', () => ({
  getConnectionQuality: jest.fn(() => ({ bars: 3, label: 'Strong' })),
}));

jest.mock('../../src/diagnostics', () => ({
  buildExportHeader: jest.fn(),
  getMediaAccessStatus: jest.fn((e) => e?.message || 'media error'),
  getSocketTransportName: jest.fn(),
  sanitizeUrlForLog: jest.fn((u) => u),
  summarizeIceCandidate: jest.fn(),
  writeLogsFile: jest.fn(),
}));

jest.mock('../../src/mediaControls', () => ({
  isTrackEnabled: jest.fn(() => true),
  setTrackEnabled: jest.fn(() => true),
}));

jest.mock('../../src/permissions', () => ({
  ensureCallPermissions: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../../src/socketConfig', () => ({
  getSocketOptions: jest.fn(() => ({})),
  isRecoverableDisconnectReason: jest.fn(),
}));

jest.mock('../../src/webrtcConfig', () => ({ getIceServers: jest.fn(() => []) }));

jest.mock('../../src/pushNotifications', () => ({
  getInitialCallLink: jest.fn(async () => null),
  addCallLinkListener: jest.fn(() => jest.fn()),
  registerPushToken: jest.fn(async () => true),
  unregisterPushToken: jest.fn(async () => true),
}));

// ─── Test helpers ─────────────────────────────────────────────────────────────

function TestHook({ resultRef }) {
  const result = useCallFlow();
  resultRef.current = result;
  return null;
}

function renderHook() {
  const resultRef = { current: null };
  let tree;
  act(() => {
    tree = renderer.create(<TestHook resultRef={resultRef} />);
  });
  return { resultRef, tree };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useCallFlow', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('initialises with idle callPhase', () => {
    const { resultRef } = renderHook();
    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
    expect(resultRef.current.isInCall).toBe(false);
    expect(resultRef.current.activeCall).toBeNull();
    expect(resultRef.current.incomingCall).toBeNull();
  });

  test('initialises connectionQuality with no-link defaults', () => {
    const { resultRef } = renderHook();
    expect(resultRef.current.connectionQuality).toEqual({ bars: 0, label: 'No link' });
  });

  test('exposes identity setters', () => {
    const { resultRef } = renderHook();
    expect(typeof resultRef.current.setUserId).toBe('function');
    expect(typeof resultRef.current.setCalleeId).toBe('function');
    expect(typeof resultRef.current.setSignalingUrl).toBe('function');
  });

  test('exposes all required call action callbacks', () => {
    const { resultRef } = renderHook();
    const required = [
      'placeCall',
      'cancelOutgoingCall',
      'acceptIncomingCall',
      'declineIncomingCall',
      'handleEndCall',
      'startLocalPreview',
    ];
    for (const fn of required) {
      expect(typeof resultRef.current[fn]).toBe('function');
    }
  });

  test('exposes all required in-call control callbacks', () => {
    const { resultRef } = renderHook();
    const required = [
      'handleMuteToggle',
      'handleVideoToggle',
      'handleCameraSwitch',
      'handleSwapStreams',
      'handleRetryReconnect',
      'chooseAudioOutput',
      'dismissCallSummary',
    ];
    for (const fn of required) {
      expect(typeof resultRef.current[fn]).toBe('function');
    }
  });

  test('setUserId updates the userId state', () => {
    const { resultRef, tree } = renderHook();
    act(() => {
      resultRef.current.setUserId('alice');
    });
    // Re-render to pick up new state.
    act(() => { tree.update(<TestHook resultRef={resultRef} />); });
    expect(resultRef.current.userId).toBe('alice');
  });

  test('setCalleeId updates the calleeId state', () => {
    const { resultRef, tree } = renderHook();
    act(() => {
      resultRef.current.setCalleeId('bob');
    });
    act(() => { tree.update(<TestHook resultRef={resultRef} />); });
    expect(resultRef.current.calleeId).toBe('bob');
  });

  test('placeCall sets error status when calleeId is empty', async () => {
    const { resultRef, tree } = renderHook();
    await act(async () => {
      await resultRef.current.placeCall();
    });
    act(() => { tree.update(<TestHook resultRef={resultRef} />); });
    expect(resultRef.current.status.severity).toBe('error');
  });

  test('placeCall sets error status when userId is empty', async () => {
    const { resultRef, tree } = renderHook();
    act(() => { resultRef.current.setCalleeId('bob'); });
    await act(async () => {
      await resultRef.current.placeCall();
    });
    act(() => { tree.update(<TestHook resultRef={resultRef} />); });
    expect(resultRef.current.status.severity).toBe('error');
  });

  test('CALL_PHASES exports the expected values', () => {
    expect(CALL_PHASES.IDLE).toBe('idle');
    expect(CALL_PHASES.OUTGOING_RINGING).toBe('outgoing_ringing');
    expect(CALL_PHASES.INCOMING_RINGING).toBe('incoming_ringing');
    expect(CALL_PHASES.IN_CALL).toBe('in_call');
  });

  test('dismissCallSummary clears callSummary', () => {
    const { resultRef, tree } = renderHook();
    // callSummary starts null; dismissing a null summary is safe.
    act(() => { resultRef.current.dismissCallSummary(); });
    act(() => { tree.update(<TestHook resultRef={resultRef} />); });
    expect(resultRef.current.callSummary).toBeNull();
  });
});

// ─── rehydrateCallFromPush ────────────────────────────────────────────────────

describe('rehydrateCallFromPush', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    jest.clearAllMocks();
    // Reset the pushNotifications mock to return null for initial URL by default.
    require('../../src/pushNotifications').getInitialCallLink.mockResolvedValue(null);
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('exposes rehydrateCallFromPush as a function', () => {
    const { resultRef } = renderHook();
    expect(typeof resultRef.current.rehydrateCallFromPush).toBe('function');
  });

  test('defers rehydration and stores pendingPushCallId when userId is not set', async () => {
    const { resultRef } = renderHook();
    // userId is empty – rehydrateCallFromPush should not call fetch yet
    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-123');
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sets status to "Call no longer available" for 404 response', async () => {
    // Mock: POST /session (presence effect), then GET /calls/:id → 404
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-1', userId: 'alice' }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });

    const { resultRef, tree } = renderHook();

    // Await so the presence effect (createOrGetSession → fetch /session) completes.
    await act(async () => { resultRef.current.setUserId('alice'); });
    act(() => { tree.update(<TestHook resultRef={resultRef} />); });

    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-does-not-exist');
    });
    act(() => { tree.update(<TestHook resultRef={resultRef} />); });

    expect(resultRef.current.status.message).toMatch(/no longer available/i);
  });

  test('shows IncomingCallScreen for a still-ringing rehydrated call', async () => {
    const fakeCall = {
      callId: 'call-456',
      callerId: 'user-bob',
      calleeId: 'user-alice',
      status: 'ringing',
    };

    // Mock: POST /session (presence effect), then GET /calls/:id → ringing call
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-2', userId: 'alice' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fakeCall,
      });

    const { resultRef, tree } = renderHook();
    await act(async () => { resultRef.current.setUserId('alice'); });
    act(() => { tree.update(<TestHook resultRef={resultRef} />); });

    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-456');
    });
    act(() => { tree.update(<TestHook resultRef={resultRef} />); });

    expect(resultRef.current.callPhase).toBe(CALL_PHASES.INCOMING_RINGING);
    expect(resultRef.current.incomingCall).toEqual(fakeCall);
  });

  test('sets informational status for a missed call', async () => {
    const fakeCall = {
      callId: 'call-789',
      callerId: 'user-carol',
      calleeId: 'user-alice',
      status: 'missed',
      endReason: 'timeout',
    };

    // Mock: POST /session (presence effect), then GET /calls/:id → missed call
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-3', userId: 'alice' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fakeCall,
      });

    const { resultRef, tree } = renderHook();
    await act(async () => { resultRef.current.setUserId('alice'); });
    act(() => { tree.update(<TestHook resultRef={resultRef} />); });

    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-789');
    });
    act(() => { tree.update(<TestHook resultRef={resultRef} />); });

    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
    expect(resultRef.current.status.message).toMatch(/missed call/i);
  });
});
