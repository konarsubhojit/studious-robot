import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Vibration } from 'react-native';
import { io } from 'socket.io-client';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import { clearLogs, getLogsAsText, logDebug, logError, logInfo, logWarn } from '../appLogger';
import {
  AUDIO_ROUTES,
  chooseAudioRoute,
  setAudioRoute,
  startAudioSession,
  stopAudioSession,
  subscribeAudioDevices,
} from '../audioRouting';
import { startCallService, stopCallService } from '../callService';
import useCompactCallView from './useCompactCallView';
import { applyLightingAdjustment } from '../cameraLighting';
import { getConnectionQuality } from '../callUx';
import {
  buildExportHeader,
  getMediaAccessStatus,
  getSocketTransportName,
  sanitizeUrlForLog,
  summarizeIceCandidate,
  writeLogsFile,
} from '../diagnostics';
import { isTrackEnabled, setTrackEnabled } from '../mediaControls';
import { ensureCallPermissions } from '../permissions';
import { loadSettings, saveSettings } from '../settingsStorage';
import { getSocketOptions, isRecoverableDisconnectReason } from '../socketConfig';
import { getIceServers } from '../webrtcConfig';

const DEFAULT_SIGNALING_URL = process.env.SIGNALING_URL || 'http://localhost:4173';
const DEFAULT_ROOM_ID = process.env.ROOM_ID || 'room-1';
const DEFAULT_SETTINGS = {
  autoCameraLightingEnabled: false,
  speakerEnabledByDefault: true,
};

// How often to re-evaluate ambient lighting and auto-adjust the camera. Chosen
// to stay responsive to lighting changes while avoiding frequent applyConstraints
// calls that would add unnecessary CPU/battery overhead.
const LIGHTING_ADJUST_INTERVAL_MS = 8000;
const STATS_POLL_INTERVAL_MS = 7000;

// Short, distinct haptic pulses for key call actions.
const HAPTIC_TAP_MS = 15;
const HAPTIC_CONNECT_MS = 30;

function haptic(durationMs) {
  try {
    Vibration.vibrate(durationMs);
  } catch {
    // Vibration is best-effort; never let it break a call action.
  }
}

/**
 * Owns the entire call lifecycle: signaling (Socket.IO), the WebRTC peer
 * connection and ICE restarts, media capture/toggles, audio routing & device
 * selection, connection-quality stats, persisted settings, and log export.
 *
 * Returns serialisable state plus action callbacks so the UI layer can stay
 * purely presentational.
 */
