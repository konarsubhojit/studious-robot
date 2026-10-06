import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useGroupCallMedia from '../../src/hooks/useGroupCallMedia';
import { createMockGroup } from '../../src/chat/groupMockAdapter';
import { parseGroupCallSnapshot, startMockGroupCall, transitionMockGroupCall } from '../../src/chat/groupCallAdapter';
import { CLIENT_EVENTS, SERVER_EVENTS, SIGNALING_VERSION, groupNegotiationId } from '../../../shared';

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
      createAnswer: jest.fn(async () => ({ type: 'answer', sdp: 'answer' })),
      setLocalDescription: jest.fn(async description => {
        pc.localDescription = description;
        pc.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
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

    const rejoined = transitionMockGroupCall(bobLeft, 'bob', 'accept', '2026-10-03T06:02:00Z');
    await act(async () => {
      tree.update(<TestHook params={{
        ...params, groupCalls: { [conversation.peerId]: rejoined },
      }} resultRef={resultRef} />);
    });
    const newBobPc = peerConnectionsRef.current.get('bob').pc;
    expect(newBobPc).not.toBe(bobPc);
    expect(peerConnectionsRef.current.get('carol').pc).toBe(carolPc);
    const answer = signaling.listeners.get(SERVER_EVENTS.RTC_ANSWER)!;
    const ice = signaling.listeners.get(SERVER_EVENTS.RTC_ICE)!;
    await act(async () => {
      await answer({
        callId: snapshot.callId, peerId: 'bob',
        negotiationId: groupNegotiationId(carolJoined.participants, 'alice', 'bob'),
        sdp: { type: 'answer', sdp: 'stale' },
      });
      await ice({
        callId: snapshot.callId, peerId: 'bob',
        negotiationId: groupNegotiationId(carolJoined.participants, 'alice', 'bob'), candidate: {},
      });
    });
    expect(newBobPc.setRemoteDescription).not.toHaveBeenCalled();
    expect(newBobPc.addIceCandidate).not.toHaveBeenCalled();
    await act(async () => {
      await answer({
        callId: snapshot.callId, peerId: 'bob',
        negotiationId: groupNegotiationId(rejoined.participants, 'alice', 'bob'),
        sdp: { type: 'answer', sdp: 'fresh' },
      });
    });
    expect(newBobPc.setRemoteDescription).toHaveBeenCalledTimes(1);
    // A receiver may miss the intermediate leave snapshot during reconnect.
    const missedLeave = transitionMockGroupCall(rejoined, 'bob', 'leave', '2026-10-03T06:03:00Z');
    const missedRejoin = transitionMockGroupCall(missedLeave, 'bob', 'accept', '2026-10-03T06:04:00Z');
    await act(async () => {
      tree.update(<TestHook params={{
        ...params, groupCalls: { [conversation.peerId]: missedRejoin },
      }} resultRef={resultRef} />);
    });
    expect(newBobPc.close).toHaveBeenCalledTimes(1);
    expect(peerConnectionsRef.current.get('bob').pc).not.toBe(newBobPc);
    expect(peerConnectionsRef.current.get('carol').pc).toBe(carolPc);

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
    const payload = {
      callId: snapshot.callId, peerId: 'alice',
      negotiationId: groupNegotiationId(snapshot.participants, 'alice', 'zara'),
    };
    await act(async () => {
      await signaling.listeners.get(SERVER_EVENTS.RTC_ICE)!({ ...payload, candidate: { candidate: 'early' } });
      await signaling.listeners.get(SERVER_EVENTS.RTC_OFFER)!({
        ...payload, sdp: { type: 'offer', sdp: 'remote-av' },
      });
    });
    expect(mockPeerConnections[0].addIceCandidate).toHaveBeenCalledWith({ candidate: 'early' });
    expect(signaling.emitted).toContainEqual({
      event: CLIENT_EVENTS.RTC_ANSWER,
      payload: { version: SIGNALING_VERSION, ...payload, sdp: { type: 'answer', sdp: 'answer' } },
    });
    await act(async () => {
      await Promise.all([1, 2].map(() => signaling.listeners.get(SERVER_EVENTS.RTC_OFFER)!({
        ...payload, sdp: { type: 'offer', sdp: 'remote-av' },
      })));
    });
    expect(mockPeerConnections[0].createAnswer).toHaveBeenCalledTimes(1);
    await act(async () => { tree.unmount(); });
  });

  test.each(['leave', 'unmount', 'disconnect', 'participant-leave'])(
    'cancels pending capture on %s without creating a stale peer', async action => {
      const { conversation, snapshot } = activeSnapshot();
      let finish!: (value: any) => void;
      const capture = new Promise(resolve => { finish = resolve; });
      const resultRef: { current: any } = { current: null };
      const params: any = {
        groupCalls: { [conversation.peerId]: snapshot }, conversations: [conversation], userId: 'alice',
        localStreamRef: { current: null }, peerConnectionsRef: { current: new Map() },
        startLocalPreview: jest.fn(() => capture), signalingRef: { current: signalingClient() },
        signalingUrl: 'https://signal.example', ensureIceSessionId: jest.fn(async () => null),
        iceTransportPolicy: 'all', connected: true, canJoin: true,
        isMuted: false, isVideoEnabled: true, isScreenSharing: false, updateStatus: jest.fn(),
      };
      let tree!: renderer.ReactTestRenderer;
      act(() => { tree = renderer.create(<TestHook params={params} resultRef={resultRef} />); });
      await act(async () => { resultRef.current.join(conversation.conversationId); });
      expect(params.startLocalPreview).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (action === 'leave') resultRef.current.leave();
        else if (action === 'unmount') tree.unmount();
        else tree.update(<TestHook params={{
          ...params,
          ...(action === 'disconnect' ? { connected: false } : {
            groupCalls: { [conversation.peerId]: transitionMockGroupCall(snapshot, 'bob', 'leave', '2026-10-03T06:02:00Z') },
          }),
        }} resultRef={resultRef} />);
      });
      await act(async () => { finish(stream()); });
      expect(mockPeerConnections).toHaveLength(0);
      expect(params.peerConnectionsRef.current.size).toBe(0);
      if (action !== 'unmount') await act(async () => { tree.unmount(); });
    },
  );

  test('queues ICE while capture is pending and starts media only once for the mesh', async () => {
    const { conversation, snapshot } = activeSnapshot();
    const joined = transitionMockGroupCall(snapshot, 'carol', 'accept', '2026-10-03T06:00:02Z');
    let finish!: (value: any) => void;
    const capture = new Promise(resolve => { finish = resolve; });
    const signaling = signalingClient();
    const resultRef: { current: any } = { current: null };
    const localStream = {
      getTracks: () => [{ kind: 'audio' }, { kind: 'video' }],
      getVideoTracks: () => [{ kind: 'video' }],
    };
    const params: any = {
      groupCalls: { [conversation.peerId]: joined }, conversations: [conversation], userId: 'alice',
      localStreamRef: { current: null }, peerConnectionsRef: { current: new Map() },
      startLocalPreview: jest.fn(() => capture), signalingRef: { current: signaling },
      signalingUrl: 'https://signal.example', ensureIceSessionId: jest.fn(async () => null),
      iceTransportPolicy: 'all', connected: true, canJoin: true,
      isMuted: false, isVideoEnabled: true, isScreenSharing: false, updateStatus: jest.fn(),
    };
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<TestHook params={params} resultRef={resultRef} />); });
    await act(async () => { resultRef.current.join(conversation.conversationId); });
    const negotiationId = groupNegotiationId(joined.participants, 'alice', 'bob');
    let pendingIce!: Promise<void>;
    await act(async () => {
      pendingIce = signaling.listeners.get(SERVER_EVENTS.RTC_ICE)!({
        callId: joined.callId, peerId: 'bob', negotiationId, candidate: { candidate: 'during-capture' },
      }) as any;
      params.localStreamRef.current = localStream;
      finish(localStream);
      await pendingIce;
    });
    expect(params.startLocalPreview).toHaveBeenCalledTimes(1);
    expect(params.peerConnectionsRef.current.size).toBe(2);
    expect(mockPeerConnections.every(pc => pc.addTrack.mock.calls.length === 2)).toBe(true);
    const bob = params.peerConnectionsRef.current.get('bob');
    await act(async () => {
      await signaling.listeners.get(SERVER_EVENTS.RTC_ANSWER)!({
        callId: joined.callId, peerId: 'bob', negotiationId, sdp: { type: 'answer', sdp: 'av' },
      });
      bob.pc.ontrack({ streams: [localStream] });
    });
    expect(bob.pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'during-capture' });
    expect(resultRef.current.peers.bob.stream).toBe(localStream);
    await act(async () => { tree.unmount(); });
  });
});
