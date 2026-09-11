import React from 'react';
import renderer, { act } from 'react-test-renderer';
import usePeerConnection from '../../src/hooks/usePeerConnection';

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: jest.fn(),
}));

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logVerbose: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('../../src/diagnostics', () => ({
  summarizeIceCandidate: jest.fn(() => ({ candidateType: 'host', protocol: 'udp' })),
}));

jest.mock('../../src/observability', () => ({
  emitMetric: jest.fn(),
}));

jest.mock('../../src/telemetry', () => ({
  trackFirstRemoteFrame: jest.fn(),
}));

jest.mock('../../src/webrtcConfig', () => ({
  ICE_TRANSPORT_POLICIES: {
    RELAY: 'relay',
  },
  getIceServersForCall: jest.fn(() => Promise.resolve([{ urls: ['turn:turn.example.com:3478'] }])),
  getTurnServerEndpoints: jest.fn(() => ['turn:turn.example.com']),
}));

const { RTCPeerConnection } = require('react-native-webrtc');
const { logInfo, logVerbose } = require('../../src/appLogger');
const { getIceServersForCall } = require('../../src/webrtcConfig');
const Telemetry = require('../../src/telemetry');

function TestHook({ params, resultRef }: any) {
  resultRef.current = usePeerConnection(params);
  return null;
}

function makePeerConnection(overrides: any = {}) {
  return {
    addTrack: jest.fn(),
    close: jest.fn(),
    createOffer: jest.fn(() => Promise.resolve({ type: 'offer', sdp: 'offer-sdp' })),
    getSenders: jest.fn(() => []),
    localDescription: { type: 'offer', sdp: 'local-offer-sdp' },
    onconnectionstatechange: null,
    onicecandidate: null,
    oniceconnectionstatechange: null,
    ontrack: null,
    setLocalDescription: jest.fn(() => Promise.resolve(undefined)),
    ...overrides,
  };
}

