import { useCallback, useRef } from 'react';
import { RTCPeerConnection } from 'react-native-webrtc';
import type { MediaStream } from 'react-native-webrtc';
import { logError, logInfo, logVerbose, logWarn } from '../appLogger';
import { CLIENT_EVENTS, createSignalingClient } from '../signalingClient';
import { SIGNALING_VERSION } from '../socketProtocol';
import { summarizeIceCandidate } from '../diagnostics';
import { emitMetric } from '../observability';
import * as Telemetry from '../telemetry';
import {
  ICE_TRANSPORT_POLICIES,
  getIceServersForCall,
  getTurnServerEndpoints,
} from '../webrtcConfig';
import type { IceTransportPolicy } from '../webrtcConfig';
import { decideIceConnectionState } from '../call/iceRestartLadder';
import type { RecoveryTrigger } from '../call/recoveryEpisode';
import type { Socket } from 'socket.io-client';

type MutableRef<T> = { current: T };

/**
 * The ICE candidate carried by an `onicecandidate` event; `null` on the
 * end-of-candidates event.
 */
export type PeerIceCandidateEvent = {
  candidate: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null;
};

/** The streams carried by an `ontrack` event. */
export type PeerTrackEvent = { streams: readonly MediaStream[] };

/**
 * `react-native-webrtc`'s peer connection, plus the legacy `on*` handler
 * properties it supports at runtime but omits from its published types.
 */
export type PeerConnection = RTCPeerConnection & {
  onicecandidate: ((event: PeerIceCandidateEvent) => void) | null;
  ontrack: ((event: PeerTrackEvent) => void) | null;
  oniceconnectionstatechange: ((event: unknown) => void) | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
};

export type WebrtcMediaStream = MediaStream;
type WebrtcMediaStreamTrack = ReturnType<WebrtcMediaStream['getTracks']>[number];

type RecoveryCallbacks = {
  markCallConnected: MutableRef<() => void>;
  reportCallConnected: MutableRef<(state: string) => void>;
  noteRecoverySymptom: MutableRef<(trigger: RecoveryTrigger, state?: string) => void>;
  beginIceRecovery: MutableRef<(trigger: RecoveryTrigger) => void>;
  cancelIceRestarts: MutableRef<(reason: string) => void>;
};

type UsePeerConnectionParams = {
  activeCallIdRef: MutableRef<string | null>;
  activeIceTransportPolicy: IceTransportPolicy;
  isCallerRef: MutableRef<boolean>;
  localStreamRef: MutableRef<WebrtcMediaStream | null>;
  signalingRef: MutableRef<ReturnType<typeof createSignalingClient> | null>;
  signalingUrl: string;
  socketRef: MutableRef<Socket | null>;
  setRemoteStream: (stream: WebrtcMediaStream | null) => void;
  ensureIceSessionId: () => Promise<string | null>;
  updateStatus: (message: string, severity?: 'info' | 'success' | 'warning' | 'error') => void;
  recoveryCallbacks: RecoveryCallbacks;
};

export type ReplaceOutgoingVideoTrack = (track: WebrtcMediaStreamTrack) => Promise<void>;

function trackId(track: WebrtcMediaStreamTrack): string | null {
  return typeof track?.id === 'string' && track.id.length > 0 ? track.id : null;
}

function includesTrackByIdOrReference(
  tracks: readonly WebrtcMediaStreamTrack[],
  candidate: WebrtcMediaStreamTrack,
) {
  const candidateId = trackId(candidate);
  for (const track of tracks) {
    if (track === candidate || (candidateId && trackId(track) === candidateId)) return true;
  }
  return false;
}

function resetMergedScreenAudioTracking(
  mergedTrackIds: string[],
  mergedTrackRefs: WebrtcMediaStreamTrack[],
) {
  mergedTrackIds.length = 0;
  mergedTrackRefs.length = 0;
}

function isAdditionalAudioOnlyRemoteStream(current: WebrtcMediaStream, stream: WebrtcMediaStream) {
  return stream.id !== current.id && !stream.getVideoTracks?.().length;
}

