import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useGroupCallMedia from '../../src/hooks/useGroupCallMedia';
import { createMockGroup } from '../../src/chat/groupMockAdapter';
import { parseGroupCallSnapshot, startMockGroupCall, transitionMockGroupCall } from '../../src/chat/groupCallAdapter';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../../../shared';

const mockPeerConnections: any[] = [];

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: jest.fn().mockImplementation(() => {
    const pc: any = {
      connectionState: 'new',
      iceConnectionState: 'new',
      signalingState: 'stable',
      localDescription: null,
      remoteDescription: null,
      getSenders: jest.fn(() => []),
      addTrack: jest.fn(),
      addTransceiver: jest.fn(),
      createOffer: jest.fn(async options => ({ type: 'offer', sdp: JSON.stringify(options ?? {}) })),
      setLocalDescription: jest.fn(async description => {
        pc.localDescription = description;
        pc.signalingState = 'have-local-offer';
      }),
      setRemoteDescription: jest.fn(async description => { pc.remoteDescription = description; }),
      addIceCandidate: jest.fn(async () => {}),
      close: jest.fn(() => { pc.connectionState = 'closed'; }),
      getStats: jest.fn(async () => new Map()),
    };
    mockPeerConnections.push(pc);
    return pc;
  }),
  RTCIceCandidate: jest.fn(value => value),
  RTCSessionDescription: jest.fn(value => value),
}));

jest.mock('../../src/webrtcConfig', () => ({
  getIceServersForCall: jest.fn(async () => []),
}));

function stream() {
  const audioTrack = { kind: 'audio', enabled: true };
  return {
    getTracks: () => [audioTrack],
    getVideoTracks: () => [],
  } as any;
}

function TestHook({ params, resultRef }: any) {
  resultRef.current = useGroupCallMedia(params);
  return null;
}

function activeSnapshot() {
  const conversation = createMockGroup('alice', 'Team', ['bob', 'carol'], 'group-media');
  let snapshot = startMockGroupCall(
    conversation, 'alice', 'call-media', 'audio', '2026-10-03T06:00:00Z',
  );
  snapshot = transitionMockGroupCall(snapshot, 'bob', 'accept', '2026-10-03T06:00:01Z');
  conversation.localMock = false;
  return { conversation, snapshot };
}

function signalingClient() {
  const listeners = new Map<string, (payload: any) => void>();
  return {
    listeners,
    emitted: [] as Array<{ event: string; payload: any }>,
    on: jest.fn((event: string, handler: (payload: any) => void) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    }),
    emit(event: string, payload: any) { this.emitted.push({ event, payload }); },
  };
}