function setup(overrides: any = {}) {
  const signaling = {
    emit: jest.fn((_event: string, _payload: any, ack?: any) => ack?.({ ok: true })),
  };
  const recoveryCallbacks = {
    markCallConnected: { current: jest.fn() },
    reportCallConnected: { current: jest.fn() },
    noteRecoverySymptom: { current: jest.fn() },
    beginIceRecovery: { current: jest.fn() },
    cancelIceRestarts: { current: jest.fn() },
  };
  const params: any = {
    activeCallIdRef: { current: 'call-1' },
    activeIceTransportPolicy: 'all',
    ensureIceSessionId: jest.fn(() => Promise.resolve('session-1')),
    isCallerRef: { current: true },
    localStreamRef: { current: null },
    recoveryCallbacks,
    setRemoteStream: jest.fn(),
    signalingRef: { current: signaling },
    signalingUrl: 'https://signal.example.test',
    socketRef: { current: { connected: true } },
    updateStatus: jest.fn(),
    ...overrides,
  };
  const resultRef: { current: any } = { current: null };
  let instance: renderer.ReactTestRenderer;
  act(() => {
    instance = renderer.create(<TestHook params={params} resultRef={resultRef} />);
  });
  return { instance: instance!, params, recoveryCallbacks, resultRef, signaling };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('usePeerConnection', () => {
  test('creates a peer connection with prefetched ICE servers and attaches local tracks once', async () => {
    const track = { id: 'mic-1' };
    const stream = { getTracks: () => [track] };
    const peerConnection = makePeerConnection();
    (RTCPeerConnection as jest.Mock).mockImplementation(() => peerConnection);
    const { params, resultRef } = setup({ localStreamRef: { current: stream } });

    await act(async () => {
      await resultRef.current.ensurePeerConnection();
    });

    expect(params.ensureIceSessionId).toHaveBeenCalledTimes(1);
    expect(getIceServersForCall).toHaveBeenCalledWith({
      signalingUrl: 'https://signal.example.test',
      sessionId: 'session-1',
    });
    expect(RTCPeerConnection).toHaveBeenCalledWith({
      iceServers: [{ urls: ['turn:turn.example.com:3478'] }],
      iceTransportPolicy: 'all',
    });
    expect(peerConnection.addTrack).toHaveBeenCalledWith(track, stream);
  });

  test('emits gathered ICE candidates through signaling with verbose diagnostics', async () => {
    const peerConnection = makePeerConnection();
    (RTCPeerConnection as jest.Mock).mockImplementation(() => peerConnection);
    const { resultRef, signaling } = setup();

    await act(async () => {
      await resultRef.current.ensurePeerConnection();
    });
    peerConnection.onicecandidate?.({ candidate: { candidate: 'candidate-detail' } });

    expect(logVerbose).toHaveBeenCalledWith('[CallFlow] ICE candidate sent', {
      candidateType: 'host',
      protocol: 'udp',
    });
    expect(signaling.emit).toHaveBeenCalledWith('rtc.candidate', {
      version: 1,
      callId: 'call-1',
      candidate: { candidate: 'candidate-detail' },
    });
  });

  test('renegotiates by sending a fresh local offer', async () => {
    const peerConnection = makePeerConnection();
    (RTCPeerConnection as jest.Mock).mockImplementation(() => peerConnection);
    const { resultRef, signaling } = setup();

    await act(async () => {
      await resultRef.current.ensurePeerConnection();
      await resultRef.current.renegotiate();
    });

    expect(peerConnection.createOffer).toHaveBeenCalledTimes(1);
    expect(peerConnection.setLocalDescription).toHaveBeenCalledWith({
      type: 'offer',
      sdp: 'offer-sdp',
    });
    expect(signaling.emit).toHaveBeenCalledWith(
      'rtc.offer',
      {
        version: 1,
        callId: 'call-1',
        sdp: { type: 'offer', sdp: 'local-offer-sdp' },
      },
      expect.any(Function),
    );
    expect(logInfo).toHaveBeenCalledWith('[CallFlow] Renegotiation offer sent');
  });

  test('merges additional screen-audio-only remote streams into the active remote stream', async () => {
    const primaryAudio = { id: 'remote-audio', kind: 'audio' };
    const primaryVideo = { id: 'remote-video', kind: 'video' };
    const screenAudio = { id: 'screen-audio', kind: 'audio' };
    const primaryStream: any = {
      id: 'primary',
      addTrack: jest.fn(),
      getAudioTracks: () => [primaryAudio],
      getTracks: () => [primaryAudio, primaryVideo],
      getVideoTracks: () => [primaryVideo],
    };
    const screenAudioStream: any = {
      id: 'screen-audio-stream',
      getAudioTracks: () => [screenAudio],
      getTracks: () => [screenAudio],
      getVideoTracks: () => [],
    };
    const peerConnection = makePeerConnection();
    (RTCPeerConnection as jest.Mock).mockImplementation(() => peerConnection);
    const { params, recoveryCallbacks, resultRef } = setup();

    await act(async () => {
      await resultRef.current.ensurePeerConnection();
      peerConnection.ontrack?.({ streams: [primaryStream] });
      peerConnection.ontrack?.({ streams: [screenAudioStream] });
      peerConnection.ontrack?.({ streams: [screenAudioStream] });
    });

    expect(primaryStream.addTrack).toHaveBeenCalledWith(screenAudio);
    expect(primaryStream.addTrack).toHaveBeenCalledTimes(1);
    expect(params.setRemoteStream).toHaveBeenLastCalledWith(primaryStream);
    expect(recoveryCallbacks.markCallConnected.current).toHaveBeenCalled();
    expect(Telemetry.trackFirstRemoteFrame).toHaveBeenCalledWith('call-1');
  });

  test('closes current and pending peer connections and clears remote stream state', async () => {
    let resolvePending!: (pc: any) => void;
    const pending = new Promise(resolve => {
      resolvePending = resolve;
    });
    const currentPeerConnection = makePeerConnection();
    const pendingPeerConnection = makePeerConnection();
    (RTCPeerConnection as jest.Mock).mockImplementation(() => currentPeerConnection);
    const { params, resultRef } = setup();

    await act(async () => {
      await resultRef.current.ensurePeerConnection();
      resultRef.current.iceCandidateBufferRef.current = [{ candidate: 'buffered' }];
      resultRef.current.peerConnectionRef.current = currentPeerConnection;
      resultRef.current.pendingPeerConnectionRef.current = pending;
      resultRef.current.closePeerConnection();
      resolvePending(pendingPeerConnection);
      await pending;
    });

    expect(currentPeerConnection.close).toHaveBeenCalledTimes(1);
    expect(pendingPeerConnection.close).toHaveBeenCalledTimes(1);
    expect(resultRef.current.iceCandidateBufferRef.current).toEqual([]);
    expect(resultRef.current.peerConnectionRef.current).toBeNull();
    expect(params.setRemoteStream).toHaveBeenLastCalledWith(null);
  });
});