function mergeScreenAudioTracks(
  current: WebrtcMediaStream,
  stream: WebrtcMediaStream,
  mergedTrackIds: string[],
  mergedTrackRefs: WebrtcMediaStreamTrack[],
) {
  const currentTracks = current.getTracks?.() ?? [];
  for (const audioTrack of stream.getAudioTracks?.() ?? []) {
    const audioTrackId = trackId(audioTrack);
    if (
      includesTrackByIdOrReference(currentTracks, audioTrack) ||
      (audioTrackId && mergedTrackIds.includes(audioTrackId)) ||
      mergedTrackRefs.includes(audioTrack)
    ) {
      continue;
    }
    current.addTrack?.(audioTrack);
    currentTracks.push(audioTrack);
    if (audioTrackId) mergedTrackIds.push(audioTrackId);
    mergedTrackRefs.push(audioTrack);
  }
}

export default function usePeerConnection({
  activeCallIdRef,
  activeIceTransportPolicy,
  isCallerRef,
  localStreamRef,
  signalingRef,
  signalingUrl,
  socketRef,
  setRemoteStream,
  ensureIceSessionId,
  updateStatus,
  recoveryCallbacks,
}: UsePeerConnectionParams) {
  const peerConnectionRef = useRef(null as PeerConnection | null);
  const pendingPeerConnectionRef = useRef(null as Promise<PeerConnection> | null);
  const remoteStreamRef = useRef(null as WebrtcMediaStream | null);
  const mergedScreenAudioTrackIdsRef = useRef([] as string[]);
  const mergedScreenAudioTrackRefsRef = useRef([] as WebrtcMediaStreamTrack[]);
  const iceCandidateBufferRef = useRef([] as any[]);
  const isNegotiatingRef = useRef(false);

  const renegotiate = useCallback(async () => {
    const pc = peerConnectionRef.current;
    const socket = socketRef.current;
    const callId = activeCallIdRef.current;
    if (!pc || !socket?.connected || !callId) return;
    if (isNegotiatingRef.current) {
      logWarn('[CallFlow] Skipping renegotiation while another is in flight');
      return;
    }
    isNegotiatingRef.current = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signalingRef.current?.emit(
        CLIENT_EVENTS.RTC_OFFER,
        {
          version: SIGNALING_VERSION,
          callId,
          sdp: pc.localDescription ?? offer,
        },
        ack => {
          if (!ack?.ok) logWarn('[CallFlow] renegotiation rtc.offer ack failed', ack?.error);
        },
      );
      logInfo('[CallFlow] Renegotiation offer sent');
    } catch (error) {
      logError('[CallFlow] Renegotiation failed', error);
    } finally {
      isNegotiatingRef.current = false;
    }
  }, [activeCallIdRef, signalingRef, socketRef]);

  const closePeerConnection = useCallback(() => {
    iceCandidateBufferRef.current = [];
    isNegotiatingRef.current = false;
    const pending = pendingPeerConnectionRef.current;
    pendingPeerConnectionRef.current = null;
    if (pending) {
      pending
        .then(pc => {
          if (peerConnectionRef.current === pc) peerConnectionRef.current = null;
          pc?.close?.();
        })
        .catch(() => {});
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.onconnectionstatechange = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    remoteStreamRef.current = null;
    resetMergedScreenAudioTracking(
      mergedScreenAudioTrackIdsRef.current,
      mergedScreenAudioTrackRefsRef.current,
    );
    setRemoteStream(null);
  }, [setRemoteStream]);

  const createPeerConnection = useCallback(async () => {
    const iceServers = await getIceServersForCall({
      signalingUrl,
      sessionId: await ensureIceSessionId(),
    });
    const turnServers = getTurnServerEndpoints(iceServers);
    logInfo('[CallFlow] Creating RTCPeerConnection', {
      iceTransportPolicy: activeIceTransportPolicy,
      hasTurnServer: turnServers.length > 0,
      turnServers,
    });
    if (activeIceTransportPolicy === ICE_TRANSPORT_POLICIES.RELAY && turnServers.length === 0) {
      logWarn('[CallFlow] Relay ICE policy configured without a TURN server', {
        iceTransportPolicy: activeIceTransportPolicy,
      });
    }
    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: activeIceTransportPolicy,
    }) as PeerConnection;

    const currentLocalStream = localStreamRef.current;
    if (currentLocalStream) {
      const attachedTracks = new Set((pc.getSenders?.() ?? []).map(s => s.track).filter(Boolean));
      currentLocalStream.getTracks().forEach(track => {
        if (!attachedTracks.has(track)) {
          pc.addTrack(track, currentLocalStream);
        }
      });
    }

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || !socketRef.current?.connected) return;
      const summary = summarizeIceCandidate(candidate);
      logVerbose('[CallFlow] ICE candidate sent', summary);
      signalingRef.current?.emit(CLIENT_EVENTS.RTC_CANDIDATE, {
        version: SIGNALING_VERSION,
        callId: activeCallIdRef.current,
        candidate,
      });
    };

    pc.ontrack = ({ streams }) => {
      const [stream] = streams;
      if (stream) {
        logInfo('[CallFlow] Remote stream connected');
        const current = remoteStreamRef.current;
        let nextRemoteStream = stream;
        if (current && isAdditionalAudioOnlyRemoteStream(current, stream)) {
          mergeScreenAudioTracks(
            current,
            stream,
            mergedScreenAudioTrackIdsRef.current,
            mergedScreenAudioTrackRefsRef.current,
          );
          nextRemoteStream = current;
        } else {
          resetMergedScreenAudioTracking(
            mergedScreenAudioTrackIdsRef.current,
            mergedScreenAudioTrackRefsRef.current,
          );
        }
        remoteStreamRef.current = nextRemoteStream;
        setRemoteStream(nextRemoteStream);
        if (activeCallIdRef.current) {
          Telemetry.trackFirstRemoteFrame(activeCallIdRef.current);
        }
        recoveryCallbacks.markCallConnected.current();
        updateStatus('Call connected', 'success');
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      logInfo('[CallFlow] Peer connection state', { state });
      if (state === 'connected') {
        recoveryCallbacks.reportCallConnected.current(state);
      } else if (state === 'disconnected' || state === 'failed') {
        recoveryCallbacks.noteRecoverySymptom.current(
          state === 'failed' ? 'ice-failure' : 'ice-disconnected',
          state,
        );
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      logInfo('[CallFlow] ICE connection state', { state });
      const decision = decideIceConnectionState(state);
      if (decision.action === 'recovered') {
        recoveryCallbacks.reportCallConnected.current(state);
        recoveryCallbacks.cancelIceRestarts.current('ice-connected');
        return;
      }
      if (decision.action === 'ignore') return;
      recoveryCallbacks.noteRecoverySymptom.current(decision.trigger, state);
      if (!decision.restart) return;
      emitMetric('call.ice_failed', 1, { callId: activeCallIdRef.current });
      logWarn('[CallFlow] ICE failed; attempting restart', {
        callId: activeCallIdRef.current,
        isCaller: isCallerRef.current,
      });
      recoveryCallbacks.beginIceRecovery.current(decision.trigger);
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [
    activeCallIdRef,
    activeIceTransportPolicy,
    ensureIceSessionId,
    isCallerRef,
    localStreamRef,
    recoveryCallbacks,
    setRemoteStream,
    signalingRef,
    signalingUrl,
    socketRef,
    updateStatus,
  ]);

  const ensurePeerConnection = useCallback(async () => {
    if (peerConnectionRef.current) return peerConnectionRef.current;
    if (!pendingPeerConnectionRef.current) {
      const creation = createPeerConnection().finally(() => {
        if (pendingPeerConnectionRef.current === creation) {
          pendingPeerConnectionRef.current = null;
        }
      });
      pendingPeerConnectionRef.current = creation;
    }
    return pendingPeerConnectionRef.current;
  }, [createPeerConnection]);

  const replaceOutgoingVideoTrack = useCallback<ReplaceOutgoingVideoTrack>(async track => {
    const sender = peerConnectionRef.current?.getSenders?.().find(s => s.track?.kind === 'video');
    if (sender) {
      await sender.replaceTrack(track);
    }
  }, []);

  return {
    closePeerConnection,
    ensurePeerConnection,
    iceCandidateBufferRef,
    isNegotiatingRef,
    peerConnectionRef,
    pendingPeerConnectionRef,
    replaceOutgoingVideoTrack,
    remoteStreamRef,
    renegotiate,
  };
}
