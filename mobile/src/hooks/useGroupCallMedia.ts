import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { RTCPeerConnection, RTCIceCandidate, RTCSessionDescription } from 'react-native-webrtc';
import { SERVER_EVENTS, CLIENT_EVENTS, SIGNALING_VERSION } from '../../../shared';
import { logInfo, logWarn } from '../appLogger';
import { callPeerMapReducer, INITIAL_CALL_PEERS } from '../call/callStateMachine';
import type { CallPeerMap } from '../call/callStateMachine';
import type { GroupCallSnapshot } from '../chat/groupCallAdapter';
import { getIceServersForCall } from '../webrtcConfig';
import type { IceTransportPolicy } from '../webrtcConfig';
import type { SignalingClient } from '../signalingClient';
import type { PeerConnection, WebrtcMediaStream } from './usePeerConnection';

type MutableRef<T> = { current: T };

type GroupPeerConnection = {
  userId: string;
  callId: string;
  pc: PeerConnection;
  candidates: unknown[];
  isNegotiating: boolean;
  restartPending: boolean;
  restartAttempts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
};

type Params = {
  groupCalls: Record<string, GroupCallSnapshot>;
  conversations: Array<{ peerId: string; localMock?: boolean }>;
  userId: string;
  localStreamRef: MutableRef<WebrtcMediaStream | null>;
  peerConnectionsRef: MutableRef<Map<string, GroupPeerConnection>>;
  startLocalPreview: (mediaType: 'audio' | 'video') => Promise<WebrtcMediaStream | null>;
  signalingRef: MutableRef<SignalingClient | null>;
  signalingUrl: string;
  ensureIceSessionId: () => Promise<string | null>;
  iceTransportPolicy: IceTransportPolicy;
  connected: boolean;
  canJoin: boolean;
  isMuted: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  updateStatus: (message: string, severity?: 'info' | 'success' | 'warning' | 'error') => void;
};

type GroupCallMediaResult = {
  activeConversationId: string | null;
  activeCallId: string | null;
  peers: CallPeerMap<WebrtcMediaStream>;
  activeSpeakerId: string | null;
  peerConnectionsRef: MutableRef<Map<string, GroupPeerConnection>>;
  join: (conversationId: string) => void;
  leave: (conversationId?: string) => void;
};

const GROUP_MESH_REMOTE_LIMIT = 3;

function compareUserIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function acceptedPeerIds(snapshot: GroupCallSnapshot, localUserId: string): string[] {
  return snapshot.participants
    .filter(person => person.userId !== localUserId && person.status === 'accepted')
    .map(person => person.userId)
    .sort(compareUserIds);
}

function remoteAudioLevel(report: any): number {
  if (!report || report.type !== 'inbound-rtp' || (report.kind !== 'audio' && report.mediaType !== 'audio')) {
    return 0;
  }
  return typeof report.audioLevel === 'number' ? report.audioLevel : 0;
}

function strongestSpeaker(levels: Record<string, number>): string | null {
  let strongest: string | null = null;
  let level = 0.08;
  for (const [userId, candidate] of Object.entries(levels)) {
    if (candidate > level) {
      strongest = userId;
      level = candidate;
    }
  }
  return strongest;
}

/**
 * Owns one RTCPeerConnection per accepted remote group participant. Failure,
 * ICE restart, candidates and teardown are all scoped to that participant.
 */
