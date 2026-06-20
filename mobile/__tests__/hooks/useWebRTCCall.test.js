import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useWebRTCCall from '../../src/hooks/useWebRTCCall';

jest.mock('socket.io-client', () => ({ io: jest.fn(() => ({ disconnect: jest.fn(), on: jest.fn(), emit: jest.fn() })) }));
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
  AUDIO_ROUTES: {},
  chooseAudioRoute: jest.fn(),
  setAudioRoute: jest.fn(),
  startAudioSession: jest.fn(),
  stopAudioSession: jest.fn(),
  subscribeAudioDevices: jest.fn(() => jest.fn()),
}));
jest.mock('../../src/callService', () => ({
  startCallService: jest.fn(),
  stopCallService: jest.fn(),
}));
jest.mock('../../src/hooks/useCompactCallView', () =>
  jest.fn(() => ({ isCompactView: false, setIsCompactView: jest.fn() })),
);
jest.mock('../../src/cameraLighting', () => ({ applyLightingAdjustment: jest.fn() }));
jest.mock('../../src/callUx', () => ({ getConnectionQuality: jest.fn(() => ({ bars: 3, label: 'Strong' })) }));
jest.mock('../../src/diagnostics', () => ({
  buildExportHeader: jest.fn(),
  getMediaAccessStatus: jest.fn(),
  getSocketTransportName: jest.fn(),
  sanitizeUrlForLog: jest.fn((u) => u),
  summarizeIceCandidate: jest.fn(),
  writeLogsFile: jest.fn(),
}));
jest.mock('../../src/mediaControls', () => ({
  isTrackEnabled: jest.fn(),
  setTrackEnabled: jest.fn(),
}));
jest.mock('../../src/permissions', () => ({ ensureCallPermissions: jest.fn() }));
jest.mock('../../src/settingsStorage', () => ({
  loadSettings: jest.fn(() => Promise.resolve({ autoCameraLightingEnabled: false, speakerEnabledByDefault: true })),
  saveSettings: jest.fn(),
}));
jest.mock('../../src/socketConfig', () => ({
  getSocketOptions: jest.fn(() => ({})),
  isRecoverableDisconnectReason: jest.fn(),
}));
jest.mock('../../src/webrtcConfig', () => ({ getIceServers: jest.fn(() => []) }));

function TestHook({ resultRef }) {
  const result = useWebRTCCall();
  resultRef.current = result;
  return null;
}

describe('useWebRTCCall', () => {
  test('initializes connectionQuality with default No-link value', () => {
    const resultRef = { current: null };

    act(() => {
      renderer.create(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.connectionQuality).toEqual({ bars: 0, label: 'No link' });
  });
});
