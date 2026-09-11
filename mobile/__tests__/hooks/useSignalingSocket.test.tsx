import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useSignalingSocket from '../../src/hooks/useSignalingSocket';

jest.mock('react-native-webrtc', () => ({
  RTCIceCandidate: jest.fn((candidate: any) => candidate),
  RTCSessionDescription: jest.fn((description: any) => description),
}));

jest.mock('socket.io-client', () => ({
  io: jest.fn(),
}));

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logVerbose: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('../../src/callKeep', () => ({
  clearPendingAnswer: jest.fn(),
  endCall: jest.fn(),
}));

jest.mock('../../src/callService', () => ({
  startCallService: jest.fn(),
}));

jest.mock('../../src/observability', () => ({
  emitMetric: jest.fn(),
  getCorrelationId: jest.fn(() => 'corr-1'),
}));

jest.mock('../../src/signalingClient', () => ({
  CLIENT_EVENTS: {
    CALL_CONNECTED: 'call.connected',
    CALL_INCOMING_ACK: 'call.incoming.ack',
    RTC_ANSWER: 'rtc.answer',
  },
  SERVER_EVENTS: {
    CALL_INCOMING: 'call.incoming',
    CALL_MEDIA_STATE: 'call.media-state',
    CALL_RINGING: 'call.ringing',
    CALL_STATE_CHANGED: 'call.state_changed',
    MESSAGE_DELETED: 'message.deleted',
    MESSAGE_DELIVERED: 'message.delivered',
    MESSAGE_REACTION: 'message.reaction',
    MESSAGE_READ: 'message.read',
    MESSAGE_RECEIVED: 'message.received',
    MESSAGE_TYPING: 'message.typing',
    RTC_ANSWER: 'rtc.answer',
    RTC_CANDIDATE: 'rtc.candidate',
    RTC_OFFER: 'rtc.offer',
    SESSION_INVALID: 'session.invalid',
  },
  TRANSPORT_EVENTS: {
    CONNECT: 'connect',
    CONNECT_ERROR: 'connect_error',
    DISCONNECT: 'disconnect',
    RECONNECT_FAILED: 'reconnect_failed',
  },
  createSignalingClient: jest.fn(),
}));

jest.mock('../../src/socketConfig', () => ({
  getSocketOptions: jest.fn(() => ({ transports: ['websocket'] })),
}));

jest.mock('../../src/telemetry', () => ({
  trackReconnect: jest.fn(),
}));

jest.mock('../../src/webrtcConfig', () => ({
  prefetchIceServersForCall: jest.fn(),
}));

const { io } = require('socket.io-client');
const { createSignalingClient } = require('../../src/signalingClient');
const { prefetchIceServersForCall } = require('../../src/webrtcConfig');

function TestHook({ params, resultRef }: any) {
  resultRef.current = useSignalingSocket(params);
  return null;
}

function makeSocket() {
  return {
    connect: jest.fn(),
    disconnect: jest.fn(),
    id: 'socket-1',
    io: {
      off: jest.fn(),
      on: jest.fn(),
    },
  };
}

function makeSignaling() {
  const handlers = new Map<string, any>();
  return {
    dispose: jest.fn(),
    dropQueuedEvents: jest.fn(() => 0),
    emit: jest.fn((_event: string, _payload: any, ack?: any) => ack?.({ ok: true })),
    flushQueue: jest.fn(),
    handlers,
    on: jest.fn((event: string, handler: any) => {
      handlers.set(event, handler);
    }),
  };
}