export default function useGroupCallMedia({
  groupCalls,
  conversations,
  userId,
  localStreamRef,
  peerConnectionsRef,
  startLocalPreview,
  signalingRef,
  signalingUrl,
  ensureIceSessionId,
  iceTransportPolicy,
  connected,
  canJoin,
  isMuted,
  isVideoEnabled,
  isScreenSharing,
  updateStatus,
}: Params): GroupCallMediaResult {
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [peers, dispatchPeer] = useReducer(
    callPeerMapReducer<WebrtcMediaStream>,
    INITIAL_CALL_PEERS as CallPeerMap<WebrtcMediaStream>,
  );
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  const activePeerConnectionsRef = peerConnectionsRef;
  const creatingPeerRef = useRef(new Map<string, Promise<GroupPeerConnection | null>>());
  const selectedConversationRef = useRef<string | null>(null);
  const snapshotRef = useRef<GroupCallSnapshot | null>(null);
  const localUserIdRef = useRef(userId);
  const startLocalPreviewRef = useRef(startLocalPreview);
  const ensureIceSessionIdRef = useRef(ensureIceSessionId);
  const updateStatusRef = useRef(updateStatus);
  const localMediaStartRef = useRef<Promise<WebrtcMediaStream | null> | null>(null);
  const requestedRestartRef = useRef(new Set<string>());
  const requestIceRestartRef = useRef<(entry: GroupPeerConnection) => Promise<void>>(async () => {});

  selectedConversationRef.current = activeConversationId;
  localUserIdRef.current = userId;
  startLocalPreviewRef.current = startLocalPreview;
  ensureIceSessionIdRef.current = ensureIceSessionId;
  updateStatusRef.current = updateStatus;

  const snapshot = activeConversationId
    ? Object.values(groupCalls).find(call => call.conversationId === activeConversationId) ?? null
    : null;
  snapshotRef.current = snapshot;
  const activeCallId = snapshot?.call.status === 'ended' ? null : snapshot?.callId ?? null;
  const isLocalMock = Boolean(conversations.find(row =>
    row.peerId === activeConversationId && row.localMock,
  ));

  const closePeer = useCallback((peerId: string) => {
    const entry = activePeerConnectionsRef.current.get(peerId);
    if (!entry) return;
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.oniceconnectionstatechange = null;
    entry.pc.close();
    activePeerConnectionsRef.current.delete(peerId);
    creatingPeerRef.current.delete(peerId);
    requestedRestartRef.current.delete(peerId);
    dispatchPeer({ type: 'leave', userId: peerId });
  }, [activePeerConnectionsRef]);

  const closeAllPeers = useCallback(() => {
    [...activePeerConnectionsRef.current.keys()].forEach(closePeer);
    creatingPeerRef.current.clear();
    requestedRestartRef.current.clear();
    dispatchPeer({ type: 'reset' });
    setActiveSpeakerId(null);
  }, [activePeerConnectionsRef, closePeer]);

  const emitPeerSignal = useCallback((
    event: string,
    entry: GroupPeerConnection,
    payload: object,
  ) => {
    if (!signalingRef.current || !entry.callId || !activePeerConnectionsRef.current.has(entry.userId)) return;
    signalingRef.current.emit(event, {
      version: SIGNALING_VERSION,
      callId: entry.callId,
      peerId: entry.userId,
      ...payload,
    });
  }, [activePeerConnectionsRef, signalingRef]);

  const createPeer = useCallback(async (
    remoteUserId: string,
    callId: string,
  ): Promise<GroupPeerConnection | null> => {
    const existing = activePeerConnectionsRef.current.get(remoteUserId);
    if (existing?.callId === callId) return existing;
    const pending = creatingPeerRef.current.get(remoteUserId);
    if (pending) return pending;
    const creation = (async () => {
      const current = snapshotRef.current;
      if (
        !current || current.callId !== callId ||
        !current.participants.some(person => person.userId === remoteUserId && person.status === 'accepted') ||
        !current.participants.some(person => person.userId === localUserIdRef.current && person.status === 'accepted')
      ) return null;

      let localStream = localStreamRef.current;
      if (!localStream) {
        if (!localMediaStartRef.current) {
          const mediaType = current.call.mediaType === 'audio' ? 'audio' : 'video';
          localMediaStartRef.current = startLocalPreviewRef.current(mediaType)
            .finally(() => { localMediaStartRef.current = null; });
        }
        localStream = await localMediaStartRef.current;
      }
      if (!localStream || snapshotRef.current?.callId !== callId) return null;

      const iceServers = await getIceServersForCall({
        signalingUrl,
        sessionId: await ensureIceSessionIdRef.current(),
      });
      if (snapshotRef.current?.callId !== callId || !connected) return null;
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy,
      }) as PeerConnection;
      const attachedTracks = new Set((pc.getSenders?.() ?? []).map(sender => sender.track).filter(Boolean));
      for (const track of localStream.getTracks()) {
        if (!attachedTracks.has(track)) pc.addTrack(track, localStream);
      }
      if (!localStream.getVideoTracks().length) {
        // Reserve a sender so screen-share video can replace it without
        // disabling the existing microphone track or adding an audio sender.
        pc.addTransceiver('video', { direction: 'sendrecv', streams: [localStream] });
      }

      const entry: GroupPeerConnection = {
        userId: remoteUserId,
        callId,
        pc,
        candidates: [],
        isNegotiating: false,
        restartPending: false,
        restartAttempts: 0,
        restartTimer: null,
      };
      activePeerConnectionsRef.current.set(remoteUserId, entry);
      dispatchPeer({ type: 'join', userId: remoteUserId });
      pc.onicecandidate = (event: { candidate: unknown | null }) => {
        const { candidate } = event;
        if (candidate) emitPeerSignal(CLIENT_EVENTS.RTC_ICE, entry, { candidate });
      };
      pc.ontrack = (event: { streams: readonly WebrtcMediaStream[] }) => {
        const { streams } = event;
        const [stream] = streams;
        if (stream && activePeerConnectionsRef.current.get(remoteUserId) === entry) {
          dispatchPeer({ type: 'stream', userId: remoteUserId, stream });
        }
      };
      const updateConnection = () => {
        const state = pc.connectionState || pc.iceConnectionState || 'connecting';
        if (['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'].includes(state)) {
          dispatchPeer({ type: 'connection', userId: remoteUserId, connectionState: state as any });
        }
        if (state === 'failed' || pc.iceConnectionState === 'failed') {
          dispatchPeer({ type: 'quality', userId: remoteUserId, quality: 'offline' });
          void requestIceRestartRef.current(entry);
        } else if (state === 'connected' || pc.iceConnectionState === 'connected') {
          entry.restartAttempts = 0;
          entry.restartPending = false;
          if (entry.restartTimer) clearTimeout(entry.restartTimer);
          entry.restartTimer = null;
        }
      };
      pc.onconnectionstatechange = updateConnection;
      pc.oniceconnectionstatechange = updateConnection;

      // A single deterministic offerer per pair prevents simultaneous offers
      // when a participant joins an already-active mesh.
      if (compareUserIds(localUserIdRef.current, remoteUserId) < 0) {
        await createAndSendOffer(entry, false);
      }
      return entry;
    })();
    creatingPeerRef.current.set(remoteUserId, creation);
    try {
      return await creation;
    } finally {
      if (creatingPeerRef.current.get(remoteUserId) === creation) {
        creatingPeerRef.current.delete(remoteUserId);
      }
    }
  // The callbacks below are defined as function declarations and intentionally
  // resolve through refs for identity/session churn.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePeerConnectionsRef, connected, emitPeerSignal, iceTransportPolicy, localStreamRef, signalingUrl]);

  async function createAndSendOffer(entry: GroupPeerConnection, iceRestart: boolean): Promise<void> {
    if (entry.isNegotiating || entry.pc.signalingState === 'closed') return;
    entry.isNegotiating = true;
    try {
      const offer = await entry.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await entry.pc.setLocalDescription(offer);
      emitPeerSignal(CLIENT_EVENTS.RTC_OFFER, entry, {
        sdp: entry.pc.localDescription ?? offer,
      });
    } catch (error) {
      logWarn('[GroupCall] Offer failed for participant', {
        peerId: entry.userId,
        message: String(error),
      });
    } finally {
      entry.isNegotiating = false;
    }
  }

  async function requestIceRestart(entry: GroupPeerConnection): Promise<void> {
    if (entry.restartPending || entry.pc.connectionState === 'closed') return;
    entry.restartPending = true;
    entry.restartAttempts += 1;
    const localUserId = localUserIdRef.current;
    if (compareUserIds(localUserId, entry.userId) < 0) {
      await createAndSendOffer(entry, true);
    } else {
      emitPeerSignal(CLIENT_EVENTS.GROUP_CALL_RESTART_REQUEST, entry, {});
    }
    const delay = Math.min(1500 * 2 ** Math.max(0, entry.restartAttempts - 1), 8000);
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      entry.restartPending = false;
      if (entry.pc.iceConnectionState === 'failed' || entry.pc.connectionState === 'failed') {
        void requestIceRestart(entry);
      }
    }, delay);
  }
  requestIceRestartRef.current = requestIceRestart;

  const applyRemoteDescription = useCallback(async (
    entry: GroupPeerConnection,
    sdp: unknown,
  ) => {
    if (!sdp || entry.pc.signalingState === 'closed') return;
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp as any));
    const pendingCandidates = entry.candidates.splice(0);
    for (const candidate of pendingCandidates) {
      await entry.pc.addIceCandidate(new RTCIceCandidate(candidate as any));
    }
  }, []);

  const join = useCallback((conversationId: string) => {
    setActiveConversationId(conversationId);
  }, []);

  const leave = useCallback((conversationId?: string) => {
    if (conversationId && selectedConversationRef.current !== conversationId) return;
    setActiveConversationId(null);
    selectedConversationRef.current = null;
  }, []);

  useEffect(() => {
    const current = snapshot;
    const self = current?.participants.find(person => person.userId === userId);
    const isMediaActive = Boolean(
      current && current.call.status !== 'ended' && self?.status === 'accepted' &&
      !isLocalMock && canJoin && connected,
    );
    if (!isMediaActive || !current) {
      closeAllPeers();
      return;
    }
    const wanted = acceptedPeerIds(current, userId).slice(0, GROUP_MESH_REMOTE_LIMIT);
    for (const peerId of [...activePeerConnectionsRef.current.keys()]) {
      if (!wanted.includes(peerId)) closePeer(peerId);
    }
    void (async () => {
      for (const peerId of wanted) await createPeer(peerId, current.callId);
    })().catch(error => {
      logWarn('[GroupCall] Could not establish participant media', { message: String(error) });
      updateStatusRef.current('Unable to connect to a group participant', 'warning');
    });
  }, [activePeerConnectionsRef, canJoin, closeAllPeers, closePeer, connected, createPeer, isLocalMock, snapshot, userId]);

  useEffect(() => {
    if (!snapshot || snapshot.call.status === 'ended' || peers === INITIAL_CALL_PEERS) return;
    for (const peerId of Object.keys(peers)) {
      const entry = activePeerConnectionsRef.current.get(peerId);
      if (!entry || entry.callId !== snapshot.callId || !connected) continue;
      emitPeerSignal(CLIENT_EVENTS.GROUP_CALL_MEDIA_STATE, entry, {
        mediaState: { isMuted, isVideoEnabled, isScreenSharing },
      });
    }
  }, [activePeerConnectionsRef, connected, emitPeerSignal, isMuted, isScreenSharing, isVideoEnabled, peers, snapshot]);

  useEffect(() => {
    const client = signalingRef.current;
    if (!client) return undefined;
    const removeOffer = client.on(SERVER_EVENTS.RTC_OFFER, async payload => {
      const current = snapshotRef.current;
      const remoteUserId = payload.peerId;
      if (
        !current || current.callId !== payload.callId ||
        !current.participants.some(person => person.userId === remoteUserId && person.status === 'accepted') ||
        compareUserIds(localUserIdRef.current, remoteUserId) <= 0
      ) return;
      try {
        const entry = await createPeer(remoteUserId, payload.callId);
        if (!entry) return;
        await applyRemoteDescription(entry, payload.sdp);
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        emitPeerSignal(CLIENT_EVENTS.RTC_ANSWER, entry, {
          sdp: entry.pc.localDescription ?? answer,
        });
      } catch (error) {
        logWarn('[GroupCall] Could not answer participant offer', {
          peerId: remoteUserId,
          message: String(error),
        });
      }
    });
    const removeAnswer = client.on(SERVER_EVENTS.RTC_ANSWER, async payload => {
      const entry = activePeerConnectionsRef.current.get(payload.peerId);
      if (!entry || entry.callId !== payload.callId) return;
      try { await applyRemoteDescription(entry, payload.sdp); }
      catch (error) {
        logWarn('[GroupCall] Could not apply participant answer', {
          peerId: payload.peerId,
          message: String(error),
        });
      }
    });
    const removeIce = client.on(SERVER_EVENTS.RTC_ICE, async payload => {
      const entry = activePeerConnectionsRef.current.get(payload.peerId);
      if (!entry || entry.callId !== payload.callId) return;
      try {
        if (!entry.pc.remoteDescription) entry.candidates.push(payload.candidate);
        else await entry.pc.addIceCandidate(new RTCIceCandidate(payload.candidate as any));
      } catch (error) {
        logWarn('[GroupCall] Could not apply participant ICE candidate', {
          peerId: payload.peerId,
          message: String(error),
        });
      }
    });
    const removeRestart = client.on(SERVER_EVENTS.GROUP_CALL_RESTART_REQUEST, payload => {
      const entry = activePeerConnectionsRef.current.get(payload.peerId);
      if (
        entry && entry.callId === payload.callId &&
        compareUserIds(localUserIdRef.current, entry.userId) < 0
      ) void requestIceRestartRef.current(entry);
    });
    const removeMedia = client.on(SERVER_EVENTS.GROUP_CALL_MEDIA_STATE, payload => {
      if (snapshotRef.current?.callId !== payload.callId) return;
      dispatchPeer({
        type: 'media',
        userId: payload.peerId,
        isMuted: Boolean(payload.mediaState?.isMuted),
        isVideoEnabled: Boolean(payload.mediaState?.isVideoEnabled),
        isScreenSharing: Boolean(payload.mediaState?.isScreenSharing),
      });
    });
    return () => {
      removeOffer();
      removeAnswer();
      removeIce();
      removeRestart();
      removeMedia();
    };
  }, [activePeerConnectionsRef, applyRemoteDescription, createPeer, emitPeerSignal, signalingRef]);

  useEffect(() => {
    if (!peers || !Object.keys(peers).length) return undefined;
    let cancelled = false;
    const sample = async () => {
      const levels: Record<string, number> = {};
      await Promise.all([...activePeerConnectionsRef.current.values()].map(async entry => {
        try {
          const stats = await entry.pc.getStats?.();
          stats?.forEach?.((report: any) => {
            levels[entry.userId] = Math.max(levels[entry.userId] ?? 0, remoteAudioLevel(report));
          });
        } catch { /* The connection-state UI remains available without stats. */ }
      }));
      if (cancelled) return;
      const speakerId = strongestSpeaker(levels);
      setActiveSpeakerId(speakerId);
      for (const peerId of Object.keys(peers)) {
        dispatchPeer({ type: 'speaker', userId: peerId, isSpeaking: peerId === speakerId });
      }
    };
    void sample();
    const timer = setInterval(() => { void sample(); }, 1200);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activePeerConnectionsRef, peers]);

  useEffect(() => () => {
    closeAllPeers();
    if (localMediaStartRef.current) {
      localMediaStartRef.current = null;
    }
  }, [closeAllPeers]);

  if (snapshot && acceptedPeerIds(snapshot, userId).length > GROUP_MESH_REMOTE_LIMIT) {
    logInfo('[GroupCall] Participant count exceeds documented mesh ceiling', {
      callId: snapshot.callId,
      total: acceptedPeerIds(snapshot, userId).length + 1,
    });
  }

  return {
    activeConversationId,
    activeCallId,
    peers,
    activeSpeakerId,
    peerConnectionsRef: activePeerConnectionsRef,
    join,
    leave,
  };
}

export type { GroupPeerConnection };
