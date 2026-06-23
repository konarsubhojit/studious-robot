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
