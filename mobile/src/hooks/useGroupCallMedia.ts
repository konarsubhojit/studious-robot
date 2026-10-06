import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { RTCPeerConnection, RTCIceCandidate, RTCSessionDescription } from 'react-native-webrtc';
import { SERVER_EVENTS, CLIENT_EVENTS, SIGNALING_VERSION, groupNegotiationId } from '../../../shared';
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
  negotiationId: string;
  pc: PeerConnection;
  candidates: unknown[];
  isNegotiating: boolean;
  restartPending: boolean;
  restartAttempts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  descriptionQueue: Promise<void>;
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
  const localMediaStartRef = useRef<{
    session: string;
    promise: Promise<WebrtcMediaStream | null>;
  } | null>(null);
  const requestedRestartRef = useRef(new Set<string>());
  const requestIceRestartRef = useRef<(entry: GroupPeerConnection) => Promise<void>>(async () => {});
  const mediaAllowedRef = useRef(false);
  const mediaEpochRef = useRef(0);

  selectedConversationRef.current = activeConversationId;
  localUserIdRef.current = userId;
  startLocalPreviewRef.current = startLocalPreview;
  ensureIceSessionIdRef.current = ensureIceSessionId;
  updateStatusRef.current = updateStatus;

  const snapshot = activeConversationId
    ? Object.values(groupCalls).find(call => call.conversationId === activeConversationId) ?? null
    : null;
  snapshotRef.current = snapshot;
  const activeCallId = snapshot?.call.status !== 'ended' &&
    snapshot?.participants.some(person => person.userId === userId && person.status === 'accepted')
    ? snapshot.callId : null;
  const isLocalMock = Boolean(conversations.find(row =>
    row.peerId === activeConversationId && row.localMock,
  ));
  mediaAllowedRef.current = Boolean(activeCallId && !isLocalMock && canJoin && connected);

  const currentNegotiation = useCallback((peerId: string, callId: string): string | null => {
    const current = snapshotRef.current;
    if (!mediaAllowedRef.current || current?.callId !== callId ||
      !current.participants.some(person => person.userId === peerId && person.status === 'accepted')) return null;
    return groupNegotiationId(current.participants, localUserIdRef.current, peerId);
  }, []);

  const ensureLocalMedia = useCallback(() => {
    const current = snapshotRef.current;
    if (!current || !mediaAllowedRef.current) return Promise.resolve(null);
    const self = current.participants.find(person => person.userId === localUserIdRef.current);
    const session = JSON.stringify([current.callId, self?.acceptedAt]);
    if (localMediaStartRef.current?.session !== session) {
      localMediaStartRef.current = {
        session,
        promise: startLocalPreviewRef.current(current.call.mediaType === 'audio' ? 'audio' : 'video'),
      };
    }
    return localMediaStartRef.current.promise;
  }, []);

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
    requestedRestartRef.current.delete(peerId);
    dispatchPeer({ type: 'leave', userId: peerId });
  }, [activePeerConnectionsRef]);

  const closeAllPeers = useCallback(() => {
    mediaEpochRef.current += 1;
    [...activePeerConnectionsRef.current.keys()].forEach(closePeer);
    creatingPeerRef.current.clear();
    localMediaStartRef.current = null;
    requestedRestartRef.current.clear();
    dispatchPeer({ type: 'reset' });
    setActiveSpeakerId(null);
  }, [activePeerConnectionsRef, closePeer]);

  const emitPeerSignal = useCallback((
    event: string,
    entry: GroupPeerConnection,
    payload: object,
  ) => {
    if (!signalingRef.current ||
      activePeerConnectionsRef.current.get(entry.userId) !== entry ||
      currentNegotiation(entry.userId, entry.callId) !== entry.negotiationId) return;
    signalingRef.current.emit(event, {
      version: SIGNALING_VERSION,
      callId: entry.callId,
      peerId: entry.userId,
      negotiationId: entry.negotiationId,
      ...payload,
    });
  }, [activePeerConnectionsRef, currentNegotiation, signalingRef]);

  const createPeer = useCallback(async (
    remoteUserId: string,
    callId: string,
  ): Promise<GroupPeerConnection | null> => {
    const negotiationId = currentNegotiation(remoteUserId, callId);
    if (!negotiationId) return null;
    const epoch = mediaEpochRef.current;
    const creationKey = JSON.stringify([callId, epoch, negotiationId]);
    const isCurrent = () => epoch === mediaEpochRef.current &&
      currentNegotiation(remoteUserId, callId) === negotiationId;
    const existing = activePeerConnectionsRef.current.get(remoteUserId);
    if (existing?.callId === callId && existing.negotiationId === negotiationId) return existing;
    if (existing) closePeer(remoteUserId);
    const pending = creatingPeerRef.current.get(creationKey);
    if (pending) return pending;
    const creation = (async () => {
      const current = snapshotRef.current;
      if (
        !current || current.callId !== callId ||
        !current.participants.some(person => person.userId === remoteUserId && person.status === 'accepted') ||
        !current.participants.some(person => person.userId === localUserIdRef.current && person.status === 'accepted')
      ) return null;

      const capturedStream = await ensureLocalMedia();
      const localStream = localStreamRef.current ?? capturedStream;
      if (!localStream || !isCurrent()) return null;

      const iceServers = await getIceServersForCall({
        signalingUrl,
        sessionId: await ensureIceSessionIdRef.current(),
      });
      if (!isCurrent()) return null;
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
        negotiationId,
        pc,
        candidates: [],
        isNegotiating: false,
        restartPending: false,
        restartAttempts: 0,
        restartTimer: null,
        descriptionQueue: Promise.resolve(),
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
      } else {
        // The first offer may arrive before this client selects the room.
        // Once ready, ask the deterministic offerer to negotiate again.
        emitPeerSignal(CLIENT_EVENTS.GROUP_CALL_RESTART_REQUEST, entry, {});
      }
      return entry;
    })();
    creatingPeerRef.current.set(creationKey, creation);
    try {
      return await creation;
    } finally {
      if (creatingPeerRef.current.get(creationKey) === creation) {
        creatingPeerRef.current.delete(creationKey);
      }
    }
  // The callbacks below are defined as function declarations and intentionally
  // resolve through refs for identity/session churn.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePeerConnectionsRef, closePeer, currentNegotiation, emitPeerSignal, ensureLocalMedia, iceTransportPolicy, localStreamRef, signalingUrl]);

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
    if (activePeerConnectionsRef.current.get(entry.userId) !== entry) return;
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

  const queueDescription = useCallback((entry: GroupPeerConnection, apply: () => Promise<void>) => {
    const operation = entry.descriptionQueue.then(async () => {
      if (activePeerConnectionsRef.current.get(entry.userId) !== entry ||
        currentNegotiation(entry.userId, entry.callId) !== entry.negotiationId) return;
      await apply();
    });
    // A failed description must not poison later negotiations for this pair.
    entry.descriptionQueue = operation.catch(() => {});
    return operation;
  }, [activePeerConnectionsRef, currentNegotiation]);

  const join = useCallback((conversationId: string) => {
    setActiveConversationId(conversationId);
  }, []);

  const leave = useCallback((conversationId?: string) => {
    if (conversationId && selectedConversationRef.current !== conversationId) return;
    setActiveConversationId(null);
    selectedConversationRef.current = null;
    mediaAllowedRef.current = false;
    closeAllPeers();
  }, [closeAllPeers]);

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
      const entry = activePeerConnectionsRef.current.get(peerId);
      if (!wanted.includes(peerId) || entry?.callId !== current.callId ||
        entry.negotiationId !== currentNegotiation(peerId, current.callId)) closePeer(peerId);
    }
    void (async () => {
      await ensureLocalMedia();
      for (const peerId of wanted) await createPeer(peerId, current.callId);
    })().catch(error => {
      logWarn('[GroupCall] Could not establish participant media', { message: String(error) });
      updateStatusRef.current('Unable to connect to a group participant', 'warning');
    });
  }, [activePeerConnectionsRef, canJoin, closeAllPeers, closePeer, connected, createPeer, currentNegotiation, ensureLocalMedia, isLocalMock, snapshot, userId]);

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
        payload.negotiationId !== currentNegotiation(remoteUserId, payload.callId) ||
        !current.participants.some(person => person.userId === remoteUserId && person.status === 'accepted') ||
        compareUserIds(localUserIdRef.current, remoteUserId) <= 0
      ) return;
      try {
        const entry = await createPeer(remoteUserId, payload.callId);
        if (!entry || entry.negotiationId !== payload.negotiationId) return;
        await queueDescription(entry, async () => {
          if (entry.pc.remoteDescription?.sdp !== payload.sdp?.sdp ||
            entry.pc.localDescription?.type !== 'answer') {
            await applyRemoteDescription(entry, payload.sdp);
            const answer = await entry.pc.createAnswer();
            await entry.pc.setLocalDescription(answer);
          }
          emitPeerSignal(CLIENT_EVENTS.RTC_ANSWER, entry, { sdp: entry.pc.localDescription });
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
      if (!entry || entry.callId !== payload.callId ||
        entry.negotiationId !== payload.negotiationId ||
        currentNegotiation(payload.peerId, payload.callId) !== payload.negotiationId) return;
      try {
        await queueDescription(entry, async () => {
          if (entry.pc.remoteDescription?.sdp !== payload.sdp?.sdp) {
            await applyRemoteDescription(entry, payload.sdp);
          }
        });
      }
      catch (error) {
        logWarn('[GroupCall] Could not apply participant answer', {
          peerId: payload.peerId,
          message: String(error),
        });
      }
    });
    const removeIce = client.on(SERVER_EVENTS.RTC_ICE, async payload => {
      if (currentNegotiation(payload.peerId, payload.callId) !== payload.negotiationId) return;
      try {
        const entry = await createPeer(payload.peerId, payload.callId);
        if (!entry || entry.negotiationId !== payload.negotiationId) return;
        if (!entry.pc.remoteDescription) {
          if (entry.candidates.length < 128) entry.candidates.push(payload.candidate);
        }
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
        entry.negotiationId === payload.negotiationId &&
        currentNegotiation(payload.peerId, payload.callId) === payload.negotiationId &&
        compareUserIds(localUserIdRef.current, entry.userId) < 0
      ) {
        if (entry.pc.signalingState === 'have-local-offer' && entry.pc.localDescription) {
          // Resend the outstanding offer instead of replacing its ICE
          // credentials while the responder is still answering it.
          emitPeerSignal(CLIENT_EVENTS.RTC_OFFER, entry, { sdp: entry.pc.localDescription });
        } else {
          void requestIceRestartRef.current(entry);
        }
      }
    });
    const removeMedia = client.on(SERVER_EVENTS.GROUP_CALL_MEDIA_STATE, payload => {
      if (currentNegotiation(payload.peerId, payload.callId) !== payload.negotiationId) return;
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
  }, [activePeerConnectionsRef, applyRemoteDescription, connected, createPeer, currentNegotiation, emitPeerSignal, queueDescription, signalingRef]);

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
    mediaAllowedRef.current = false;
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