describe('useGroupCallMedia', () => {
  beforeEach(() => {
    mockPeerConnections.length = 0;
    jest.useFakeTimers();
  });

  afterEach(() => { jest.useRealTimers(); });

  test('creates accepted peer connections independently and isolates failure, restart, and leave', async () => {
    const { conversation, snapshot } = activeSnapshot();
    const signaling = signalingClient();
    const peerConnectionsRef = { current: new Map() };
    const localStream = stream();
    const resultRef: { current: any } = { current: null };
    const params: any = {
      groupCalls: { [conversation.peerId]: snapshot },
      conversations: [conversation],
      userId: 'alice',
      localStreamRef: { current: localStream },
      peerConnectionsRef,
      startLocalPreview: jest.fn(async () => localStream),
      signalingRef: { current: signaling },
      signalingUrl: 'https://signal.example',
      ensureIceSessionId: jest.fn(async () => 'ice-session'),
      iceTransportPolicy: 'all',
      connected: true,
      canJoin: true,
      isMuted: false,
      isVideoEnabled: false,
      isScreenSharing: false,
      updateStatus: jest.fn(),
    };
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<TestHook params={params} resultRef={resultRef} />);
    });
    await act(async () => {
      resultRef.current.join(conversation.conversationId);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(peerConnectionsRef.current.size).toBe(1);
    expect(mockPeerConnections).toHaveLength(1);
    expect(mockPeerConnections.every(pc => pc.createOffer.mock.calls.length === 1)).toBe(true);
    expect(resultRef.current.peers).toMatchObject({ bob: { connectionState: 'new' } });

    const carolJoined = transitionMockGroupCall(snapshot, 'carol', 'accept', '2026-10-03T06:00:02Z');
    await act(async () => {
      tree.update(<TestHook params={{
        ...params, groupCalls: { [conversation.peerId]: carolJoined },
      }} resultRef={resultRef} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(peerConnectionsRef.current.size).toBe(2);
    expect(resultRef.current.peers).toHaveProperty('carol');
    const bobPc = peerConnectionsRef.current.get('bob').pc;
    const carolPc = peerConnectionsRef.current.get('carol').pc;
    await act(async () => {
      bobPc.connectionState = 'failed';
      bobPc.iceConnectionState = 'failed';
      bobPc.onconnectionstatechange();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resultRef.current.peers.bob).toMatchObject({
      connectionState: 'failed',
      quality: 'offline',
    });
    expect(resultRef.current.peers.carol).toMatchObject({
      connectionState: 'new',
      quality: 'connecting',
    });
    expect(signaling.emitted.some(message =>
      message.event === CLIENT_EVENTS.RTC_OFFER &&
      message.payload.peerId === 'bob' &&
      message.payload.sdp?.sdp?.includes('iceRestart'),
    )).toBe(true);
    expect(signaling.emitted.some(message =>
      message.event === CLIENT_EVENTS.CALL_CONNECTED &&
      message.payload.iceState === 'failed',
    )).toBe(false);
    expect(carolPc.close).not.toHaveBeenCalled();

    const bobLeft = parseGroupCallSnapshot({
      ...carolJoined,
      call: { ...carolJoined.call, stateVersion: carolJoined.call.stateVersion + 1 },
      participants: carolJoined.participants.map(person => person.userId === 'bob'
        ? { ...person, status: 'left', leftAt: '2026-10-03T06:01:00Z' }
        : person),
    });
    const updatedParams = {
      ...params,
      groupCalls: { [conversation.peerId]: bobLeft },
    };
    await act(async () => {
      tree.update(<TestHook params={updatedParams} resultRef={resultRef} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bobPc.close).toHaveBeenCalledTimes(1);
    expect(peerConnectionsRef.current.has('bob')).toBe(false);
    expect(peerConnectionsRef.current.get('carol').pc).toBe(carolPc);
    expect(resultRef.current.peers).not.toHaveProperty('bob');
    expect(resultRef.current.peers.carol.connectionState).toBe('new');
    expect(signaling.listeners.has(SERVER_EVENTS.RTC_OFFER)).toBe(true);

    await act(async () => { tree.unmount(); });
    expect(carolPc.close).toHaveBeenCalledTimes(1);
  });

  test('a higher user ID waits for the lower participant to create the offer', async () => {
    const conversation = createMockGroup('zara', 'Team', ['alice', 'bob'], 'group-offer');
    let snapshot = startMockGroupCall(
      conversation, 'zara', 'call-offer', 'audio', '2026-10-03T06:00:00Z',
    );
    snapshot = transitionMockGroupCall(snapshot, 'alice', 'accept', '2026-10-03T06:00:01Z');
    conversation.localMock = false;
    const signaling = signalingClient();
    const peerConnectionsRef = { current: new Map() };
    const localStream = stream();
    const params: any = {
      groupCalls: { [conversation.peerId]: snapshot },
      conversations: [conversation],
      userId: 'zara',
      localStreamRef: { current: localStream },
      peerConnectionsRef,
      startLocalPreview: jest.fn(async () => localStream),
      signalingRef: { current: signaling },
      signalingUrl: 'https://signal.example',
      ensureIceSessionId: jest.fn(async () => 'ice-session'),
      iceTransportPolicy: 'all',
      connected: true,
      canJoin: true,
      isMuted: false,
      isVideoEnabled: false,
      isScreenSharing: false,
      updateStatus: jest.fn(),
    };
    const resultRef: { current: any } = { current: null };
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<TestHook params={params} resultRef={resultRef} />); });
    await act(async () => {
      resultRef.current.join(conversation.conversationId);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(peerConnectionsRef.current.has('alice')).toBe(true);
    expect(mockPeerConnections).toHaveLength(1);
    expect(mockPeerConnections[0].createOffer).not.toHaveBeenCalled();
    expect(signaling.emitted.some(message =>
      message.event === CLIENT_EVENTS.RTC_OFFER,
    )).toBe(false);
    await act(async () => { tree.unmount(); });
  });
});