export default function useWebRTCCall() {
  const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);
  const [roomId, setRoomId] = useState(DEFAULT_ROOM_ID);
  const [status, setStatusState] = useState({ message: 'Ready', severity: 'info' });
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isInRoom, setIsInRoom] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(DEFAULT_SETTINGS.speakerEnabledByDefault);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [isSettingsVisible, setIsSettingsVisible] = useState(false);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [isLocalPrimary, setIsLocalPrimary] = useState(false);
  const [elapsedCallSeconds, setElapsedCallSeconds] = useState(0);
  const [audioDevices, setAudioDevices] = useState({ available: [], selected: null });
  const [callSummary, setCallSummary] = useState(null);
  const [connectionQuality, setConnectionQuality] = useState({ bars: 0, label: 'No link' });

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const roomIdRef = useRef(roomId);
  const isInRoomRef = useRef(false);
  const isOffererRef = useRef(false);
  const lightingIntervalRef = useRef(null);
  const callConnectedAtRef = useRef(null);
  const elapsedTimerRef = useRef(null);
  const connectionQualityRef = useRef({ bars: 0, label: 'No link' });
  const connectionStatsRef = useRef({
    timestampMs: null,
    totalBytesReceived: 0,
  });

  const setStatus = useCallback((message, severity = 'info') => {
    setStatusState({ message, severity });
  }, []);

  const { isCompactView, setIsCompactView } = useCompactCallView(isInRoomRef);

  useEffect(() => {
    isInRoomRef.current = isInRoom;
  }, [isInRoom]);

  useEffect(() => {
    connectionQualityRef.current = connectionQuality;
  }, [connectionQuality]);

  useEffect(() => {
    clearLogs();
    logInfo('App mounted', {
      defaultSignalingUrl: sanitizeUrlForLog(DEFAULT_SIGNALING_URL),
      defaultRoomId: DEFAULT_ROOM_ID,
      platform: Platform.OS,
    });
  }, []);

  // Load persisted settings once on mount, applying the speaker default.
  useEffect(() => {
    let cancelled = false;
    loadSettings(DEFAULT_SETTINGS).then((loaded) => {
      if (cancelled) {
        return;
      }
      setSettings(loaded);
      setIsSpeakerEnabled(loaded.speakerEnabledByDefault);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    roomIdRef.current = roomId.trim();
  }, [roomId]);

  const markCallConnected = useCallback(() => {
    if (callConnectedAtRef.current) {
      return; // already connected; idempotent
    }
    haptic(HAPTIC_CONNECT_MS);
    callConnectedAtRef.current = Date.now();
    setElapsedCallSeconds(0);
    elapsedTimerRef.current = setInterval(() => {
      if (!callConnectedAtRef.current) {
        return;
      }
      setElapsedCallSeconds(Math.floor((Date.now() - callConnectedAtRef.current) / 1000));
    }, 1000);
  }, []);

  const closePeerConnection = useCallback(() => {
    isOffererRef.current = false;
    if (peerConnectionRef.current) {
      logInfo('Closing RTCPeerConnection');
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    setRemoteStream(null);
    setConnectionQuality({ bars: 0, label: 'No link' });
    connectionStatsRef.current = { timestampMs: null, totalBytesReceived: 0 };
  }, []);

  const leaveRoom = useCallback((nextStatus = 'Disconnected', severity = 'info') => {
    logInfo('Leaving room', {
      nextStatus,
      hadSocket: Boolean(socketRef.current),
      hadPeerConnection: Boolean(peerConnectionRef.current),
    });

    // Capture a short call summary if we had actually connected.
    if (callConnectedAtRef.current) {
      const durationSeconds = Math.floor((Date.now() - callConnectedAtRef.current) / 1000);
      setCallSummary({
        durationSeconds,
        quality: connectionQualityRef.current?.label || 'No link',
      });
    }

    callConnectedAtRef.current = null;
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }

    setIsInRoom(false);
    setIsReconnecting(false);
    setElapsedCallSeconds(0);
    setIsCompactView(false);
    setIsLocalPrimary(false);
    setAudioDevices({ available: [], selected: null });
    stopCallService();
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    closePeerConnection();
    setStatus(nextStatus, severity);
  }, [closePeerConnection, setStatus]);

  const ensurePeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    logInfo('Creating RTCPeerConnection');
    const connection = new RTCPeerConnection({ iceServers: getIceServers() });
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        connection.addTrack(track, localStreamRef.current);
      });
    }

    connection.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        const summary = summarizeIceCandidate(event.candidate);
        logDebug('ICE candidate sent', summary);
        socketRef.current.emit('ice-candidate', {
          roomId: roomIdRef.current,
          candidate: event.candidate,
        });
      }
    };

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        logInfo('Remote stream connected');
        setRemoteStream(stream);
        markCallConnected();
        setStatus('Call started', 'success');
      }
    };

    connection.oniceconnectionstatechange = () => {
      const state = connection.iceConnectionState;
      logInfo('ICE connection state changed', { state });
      if (state !== 'failed') {
        return;
      }
      if (!isOffererRef.current || !socketRef.current?.connected) {
        return;
      }
      logWarn('ICE connection failed; triggering ICE restart');
      const attemptIceRestart = async () => {
        try {
          const offer = await connection.createOffer({ iceRestart: true });
          await connection.setLocalDescription(offer);
          if (socketRef.current) {
            socketRef.current.emit('offer', {
              roomId: roomIdRef.current,
              sdp: connection.localDescription,
            });
            logInfo('ICE restart offer sent after ICE failure');
          }
        } catch (error) {
          logError('ICE restart after failure failed', error);
        }
      };
      void attemptIceRestart();
    };

    peerConnectionRef.current = connection;
    return connection;
  }, [markCallConnected, setStatus]);

  const syncMediaState = useCallback((stream) => {
    setIsMuted(!isTrackEnabled(stream, 'audio'));
    setIsVideoEnabled(isTrackEnabled(stream, 'video'));
  }, []);

  const adjustCameraLighting = useCallback(async () => {
    try {
      const stream = localStreamRef.current;
      if (!stream?.getVideoTracks) {
        return;
      }
      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack) {
        return;
      }
      await applyLightingAdjustment(videoTrack);
    } catch (error) {
      logError('Camera lighting auto-adjust failed', error);
    }
  }, []);

  const stopLightingMonitor = useCallback(() => {
    if (lightingIntervalRef.current) {
      clearInterval(lightingIntervalRef.current);
      lightingIntervalRef.current = null;
    }
  }, []);

  const startLightingMonitor = useCallback(() => {
    stopLightingMonitor();
    logInfo('Starting camera lighting auto-adjust monitor');
    void adjustCameraLighting();
    lightingIntervalRef.current = setInterval(() => {
      void adjustCameraLighting();
    }, LIGHTING_ADJUST_INTERVAL_MS);
  }, [adjustCameraLighting, stopLightingMonitor]);

  const startLocalPreview = useCallback(async () => {
    if (localStreamRef.current) {
      logInfo('Local media stream already available');
      syncMediaState(localStreamRef.current);
      return localStreamRef.current;
    }

    try {
      const permissionResult = await ensureCallPermissions();
      if (!permissionResult.ok) {
        logWarn('Android call permission preflight failed', permissionResult);
        setStatus(permissionResult.message, 'error');
        return null;
      }
      if (permissionResult.warningMessage) {
        logWarn('Optional Android call permission denied', {
          message: permissionResult.warningMessage,
          deniedPermissions: permissionResult.deniedPermissions,
        });
      }

      logInfo('Media permission request start');
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: 'user',
        },
      });
      logInfo('Local media stream acquired', {
        audioTracks: stream.getAudioTracks().length,
        videoTracks: stream.getVideoTracks().length,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      syncMediaState(stream);
      setStatus('Local preview ready', 'success');
      return stream;
    } catch (error) {
      logError('Failed to access local media stream', {
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
      });
      setStatus(getMediaAccessStatus(error), 'error');
      throw error;
    }
  }, [setStatus, syncMediaState]);

  const joinRoom = useCallback(async () => {
    try {
      const trimmedSignalingUrl = signalingUrl.trim();
      const trimmedRoomId = roomId.trim();
      logInfo('Join Room button press', {
        signalingUrl: sanitizeUrlForLog(trimmedSignalingUrl),
        roomId: trimmedRoomId,
      });

      if (!trimmedSignalingUrl || !trimmedRoomId) {
        setStatus('Signaling URL and room ID are required', 'error');
        return;
      }

      setCallSummary(null);
      leaveRoom();
      setIsSpeakerEnabled(settings.speakerEnabledByDefault);
      const stream = await startLocalPreview();
      if (!stream) {
        return;
      }
      setStatus('Connecting…');

      logInfo('Socket.IO connection attempt', {
        signalingUrl: sanitizeUrlForLog(trimmedSignalingUrl),
        roomId: trimmedRoomId,
      });
      const socket = io(trimmedSignalingUrl, getSocketOptions());
      socketRef.current = socket;

      socket.on('connect', () => {
        const transportName = getSocketTransportName(socket);
        logInfo('Socket.IO connect success', {
          socketId: socket.id,
          transport: transportName,
        });
        setStatus('Waiting for peer…');
        setIsInRoom(true);
        setIsReconnecting(false);
        socket.emit('join-room', roomIdRef.current);
        try {
          if (!startCallService()) {
            logWarn('Foreground call service unavailable after connect');
            setStatus('Background service unavailable', 'error');
          }
        } catch (error) {
          logError('Foreground call service start failed after connect', error);
          setStatus('Background service unavailable', 'error');
        }
      });

      const manager = socket.io;
      if (manager && typeof manager.on === 'function') {
        manager.on('reconnect_attempt', (attempt) => {
          logWarn('Socket.IO reconnect attempt', { attempt });
          setIsReconnecting(true);
          setStatus('Reconnecting…');
        });

        manager.on('reconnect', async (attempt) => {
          logInfo('Socket.IO reconnected', { attempt });
          setIsReconnecting(false);
          setStatus('Reconnected. Rejoining room...', 'success');
          socket.emit('join-room', roomIdRef.current);

          // If we were the original offerer, send an ICE-restart offer so the
          // peer connection re-negotiates a new network path without tearing
          // down the call.
          const peer = peerConnectionRef.current;
          if (peer && isOffererRef.current) {
            try {
              logInfo('Sending ICE restart offer after socket reconnect');
              const offer = await peer.createOffer({ iceRestart: true });
              await peer.setLocalDescription(offer);
              socket.emit('offer', { roomId: roomIdRef.current, sdp: peer.localDescription });
              logInfo('ICE restart offer sent after socket reconnect');
            } catch (error) {
              logError('ICE restart after socket reconnect failed', error);
            }
          }
        });

        manager.on('reconnect_failed', () => {
          logError('Socket.IO reconnect failed');
          leaveRoom('Reconnection failed', 'error');
        });
      }

      const onTransportUpgrade = socket.io?.engine?.on;
      if (typeof onTransportUpgrade === 'function') {
        onTransportUpgrade.call(socket.io.engine, 'upgrade', (transport) => {
          logInfo('Socket.IO transport upgrade', { transport: transport?.name || 'unknown' });
        });
      } else {
        logWarn('Socket.IO transport listener unavailable');
      }

      socket.on('room-full', () => {
        logWarn('room-full', { roomId: roomIdRef.current });
        leaveRoom(`Room "${roomIdRef.current}" is full`, 'error');
      });

      socket.on('peer-joined', async () => {
        logInfo('peer-joined', { roomId: roomIdRef.current });
        isOffererRef.current = true;
        try {
          const peer = ensurePeerConnection();
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          socket.emit('offer', { roomId: roomIdRef.current, sdp: offer });
          logInfo('Offer created and sent', { sdpType: offer?.type || 'unknown' });
        } catch (error) {
          logError('Failed to create/send offer', error);
          setStatus('Failed to create offer', 'error');
        }
      });

      socket.on('offer', async ({ sdp } = {}) => {
        if (!sdp) {
          logWarn('Offer received without SDP');
          return;
        }
        logInfo('Offer received', { sdpType: sdp.type || 'unknown' });
        try {
          const peer = ensurePeerConnection();
          await peer.setRemoteDescription(new RTCSessionDescription(sdp));
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          socket.emit('answer', { roomId: roomIdRef.current, sdp: answer });
          logInfo('Answer created and sent', { sdpType: answer?.type || 'unknown' });
        } catch (error) {
          logError('Failed to process offer/create answer', error);
          setStatus('Failed to process offer', 'error');
        }
      });

      socket.on('answer', async ({ sdp } = {}) => {
        if (!sdp) {
          logWarn('Answer received without SDP');
          return;
        }
        logInfo('Answer received', { sdpType: sdp.type || 'unknown' });
        try {
          const peer = ensurePeerConnection();
          await peer.setRemoteDescription(new RTCSessionDescription(sdp));
          markCallConnected();
          setStatus('Call started', 'success');
        } catch (error) {
          logError('Failed to apply remote answer', error);
          setStatus('Failed to apply answer', 'error');
        }
      });

      socket.on('ice-candidate', async ({ candidate } = {}) => {
        if (!candidate) {
          return;
        }
        const summary = summarizeIceCandidate(candidate);
        logDebug('ICE candidate received', summary);
        try {
          const peer = ensurePeerConnection();
          await peer.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
          logError('Failed to add ICE candidate', { error, summary });
        }
      });

      socket.on('peer-left', () => {
        logInfo('peer-left', { roomId: roomIdRef.current });
        closePeerConnection();
        setStatus('Peer left room');
      });

      socket.on('disconnect', (reason) => {
        logWarn('Socket.IO disconnect', { reason });
        if (isRecoverableDisconnectReason(reason)) {
          setIsReconnecting(true);
          setStatus('Reconnecting…');
          return;
        }
        setIsInRoom(false);
        setIsReconnecting(false);
        stopCallService();
        closePeerConnection();
        setStatus('Socket disconnected', 'error');
      });

      socket.on('connect_error', (error) => {
        const metadata = {
          message: error?.message,
          description: error?.description,
          context: error?.context,
          cause: error?.cause,
        };
        logError('Socket.IO connect_error', metadata);
        if (isInRoomRef.current) {
          // A call is already in progress; let the reconnection policy retry
          // instead of tearing the call down on a transient error.
          setIsReconnecting(true);
          setStatus('Reconnecting…');
          return;
        }
        setIsInRoom(false);
        setStatus(`Unable to connect: ${error?.message || 'Unknown error'}`, 'error');
      });
    } catch (error) {
      logError('joinRoom failed during media/signaling setup', error);
      setStatus(getMediaAccessStatus(error), 'error');
    }
  }, [
    closePeerConnection,
    ensurePeerConnection,
    leaveRoom,
    markCallConnected,
    roomId,
    settings.speakerEnabledByDefault,
    setStatus,
    signalingUrl,
    startLocalPreview,
  ]);

  useEffect(() => () => {
    logInfo('App cleanup/unmount');
    stopLightingMonitor();
    leaveRoom();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
  }, [leaveRoom, stopLightingMonitor]);

  useEffect(() => {
    if (!settings.autoCameraLightingEnabled || !localStream) {
      stopLightingMonitor();
      return undefined;
    }

    startLightingMonitor();
    return stopLightingMonitor;
  }, [localStream, settings.autoCameraLightingEnabled, startLightingMonitor, stopLightingMonitor]);

  useEffect(() => {
    if (!isInRoom) {
      setConnectionQuality({ bars: 0, label: 'No link' });
      connectionStatsRef.current = { timestampMs: null, totalBytesReceived: 0 };
      return undefined;
    }

    let cancelled = false;
    const pollStats = async () => {
      const peer = peerConnectionRef.current;
      if (!peer || typeof peer.getStats !== 'function') {
        return;
      }

      try {
        const report = await peer.getStats();
        if (cancelled) {
          return;
        }

        let rttMs;
        let totalPacketsLost = 0;
        let totalPacketsReceived = 0;
        let totalBytesReceived = 0;

        report.forEach((stat) => {
          if (
            stat.type === 'candidate-pair' &&
            stat.state === 'succeeded' &&
            (stat.nominated || stat.selected)
          ) {
            if (typeof stat.currentRoundTripTime === 'number') {
              rttMs = stat.currentRoundTripTime * 1000;
            }
          }

          if (
            stat.type === 'inbound-rtp' &&
            !stat.isRemote &&
            (stat.kind === 'video' || stat.mediaType === 'video')
          ) {
            totalPacketsLost += Number(stat.packetsLost || 0);
            totalPacketsReceived += Number(stat.packetsReceived || 0);
            totalBytesReceived += Number(stat.bytesReceived || 0);
          }
        });

        const now = Date.now();
        const previous = connectionStatsRef.current;
        let bitrateKbps;
        if (
          previous.timestampMs &&
          now > previous.timestampMs &&
          totalBytesReceived >= previous.totalBytesReceived
        ) {
          const bitsReceived = (totalBytesReceived - previous.totalBytesReceived) * 8;
          const elapsedMs = now - previous.timestampMs;
          bitrateKbps = bitsReceived / elapsedMs;
        }
        connectionStatsRef.current = { timestampMs: now, totalBytesReceived };

        const denominator = totalPacketsReceived + totalPacketsLost;
        const packetLossRatio = denominator > 0 ? totalPacketsLost / denominator : undefined;
        setConnectionQuality(getConnectionQuality({ rttMs, packetLossRatio, bitrateKbps }));
      } catch (error) {
        logWarn('Failed to read connection stats', { message: error?.message });
      }
    };

    pollStats();
    const intervalId = setInterval(pollStats, STATS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [isInRoom]);

  // Start/stop the in-call audio session when entering or leaving a call.
  // Splitting this from the route-update effect below prevents unnecessary
  // InCallManager stop/start cycles when only the speaker preference changes.
  useEffect(() => {
    if (!isInRoom) {
      return undefined;
    }

    const result = startAudioSession();
    if (!result.ok) {
      logWarn('InCallManager start failed', {
        message: result.message,
        nativeMessage: result.error?.message,
      });
      setStatus(result.message, 'error');
    }

    return () => {
      const stopResult = stopAudioSession();
      if (!stopResult.ok) {
        logWarn('InCallManager stop failed', {
          message: stopResult.message,
          nativeMessage: stopResult.error?.message,
        });
      }
    };
  }, [isInRoom, setStatus]);

  // Subscribe to native audio-device changes (headset/Bluetooth connect or
  // disconnect, route switches) while a call is active so the output picker
  // always reflects what's actually available.
  useEffect(() => {
    if (!isInRoom) {
      return undefined;
    }

    const unsubscribe = subscribeAudioDevices((nextStatus) => {
      logInfo('Audio devices changed', nextStatus);
      setAudioDevices(nextStatus);
    });
    return unsubscribe;
  }, [isInRoom]);

  // Update the audio output route whenever the speaker preference changes while
  // a call is active.  Runs immediately when the call starts (isInRoom flips to
  // true) to apply the initial route, and again on every subsequent toggle.
  useEffect(() => {
    if (!isInRoom) {
      return;
    }

    const routeResult = setAudioRoute(isSpeakerEnabled);
    if (!routeResult.ok) {
      if (routeResult.selected === AUDIO_ROUTES.SPEAKER_PHONE && !isSpeakerEnabled) {
        setIsSpeakerEnabled(true);
      }
      logWarn('InCallManager route update failed', {
        message: routeResult.message,
        nativeMessage: routeResult.error?.message,
      });
      setStatus(routeResult.message, 'error');
    }
  }, [isInRoom, isSpeakerEnabled, setStatus]);

  const handleSwapStreams = useCallback(() => {
    if (!remoteStream || !localStream) {
      return;
    }
    setIsLocalPrimary((previous) => !previous);
  }, [localStream, remoteStream]);

  const handleRetryReconnect = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) {
      setStatus('No active socket to reconnect', 'error');
      return;
    }
    logInfo('Manual reconnect requested');
    setIsReconnecting(true);
    setStatus('Reconnecting…');
    socket.disconnect();
    socket.connect();
  }, [setStatus]);

  const handleSpeakerToggle = useCallback(() => {
    const nextSpeakerEnabled = !isSpeakerEnabled;
    setIsSpeakerEnabled(nextSpeakerEnabled);
    setStatus(nextSpeakerEnabled ? 'Speaker enabled' : 'Speaker disabled');
  }, [isSpeakerEnabled, setStatus]);

  // Explicitly route audio to a chosen output device (speaker / earpiece /
  // Bluetooth / wired headset).  Keeps the speaker toggle state in sync.
  const chooseAudioOutput = useCallback(
    async (route) => {
      try {
        logInfo('Audio output selected', { route });
        const nextStatus = await chooseAudioRoute(route);
        if (!nextStatus.ok) {
          logWarn('Audio output selection degraded', {
            route,
            message: nextStatus.message,
            nativeMessage: nextStatus.error?.message,
          });
          setAudioDevices({ available: nextStatus.available, selected: nextStatus.selected });
          setIsSpeakerEnabled(nextStatus.selected === AUDIO_ROUTES.SPEAKER_PHONE);
          setStatus(nextStatus.message, 'error');
          return;
        }

        setAudioDevices({ available: nextStatus.available, selected: nextStatus.selected });
        setIsSpeakerEnabled(route === AUDIO_ROUTES.SPEAKER_PHONE);
        setStatus(`Audio: ${route === AUDIO_ROUTES.SPEAKER_PHONE ? 'Speaker' : route}`);
      } catch (error) {
        logError('Failed to choose audio route', { route, message: error?.message });
        setStatus('Unable to switch audio output', 'error');
      }
    },
    [setStatus],
  );

  const handleCameraSwitch = useCallback(() => {
    try {
      const [videoTrack] = localStreamRef.current?.getVideoTracks?.() || [];
      const switchCamera = videoTrack?._switchCamera;
      if (typeof switchCamera !== 'function') {
        setStatus('Camera switch unavailable', 'error');
        return;
      }

      switchCamera.call(videoTrack);
      setIsFrontCamera((previous) => !previous);
      setStatus('Camera switched');
    } catch (error) {
      logError('Camera switch failed', error);
      setStatus('Camera switch unavailable', 'error');
    }
  }, [setStatus]);

  const handleRoomButtonPress = useCallback(() => {
    if (isInRoom) {
      logInfo('Leave Room button press');
      haptic(HAPTIC_TAP_MS);
      leaveRoom('Disconnected');
      return;
    }

    joinRoom().catch((error) => {
      logError('joinRoom unhandled rejection', error);
      setStatus('Failed to start call', 'error');
    });
  }, [isInRoom, joinRoom, leaveRoom, setStatus]);

  const handleAutoLightingToggle = useCallback(() => {
    const nextValue = !settings.autoCameraLightingEnabled;
    setSettings((previous) => {
      const next = { ...previous, autoCameraLightingEnabled: nextValue };
      void saveSettings(next);
      return next;
    });
    setStatus(nextValue ? 'Auto camera lighting enabled' : 'Auto camera lighting disabled');
  }, [settings.autoCameraLightingEnabled, setStatus]);

  const handleSpeakerDefaultToggle = useCallback(() => {
    const nextValue = !settings.speakerEnabledByDefault;
    setSettings((previous) => {
      const next = { ...previous, speakerEnabledByDefault: nextValue };
      void saveSettings(next);
      return next;
    });
    if (!isInRoom) {
      setIsSpeakerEnabled(nextValue);
    }
    setStatus(nextValue ? 'Speaker default enabled' : 'Speaker default disabled');
  }, [isInRoom, settings.speakerEnabledByDefault, setStatus]);

  const handleExportLogs = useCallback(async () => {
    try {
      logInfo('Export Logs button press');
      const header = buildExportHeader({
        signalingUrl: signalingUrl.trim(),
        roomId: roomId.trim(),
        status: status.message,
        localStream,
        remoteStream,
        isInRoom,
        socket: socketRef.current,
      });
      const content = `${header}\n${getLogsAsText()}\n`;
      const result = await writeLogsFile(content);

      if (result.success) {
        const statusMessage = result.usedFallback
          ? `Logs saved to fallback (${result.label}): ${result.path}`
          : `Logs saved: ${result.path}`;
        logInfo('Logs exported', {
          path: result.path,
          storage: result.label,
          usedFallback: result.usedFallback,
        });
        setStatus(statusMessage, 'success');
      } else {
        logError('Failed to export logs', result.error);
        setStatus(`Failed to export logs: ${result.error?.message || 'Unknown error'}`, 'error');
      }
    } catch (error) {
      logError('Unexpected export logs failure', error);
      setStatus(`Failed to export logs: ${error?.message || 'Unknown error'}`, 'error');
    }
  }, [isInRoom, localStream, remoteStream, roomId, setStatus, signalingUrl, status.message]);

  const handleMuteToggle = useCallback(() => {
    try {
      const nextMuted = !isMuted;
      logInfo('Mute toggle action', { nextMuted });
      if (!setTrackEnabled(localStreamRef.current, 'audio', !nextMuted)) {
        setStatus('Start preview to control audio', 'error');
        return;
      }

      haptic(HAPTIC_TAP_MS);
      setIsMuted(nextMuted);
      setStatus(nextMuted ? 'Muted microphone' : 'Unmuted microphone');
    } catch (error) {
      logError('Mute toggle failed', error);
      setStatus('Unable to control microphone', 'error');
    }
  }, [isMuted, setStatus]);

  const handleVideoToggle = useCallback(() => {
    try {
      const nextVideoEnabled = !isVideoEnabled;
      logInfo('Video toggle action', { nextVideoEnabled });
      if (!setTrackEnabled(localStreamRef.current, 'video', nextVideoEnabled)) {
        setStatus('Start preview to control video', 'error');
        return;
      }

      setIsVideoEnabled(nextVideoEnabled);
      setStatus(nextVideoEnabled ? 'Camera enabled' : 'Camera disabled');
    } catch (error) {
      logError('Video toggle failed', error);
      setStatus('Unable to control camera', 'error');
    }
  }, [isVideoEnabled, setStatus]);

  const dismissCallSummary = useCallback(() => {
    setCallSummary(null);
  }, []);

  return {
    // form state
    signalingUrl,
    setSignalingUrl,
    roomId,
    setRoomId,
    // status
    status,
    // media / call state
    localStream,
    remoteStream,
    isInRoom,
    isReconnecting,
    isMuted,
    isVideoEnabled,
    isSpeakerEnabled,
    isCompactView,
    isLocalPrimary,
    isFrontCamera,
    elapsedCallSeconds,
    connectionQuality,
    audioDevices,
    callSummary,
    // settings
    settings,
    isSettingsVisible,
    setIsSettingsVisible,
    // actions
    startLocalPreview,
    handleRoomButtonPress,
    handleMuteToggle,
    handleVideoToggle,
    handleSpeakerToggle,
    handleCameraSwitch,
    handleSwapStreams,
    handleRetryReconnect,
    handleAutoLightingToggle,
    handleSpeakerDefaultToggle,
    handleExportLogs,
    chooseAudioOutput,
    dismissCallSummary,
  };
}