function setup(overrides: any = {}) {
  const detachManagerPing = jest.fn();
  const socket = makeSocket();
  const signaling = makeSignaling();
  (io as jest.Mock).mockReturnValue(socket);
  (createSignalingClient as jest.Mock).mockReturnValue(signaling);
  const params = {
    activeCallIdRef: { current: 'call-1' },
    activeCallRef: { current: null },
    beginIceRecoveryRef: { current: jest.fn() },
    consumeForeignDeviceCallEvent: jest.fn(() => false),
    createOrGetSession: jest.fn(() => Promise.resolve('session-2')),
    detachManagerPingRef: { current: detachManagerPing },
    deviceIdRef: { current: 'device-1' },
    dispatchCallEvent: jest.fn(),
    displayedIncomingCallIdsRef: { current: new Set<string>() },
    endActiveCallRef: { current: jest.fn() },
    ensurePeerConnectionRef: { current: jest.fn() },
    fetchBlocks: jest.fn(),
    fetchConversations: jest.fn(),
    handleMessageDeleted: jest.fn(),
    handleMessageDelivered: jest.fn(),
    handleMessageReaction: jest.fn(),
    handleMessageRead: jest.fn(),
    handleMessageReceived: jest.fn(),
    handleSocketConnected: jest.fn(),
    handleSocketDisconnected: jest.fn(),
    handleTypingEvent: jest.fn(),
    iceCandidateBufferRef: { current: [] },
    incomingCallRef: { current: null },
    isCallerRef: { current: true },
    isInCallRef: { current: false },
    isNegotiatingRef: { current: false },
    noteRecoverySymptomRef: { current: jest.fn() },
    pauseRecoveryBudgetRef: { current: jest.fn() },
    peerConnectionRef: { current: null },
    recordConnectError: jest.fn(),
    recordConnectSuccess: jest.fn(),
    recordTimelineCallRef: { current: jest.fn() },
    reportOwnCallState: jest.fn(),
    resetTypingStateRef: { current: jest.fn() },
    resyncCallStateRef: { current: jest.fn() },
    resumeRecoveryBudgetRef: { current: jest.fn() },
    sendInitialOffer: jest.fn(),
    sessionIdRef: { current: 'session-1' },
    setActiveCall: jest.fn(),
    setCallDelivery: jest.fn(),
    setIncomingCall: jest.fn(),
    setIsReconnecting: jest.fn(),
    setIsRemoteScreenSharing: jest.fn(),
    setIsRemoteVideoEnabled: jest.fn(),
    showIncomingCallUi: jest.fn(() => Promise.resolve()),
    signalingRef: { current: signaling },
    signalingUrl: 'https://signal.example.test',
    socketRef: { current: socket },
    updateStatus: jest.fn(),
    wakeCallHeartbeat: jest.fn(),
    ...overrides,
  };
  const resultRef: { current: any } = { current: null };
  act(() => {
    renderer.create(<TestHook params={params} resultRef={resultRef} />);
  });
  return { detachManagerPing, params, resultRef, signaling, socket };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useSignalingSocket', () => {
  test('disconnects the socket, disposes signaling listeners and resets typing state', () => {
    const { detachManagerPing, params, resultRef, signaling, socket } = setup();

    act(() => {
      resultRef.current.disconnectSocket();
    });

    expect(detachManagerPing).toHaveBeenCalledTimes(1);
    expect(signaling.dispose).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
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

  test('connects a socket, prefetches ICE servers and attaches manager cleanup', () => {
    const { params, resultRef, socket } = setup({ socketRef: { current: null } });

    act(() => {
      resultRef.current.connectSocket('session-1');
    });

    expect(prefetchIceServersForCall).toHaveBeenCalledWith({
      signalingUrl: 'https://signal.example.test',
      sessionId: 'session-1',
    });
    expect(io).toHaveBeenCalledWith('https://signal.example.test', {
      transports: ['websocket'],
      auth: { sessionId: 'session-1', correlationId: 'corr-1' },
    });
    expect(params.socketRef.current).toBe(socket);
    expect(socket.io.on).toHaveBeenCalledWith('ping', expect.any(Function));
    expect(socket.io.on).toHaveBeenCalledWith('reconnect_failed', expect.any(Function));

    params.detachManagerPingRef.current?.();

    expect(socket.io.off).toHaveBeenCalledWith('ping', expect.any(Function));
    expect(socket.io.off).toHaveBeenCalledWith('reconnect_failed', expect.any(Function));
  });

  test('acknowledges incoming calls and publishes local incoming-call state', () => {
    const { params, resultRef, signaling } = setup({ socketRef: { current: null } });
    act(() => {
      resultRef.current.connectSocket('session-1');
      signaling.handlers.get('call.incoming')({
        call: { callId: 'call-2', callerId: 'bob' },
      });
    });

    expect(signaling.emit).toHaveBeenCalledWith(
      'call.incoming.ack',
      { version: 1, callId: 'call-2', deviceId: 'device-1' },
      expect.any(Function),
    );
    expect(params.incomingCallRef.current).toEqual({ callId: 'call-2', callerId: 'bob' });
    expect(params.setIncomingCall).toHaveBeenCalledWith({ callId: 'call-2', callerId: 'bob' });
    expect(params.recordTimelineCallRef.current).toHaveBeenCalledWith({
      callId: 'call-2',
      callerId: 'bob',
    });
    expect(params.showIncomingCallUi).toHaveBeenCalledWith({ callId: 'call-2', callerId: 'bob' });
  });

  test('buffers RTC candidates until the peer has a remote description', async () => {
    const peerConnection = { addIceCandidate: jest.fn(), remoteDescription: null };
    const { params, resultRef, signaling } = setup({
      peerConnectionRef: { current: peerConnection },
      socketRef: { current: null },
    });

    await act(async () => {
      resultRef.current.connectSocket('session-1');
      await signaling.handlers.get('rtc.candidate')({
        callId: 'call-1',
        candidate: { candidate: 'candidate-1' },
      });
    });

    expect(params.iceCandidateBufferRef.current).toEqual([{ candidate: 'candidate-1' }]);
    expect(peerConnection.addIceCandidate).not.toHaveBeenCalled();
  });
});
