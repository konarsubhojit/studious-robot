import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  NativeModules,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import RNFS from 'react-native-fs';
import { io } from 'socket.io-client';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
} from 'react-native-webrtc';
import appConfig from './app.json';
import { clearLogs, getLogsAsText, logDebug, logError, logInfo, logWarn, LOG_LEVEL } from './src/appLogger';
import { applyLightingAdjustment } from './src/cameraLighting';
import { clamp, formatCallDuration, getConnectionQuality } from './src/callUx';
import {
  classifyMediaError,
  summarizeIceServers,
  summarizeSelectedCandidatePair,
} from './src/iceDiagnostics';
import { createCorrelationId, runStep } from './src/logSteps';
import { isTrackEnabled, setTrackEnabled } from './src/mediaControls';
import { getSocketOptions, isRecoverableDisconnectReason } from './src/socketConfig';
import { getIceServers } from './src/webrtcConfig';
import { setAudioRoute, startAudioSession, stopAudioSession } from './src/audioRouting';

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
const PIP_WIDTH = 110;
const PIP_HEIGHT = 155;
const PIP_MARGIN = 12;

function formatDateForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function getReactNativeVersion() {
  const version = Platform.constants?.reactNativeVersion;
  if (!version) {
    return 'unknown';
  }
  const major = version.major ?? '?';
  const minor = version.minor ?? '?';
  const patch = version.patch ?? '?';
  return `${major}.${minor}.${patch}`;
}

function getReactNativeWebrtcVersion() {
  try {
    return require('react-native-webrtc/package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function isNewArchitectureEnabled() {
  return Boolean(globalThis?.nativeFabricUIManager) || Boolean(globalThis?.RN$Bridgeless);
}

function getApplicationId() {
  const maybeBundleId =
    NativeModules?.PlatformConstants?.bundleIdentifier ||
    NativeModules?.SettingsManager?.settings?.CFBundleIdentifier ||
    NativeModules?.PlatformConstants?.applicationId;

  return maybeBundleId || 'unknown';
}

function getSocketTransportName(socket) {
  return socket?.io?.engine?.transport?.name || 'unknown';
}

function sanitizeUrlForLog(urlValue) {
  if (!urlValue) {
    return '';
  }

  try {
    const parsed = new URL(urlValue);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return urlValue;
  }
}

function summarizeIceCandidate(candidate) {
  if (!candidate) {
    return { hasCandidate: false };
  }

  const candidateText = candidate.candidate || '';
  const parts = candidateText.split(' ');
  const protocol = parts[2] ? parts[2].toLowerCase() : undefined;
  const typeMatch = candidateText.match(/\btyp\s+([a-z0-9]+)/i);

  return {
    hasCandidate: true,
    protocol: protocol || 'unknown',
    candidateType: typeMatch?.[1] || 'unknown',
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
  };
}

function buildExportHeader({
  signalingUrl,
  roomId,
  status,
  localStream,
  remoteStream,
  isInRoom,
  socket,
  peerConnection,
  callId,
}) {
  const turnSummary = summarizeIceServers(getIceServers());
  const lines = [
    'studious-robot diagnostic logs',
    `exportedAt: ${new Date().toISOString()}`,
    `appName: ${appConfig?.displayName || appConfig?.name || 'unknown'}`,
    `applicationId: ${getApplicationId()}`,
    `platform: ${Platform.OS}`,
    `osVersion: ${Platform.Version}`,
    `reactNativeVersion: ${getReactNativeVersion()}`,
    `reactNativeWebrtcVersion: ${getReactNativeWebrtcVersion()}`,
    `newArchitecture: ${isNewArchitectureEnabled()}`,
    `logLevel: ${LOG_LEVEL}`,
    `turnConfigured: ${turnSummary.turnConfigured}`,
    `iceServerCount: ${turnSummary.iceServerCount}`,
    `signalingUrl: ${sanitizeUrlForLog(signalingUrl)}`,
    `roomId: ${roomId || ''}`,
    `callId: ${callId || 'none'}`,
    `appStatus: ${status || ''}`,
    `hasLocalStream: ${Boolean(localStream)}`,
    `hasRemoteStream: ${Boolean(remoteStream)}`,
    `isInRoom: ${Boolean(isInRoom)}`,
    `socketConnected: ${Boolean(socket?.connected)}`,
    `socketId: ${socket?.id || 'none'}`,
    `socketTransport: ${getSocketTransportName(socket)}`,
    `connectionState: ${peerConnection?.connectionState || 'none'}`,
    `iceConnectionState: ${peerConnection?.iceConnectionState || 'none'}`,
    `iceGatheringState: ${peerConnection?.iceGatheringState || 'none'}`,
    `signalingState: ${peerConnection?.signalingState || 'none'}`,
    '',
    '--- logs ---',
  ];

  return lines.join('\n');
}

async function writeLogsFile(content) {
  const fileName = `studious-robot-logs-${formatDateForFile()}.txt`;
  const targets = Platform.OS === 'android'
    ? [
        { directory: RNFS.DownloadDirectoryPath, label: 'Downloads', primary: true },
        { directory: RNFS.ExternalDirectoryPath, label: 'app external storage', primary: false },
        { directory: RNFS.DocumentDirectoryPath, label: 'app documents', primary: false },
      ]
    : [{ directory: RNFS.DocumentDirectoryPath, label: 'app documents', primary: true }];

  let firstError;

  for (const target of targets) {
    if (!target.directory) {
      continue;
    }

    const path = `${target.directory}/${fileName}`;
    try {
      await RNFS.writeFile(path, content, 'utf8');
      return {
        success: true,
        path,
        label: target.label,
        usedFallback: !target.primary,
      };
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
    }
  }

  return { success: false, error: firstError };
}

export default function App() {
  const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);
  const [roomId, setRoomId] = useState(DEFAULT_ROOM_ID);
  const [status, setStatus] = useState('Ready');
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isInRoom, setIsInRoom] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(DEFAULT_SETTINGS.speakerEnabledByDefault);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [isSettingsVisible, setIsSettingsVisible] = useState(false);
  const [isLocalPrimary, setIsLocalPrimary] = useState(false);
  const [callConnectedAt, setCallConnectedAt] = useState(null);
  const [elapsedCallSeconds, setElapsedCallSeconds] = useState(0);
  const [connectionQuality, setConnectionQuality] = useState({ bars: 0, label: 'No link' });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [pipPosition, setPipPosition] = useState({ x: PIP_MARGIN, y: PIP_MARGIN });

  const pipX = useSharedValue(PIP_MARGIN);
  const pipY = useSharedValue(PIP_MARGIN);
  const pipStartX = useSharedValue(PIP_MARGIN);
  const pipStartY = useSharedValue(PIP_MARGIN);

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const roomIdRef = useRef(roomId);
  const isInRoomRef = useRef(false);
  const isOffererRef = useRef(false);
  const lightingIntervalRef = useRef(null);
  const callIdRef = useRef(null);
  const relaySummaryLoggedRef = useRef(false);
  const connectionStatsRef = useRef({
    timestampMs: null,
    totalBytesReceived: 0,
  });

  // Build correlation metadata so a single call can be traced end-to-end across
  // all signaling/WebRTC/ICE log lines.
  const callMeta = useCallback(
    (extra) => ({ callId: callIdRef.current, roomId: roomIdRef.current, ...extra }),
    [],
  );

  useEffect(() => {
    isInRoomRef.current = isInRoom;
  }, [isInRoom]);

  useEffect(() => {
    clearLogs();
    const turnSummary = summarizeIceServers(getIceServers());
    logInfo('[lifecycle] App mounted', {
      defaultSignalingUrl: sanitizeUrlForLog(DEFAULT_SIGNALING_URL),
      defaultRoomId: DEFAULT_ROOM_ID,
      platform: Platform.OS,
      osVersion: Platform.Version,
      reactNativeVersion: getReactNativeVersion(),
      reactNativeWebrtcVersion: getReactNativeWebrtcVersion(),
      newArchitecture: isNewArchitectureEnabled(),
      logLevel: LOG_LEVEL,
      turnConfigured: turnSummary.turnConfigured,
      turnSchemes: turnSummary.turnSchemes,
    });
  }, []);

  useEffect(() => {
    roomIdRef.current = roomId.trim();
  }, [roomId]);

  const markCallConnected = useCallback(() => {
    setCallConnectedAt((previous) => previous || Date.now());
  }, []);

  const getPipBounds = useCallback(() => {
    const maxX = Math.max(PIP_MARGIN, stageSize.width - PIP_WIDTH - PIP_MARGIN);
    const maxY = Math.max(PIP_MARGIN, stageSize.height - PIP_HEIGHT - PIP_MARGIN);
    return { minX: PIP_MARGIN, minY: PIP_MARGIN, maxX, maxY };
  }, [stageSize.height, stageSize.width]);

  const closePeerConnection = useCallback(() => {
    isOffererRef.current = false;
    relaySummaryLoggedRef.current = false;
    if (peerConnectionRef.current) {
      logInfo('[teardown] Closing RTCPeerConnection', callMeta());
      const connection = peerConnectionRef.current;
      connection.onicecandidate = null;
      connection.ontrack = null;
      connection.onconnectionstatechange = null;
      connection.oniceconnectionstatechange = null;
      connection.onicegatheringstatechange = null;
      connection.onsignalingstatechange = null;
      connection.onicecandidateerror = null;
      connection.onnegotiationneeded = null;
      connection.close();
      peerConnectionRef.current = null;
    }
    setRemoteStream(null);
    setConnectionQuality({ bars: 0, label: 'No link' });
    connectionStatsRef.current = { timestampMs: null, totalBytesReceived: 0 };
  }, [callMeta]);

  const leaveRoom = useCallback((nextStatus = 'Disconnected') => {
    logInfo('[teardown] Leaving room', callMeta({
      nextStatus,
      hadSocket: Boolean(socketRef.current),
      hadPeerConnection: Boolean(peerConnectionRef.current),
    }));
    setIsInRoom(false);
    setIsReconnecting(false);
    setCallConnectedAt(null);
    setElapsedCallSeconds(0);
    setIsLocalPrimary(false);
    if (socketRef.current) {
      logInfo('[teardown] Disconnecting signaling socket', callMeta());
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    closePeerConnection();
    setStatus(nextStatus);
  }, [callMeta, closePeerConnection]);

  const ensurePeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const iceServers = getIceServers();
    const iceSummary = summarizeIceServers(iceServers);
    logInfo('[webrtc] Creating RTCPeerConnection', callMeta({
      iceServerCount: iceSummary.iceServerCount,
      turnConfigured: iceSummary.turnConfigured,
      turnSchemes: iceSummary.turnSchemes,
    }));

    let connection;
    try {
      connection = new RTCPeerConnection({ iceServers });
    } catch (error) {
      logError('[webrtc] RTCPeerConnection creation failed', callMeta({
        name: error?.name,
        message: error?.message,
      }));
      throw error;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        connection.addTrack(track, localStreamRef.current);
        logInfo('[webrtc] addTrack', callMeta({ kind: track.kind, enabled: track.enabled }));
      });
    }

    connection.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        const summary = summarizeIceCandidate(event.candidate);
        logDebug('[signaling] send ice-candidate', callMeta({ direction: 'send', ...summary }));
        socketRef.current.emit('ice-candidate', {
          roomId: roomIdRef.current,
          candidate: event.candidate,
        });
      }
    };

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        const tracks = typeof stream.getTracks === 'function' ? stream.getTracks() : [];
        logInfo('[webrtc] Remote stream attached (ontrack)', callMeta({
          trackCount: tracks.length,
          kinds: tracks.map((track) => track.kind),
        }));
        setRemoteStream(stream);
        markCallConnected();
        setStatus('Remote stream connected');
      }
    };

    connection.onconnectionstatechange = () => {
      logInfo('[webrtc] connectionState changed', callMeta({
        connectionState: connection.connectionState,
      }));
    };

    connection.onicegatheringstatechange = () => {
      logInfo('[ice] iceGatheringState changed', callMeta({
        iceGatheringState: connection.iceGatheringState,
      }));
    };

    connection.onsignalingstatechange = () => {
      logInfo('[signaling] signalingState changed', callMeta({
        signalingState: connection.signalingState,
      }));
    };

    connection.onicecandidateerror = (event) => {
      logWarn('[ice] icecandidateerror', callMeta({
        errorCode: event?.errorCode,
        errorText: event?.errorText,
        url: event?.url,
        address: event?.address,
        port: event?.port,
      }));
    };

    connection.onnegotiationneeded = () => {
      logInfo('[webrtc] negotiationneeded', callMeta({
        signalingState: connection.signalingState,
      }));
    };

    connection.oniceconnectionstatechange = () => {
      const state = connection.iceConnectionState;
      logInfo('[ice] iceConnectionState changed', callMeta({ iceConnectionState: state }));
      if (state !== 'failed') {
        return;
      }
      if (!isOffererRef.current || !socketRef.current?.connected) {
        return;
      }
      logWarn('[ice] ICE connection failed; triggering ICE restart', callMeta());
      runStep('[webrtc] ICE-restart offer (after failure)', async () => {
        const offer = await connection.createOffer({ iceRestart: true });
        await connection.setLocalDescription(offer);
        if (socketRef.current) {
          socketRef.current.emit('offer', {
            roomId: roomIdRef.current,
            sdp: connection.localDescription,
          });
          logInfo('[signaling] send offer (ice-restart)', callMeta({
            direction: 'send',
            sdpType: connection.localDescription?.type || 'unknown',
            iceRestart: true,
          }));
        }
      }, callMeta({ iceRestart: true })).catch(() => {
        // runStep already logged the error with timing/correlation metadata.
      });
    };

    peerConnectionRef.current = connection;
    return connection;
  }, [callMeta, markCallConnected]);

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
      logError('[media] Camera lighting auto-adjust failed', callMeta({ name: error?.name, message: error?.message }));
    }
  }, [callMeta]);

  const stopLightingMonitor = useCallback(() => {
    if (lightingIntervalRef.current) {
      clearInterval(lightingIntervalRef.current);
      lightingIntervalRef.current = null;
    }
  }, []);

  const startLightingMonitor = useCallback(() => {
    stopLightingMonitor();
    logInfo('[media] Starting camera lighting auto-adjust monitor');
    void adjustCameraLighting();
    lightingIntervalRef.current = setInterval(() => {
      void adjustCameraLighting();
    }, LIGHTING_ADJUST_INTERVAL_MS);
  }, [adjustCameraLighting, stopLightingMonitor]);

  const startLocalPreview = useCallback(async () => {
    if (localStreamRef.current) {
      logInfo('[media] Local media stream already available');
      syncMediaState(localStreamRef.current);
      return localStreamRef.current;
    }

    try {
      const stream = await runStep('[permissions] getUserMedia', () => mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: 'user',
        },
      }));

      const [videoTrack] = stream.getVideoTracks();
      const videoSettings =
        videoTrack && typeof videoTrack.getSettings === 'function' ? videoTrack.getSettings() : {};
      logInfo('[media] Local media stream acquired', {
        audioTracks: stream.getAudioTracks().length,
        videoTracks: stream.getVideoTracks().length,
        videoTrackLabel: videoTrack?.label,
        videoSettings: {
          width: videoSettings?.width,
          height: videoSettings?.height,
          frameRate: videoSettings?.frameRate,
          facingMode: videoSettings?.facingMode,
        },
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      syncMediaState(stream);
      logInfo('[media] Local stream attached to preview UI');
      setStatus('Local preview ready');
      return stream;
    } catch (error) {
      logError('[permissions] getUserMedia failed', {
        name: error?.name,
        message: error?.message,
        category: classifyMediaError(error),
      });
      throw error;
    }
  }, [syncMediaState]);

  const joinRoom = useCallback(async () => {
    try {
      const trimmedSignalingUrl = signalingUrl.trim();
      const trimmedRoomId = roomId.trim();
      const callId = createCorrelationId();
      callIdRef.current = callId;
      relaySummaryLoggedRef.current = false;
      logInfo('[lifecycle] Join Room button press', {
        signalingUrl: sanitizeUrlForLog(trimmedSignalingUrl),
        roomId: trimmedRoomId,
        callId,
      });

      if (!trimmedSignalingUrl || !trimmedRoomId) {
        setStatus('Signaling URL and room ID are required');
        return;
      }

      leaveRoom();
      setIsSpeakerEnabled(settings.speakerEnabledByDefault);
      await startLocalPreview();
      setStatus('Connecting to signaling server...');

      logInfo('[signaling] Socket.IO connection attempt', callMeta({
        signalingUrl: sanitizeUrlForLog(trimmedSignalingUrl),
      }));
      const socket = io(trimmedSignalingUrl, getSocketOptions());
      socketRef.current = socket;

      socket.on('connect', () => {
        const transportName = getSocketTransportName(socket);
        logInfo('[signaling] connect success', callMeta({
          socketId: socket.id,
          transport: transportName,
        }));
        setStatus('Connected to signaling. Joining room...');
        setIsInRoom(true);
        setIsReconnecting(false);
        logInfo('[signaling] send join-room', callMeta({ direction: 'send' }));
        socket.emit('join-room', roomIdRef.current);
      });

      const manager = socket.io;
      if (manager && typeof manager.on === 'function') {
        manager.on('reconnect_attempt', (attempt) => {
          logWarn('[signaling] reconnect attempt', callMeta({ attempt }));
          setIsReconnecting(true);
          setStatus('Reconnecting…');
        });

        manager.on('reconnect', async (attempt) => {
          logInfo('[signaling] reconnected', callMeta({ attempt }));
          setIsReconnecting(false);
          setStatus('Reconnected. Rejoining room...');
          logInfo('[signaling] send join-room (rejoin)', callMeta({ direction: 'send' }));
          socket.emit('join-room', roomIdRef.current);

          // If we were the original offerer, send an ICE-restart offer so the
          // peer connection re-negotiates a new network path without tearing
          // down the call.
          const peer = peerConnectionRef.current;
          if (peer && isOffererRef.current) {
            await runStep('[webrtc] ICE-restart offer (after reconnect)', async () => {
              const offer = await peer.createOffer({ iceRestart: true });
              await peer.setLocalDescription(offer);
              socket.emit('offer', { roomId: roomIdRef.current, sdp: peer.localDescription });
              logInfo('[signaling] send offer (ice-restart)', callMeta({
                direction: 'send',
                sdpType: peer.localDescription?.type || 'unknown',
                iceRestart: true,
              }));
            }, callMeta({ iceRestart: true })).catch(() => {
              // runStep already logged the error with timing/correlation metadata.
            });
          }
        });

        manager.on('reconnect_failed', () => {
          logError('[signaling] reconnect failed', callMeta());
          leaveRoom('Reconnection failed');
        });
      }

      const onTransportUpgrade = socket.io?.engine?.on;
      if (typeof onTransportUpgrade === 'function') {
        onTransportUpgrade.call(socket.io.engine, 'upgrade', (transport) => {
          logInfo('[signaling] transport upgrade', callMeta({ transport: transport?.name || 'unknown' }));
        });
      } else {
        logWarn('[signaling] transport listener unavailable', callMeta());
      }

      socket.on('room-full', () => {
        logWarn('[signaling] recv room-full', callMeta({ direction: 'recv' }));
        leaveRoom(`Room "${roomIdRef.current}" is full`);
      });

      socket.on('peer-joined', async () => {
        logInfo('[signaling] recv peer-joined', callMeta({ direction: 'recv' }));
        isOffererRef.current = true;
        try {
          const peer = ensurePeerConnection();
          const offer = await runStep('[webrtc] createOffer', () => peer.createOffer(), callMeta());
          await runStep('[webrtc] setLocalDescription (offer)', () => peer.setLocalDescription(offer), callMeta({ sdpType: offer?.type || 'unknown' }));
          socket.emit('offer', { roomId: roomIdRef.current, sdp: offer });
          logInfo('[signaling] send offer', callMeta({ direction: 'send', sdpType: offer?.type || 'unknown' }));
          setStatus('Offer sent');
        } catch (error) {
          logError('[webrtc] Failed to create/send offer', callMeta({ name: error?.name, message: error?.message }));
          setStatus('Failed to create offer');
        }
      });

      socket.on('offer', async ({ sdp } = {}) => {
        if (!sdp) {
          logWarn('[signaling] recv offer without SDP', callMeta({ direction: 'recv' }));
          return;
        }
        logInfo('[signaling] recv offer', callMeta({
          direction: 'recv',
          sdpType: sdp.type || 'unknown',
          sdpLength: sdp.sdp?.length,
        }));
        try {
          const peer = ensurePeerConnection();
          await runStep('[webrtc] setRemoteDescription (offer)', () => peer.setRemoteDescription(new RTCSessionDescription(sdp)), callMeta({ sdpType: sdp.type || 'unknown' }));
          const answer = await runStep('[webrtc] createAnswer', () => peer.createAnswer(), callMeta());
          await runStep('[webrtc] setLocalDescription (answer)', () => peer.setLocalDescription(answer), callMeta({ sdpType: answer?.type || 'unknown' }));
          socket.emit('answer', { roomId: roomIdRef.current, sdp: answer });
          logInfo('[signaling] send answer', callMeta({ direction: 'send', sdpType: answer?.type || 'unknown' }));
          setStatus('Answer sent');
        } catch (error) {
          logError('[webrtc] Failed to process offer/create answer', callMeta({ name: error?.name, message: error?.message }));
          setStatus('Failed to process offer');
        }
      });

      socket.on('answer', async ({ sdp } = {}) => {
        if (!sdp) {
          logWarn('[signaling] recv answer without SDP', callMeta({ direction: 'recv' }));
          return;
        }
        logInfo('[signaling] recv answer', callMeta({
          direction: 'recv',
          sdpType: sdp.type || 'unknown',
          sdpLength: sdp.sdp?.length,
        }));
        try {
          const peer = ensurePeerConnection();
          await runStep('[webrtc] setRemoteDescription (answer)', () => peer.setRemoteDescription(new RTCSessionDescription(sdp)), callMeta({ sdpType: sdp.type || 'unknown' }));
          markCallConnected();
          setStatus('Call connected');
        } catch (error) {
          logError('[webrtc] Failed to apply remote answer', callMeta({ name: error?.name, message: error?.message }));
          setStatus('Failed to apply answer');
        }
      });

      socket.on('ice-candidate', async ({ candidate } = {}) => {
        if (!candidate) {
          return;
        }
        const summary = summarizeIceCandidate(candidate);
        logDebug('[signaling] recv ice-candidate', callMeta({ direction: 'recv', ...summary }));
        try {
          const peer = ensurePeerConnection();
          await peer.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
          logError('[ice] Failed to add ICE candidate', callMeta({ name: error?.name, message: error?.message, summary }));
        }
      });

      socket.on('peer-left', () => {
        logInfo('[signaling] recv peer-left', callMeta({ direction: 'recv' }));
        closePeerConnection();
        setStatus('Peer left room');
      });

      socket.on('disconnect', (reason) => {
        logWarn('[signaling] disconnect', callMeta({ reason }));
        if (isRecoverableDisconnectReason(reason)) {
          setIsReconnecting(true);
          setStatus('Reconnecting…');
          return;
        }
        setIsInRoom(false);
        setIsReconnecting(false);
        closePeerConnection();
        setStatus('Socket disconnected');
      });

      socket.on('connect_error', (error) => {
        const metadata = callMeta({
          message: error?.message,
          description: error?.description,
          context: error?.context,
          cause: error?.cause,
        });
        logError('[signaling] connect_error', metadata);
        if (isInRoomRef.current) {
          // A call is already in progress; let the reconnection policy retry
          // instead of tearing the call down on a transient error.
          setIsReconnecting(true);
          setStatus('Reconnecting…');
          return;
        }
        setIsInRoom(false);
        setStatus(`Unable to connect: ${error?.message || 'Unknown error'}`);
      });
    } catch (error) {
      logError('[lifecycle] joinRoom failed during media/signaling setup', callMeta({
        name: error?.name,
        message: error?.message,
        category: classifyMediaError(error),
      }));
      setStatus('Failed to access camera/microphone');
    }
  }, [callMeta, closePeerConnection, ensurePeerConnection, leaveRoom, markCallConnected, roomId, settings.speakerEnabledByDefault, signalingUrl, startLocalPreview]);

  useEffect(() => () => {
    logInfo('[lifecycle] App cleanup/unmount');
    stopLightingMonitor();
    leaveRoom();
    if (localStreamRef.current) {
      logInfo('[teardown] Stopping local media tracks on unmount');
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
    if (!callConnectedAt) {
      setElapsedCallSeconds(0);
      return undefined;
    }

    const updateElapsedCallSeconds = () => {
      setElapsedCallSeconds(Math.floor((Date.now() - callConnectedAt) / 1000));
    };

    updateElapsedCallSeconds();
    const timerId = setInterval(() => {
      updateElapsedCallSeconds();
    }, 1000);
    return () => clearInterval(timerId);
  }, [callConnectedAt]);

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
        let bytesReceivedDelta;
        if (
          previous.timestampMs &&
          now > previous.timestampMs &&
          totalBytesReceived >= previous.totalBytesReceived
        ) {
          bytesReceivedDelta = totalBytesReceived - previous.totalBytesReceived;
          const bitsReceived = bytesReceivedDelta * 8;
          const elapsedMs = now - previous.timestampMs;
          bitrateKbps = bitsReceived / elapsedMs;
        }
        connectionStatsRef.current = { timestampMs: now, totalBytesReceived };

        const denominator = totalPacketsReceived + totalPacketsLost;
        const packetLossRatio = denominator > 0 ? totalPacketsLost / denominator : undefined;
        setConnectionQuality(getConnectionQuality({ rttMs, packetLossRatio, bitrateKbps }));

        // Inspect the selected (active) candidate pair so the exported logs make
        // it obvious whether media is going direct (host/srflx) or via TURN (relay).
        const selectedPair = summarizeSelectedCandidatePair(report);
        if (selectedPair) {
          logInfo('[ice] selected pair', callMeta(selectedPair));
          if (!relaySummaryLoggedRef.current) {
            relaySummaryLoggedRef.current = true;
            logInfo('[ice] connection established', callMeta({
              local: selectedPair.local,
              remote: selectedPair.remote,
              protocol: selectedPair.protocol,
              usesRelay: selectedPair.usesRelay,
            }));
          }
        }

        // Per-tick media-flow stats stay at debug so they can be enabled when
        // needed without overwhelming the default (info) log.
        logDebug('[stats] media flow', callMeta({
          rttMs,
          packetLossRatio,
          bitrateKbps,
          totalBytesReceived,
          bytesReceivedDelta,
        }));
      } catch (error) {
        logWarn('[stats] Failed to read connection stats', callMeta({ message: error?.message }));
      }
    };

    pollStats();
    const intervalId = setInterval(pollStats, STATS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [callMeta, isInRoom]);

  // Start/stop the in-call audio session when entering or leaving a call.
  // Splitting this from the route-update effect below prevents unnecessary
  // InCallManager stop/start cycles when only the speaker preference changes.
  useEffect(() => {
    if (!isInRoom) {
      return undefined;
    }

    try {
      startAudioSession();
      logInfo('[audio] InCallManager session started');
    } catch (error) {
      logWarn('[audio] InCallManager start failed', { message: error?.message });
    }

    return () => {
      try {
        stopAudioSession();
        logInfo('[audio] InCallManager session stopped');
      } catch (error) {
        logWarn('[audio] InCallManager stop failed', { message: error?.message });
      }
    };
  }, [isInRoom]);

  // Update the audio output route whenever the speaker preference changes while
  // a call is active.  Runs immediately when the call starts (isInRoom flips to
  // true) to apply the initial route, and again on every subsequent toggle.
  useEffect(() => {
    if (!isInRoom) {
      return;
    }

    try {
      setAudioRoute(isSpeakerEnabled);
      logInfo('[audio] Audio route updated', { speakerEnabled: isSpeakerEnabled });
    } catch (error) {
      logWarn('[audio] InCallManager route update failed', { message: error?.message });
    }
  }, [isInRoom, isSpeakerEnabled]);

  useEffect(() => {
    const bounds = getPipBounds();
    const clampedX = clamp(pipPosition.x, bounds.minX, bounds.maxX);
    const clampedY = clamp(pipPosition.y, bounds.minY, bounds.maxY);
    if (clampedX !== pipPosition.x || clampedY !== pipPosition.y) {
      setPipPosition({ x: clampedX, y: clampedY });
      return;
    }
    pipX.value = clampedX;
    pipY.value = clampedY;
  }, [getPipBounds, pipPosition.x, pipPosition.y, pipX, pipY]);

  const handleSwapStreams = useCallback(() => {
    if (!remoteStream || !localStream) {
      return;
    }
    setIsLocalPrimary((previous) => !previous);
  }, [localStream, remoteStream]);

  const handleRetryReconnect = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) {
      setStatus('No active socket to reconnect');
      return;
    }
    logInfo('[signaling] Manual reconnect requested', callMeta());
    setIsReconnecting(true);
    setStatus('Reconnecting…');
    socket.disconnect();
    socket.connect();
  }, [callMeta]);

  const handleSpeakerToggle = useCallback(() => {
    const nextSpeakerEnabled = !isSpeakerEnabled;
    logInfo('[audio] Speaker toggle action', { nextSpeakerEnabled });
    setIsSpeakerEnabled(nextSpeakerEnabled);
    setStatus(nextSpeakerEnabled ? 'Speaker enabled' : 'Speaker disabled');
  }, [isSpeakerEnabled]);

  const handleCameraSwitch = useCallback(() => {
    const [videoTrack] = localStreamRef.current?.getVideoTracks?.() || [];
    const switchCamera = videoTrack?._switchCamera;
    if (typeof switchCamera !== 'function') {
      logWarn('[media] Camera switch unavailable');
      setStatus('Camera switch unavailable');
      return;
    }

    try {
      switchCamera.call(videoTrack);
      logInfo('[media] Camera switched');
      setStatus('Camera switched');
    } catch (error) {
      logError('[media] Camera switch failed', { name: error?.name, message: error?.message });
      setStatus('Camera switch failed');
    }
  }, []);

  const handleCallStageLayout = useCallback((event) => {
    const { width, height } = event.nativeEvent.layout;
    setStageSize({ width, height });
  }, []);

  const animatedPipStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pipX.value }, { translateY: pipY.value }],
  }));
  const pipBounds = getPipBounds();

  const pipGesture = Gesture.Race(
    Gesture.Tap().onEnd(() => {
      runOnJS(handleSwapStreams)();
    }),
    Gesture.Pan()
      .onStart(() => {
        pipStartX.value = pipX.value;
        pipStartY.value = pipY.value;
      })
      .onUpdate((event) => {
        pipX.value = clamp(pipStartX.value + event.translationX, pipBounds.minX, pipBounds.maxX);
        pipY.value = clamp(pipStartY.value + event.translationY, pipBounds.minY, pipBounds.maxY);
      })
      .onEnd(() => {
        runOnJS(setPipPosition)({ x: pipX.value, y: pipY.value });
      }),
  );

  const handleRoomButtonPress = () => {
    if (isInRoom) {
      logInfo('[lifecycle] Leave Room button press', callMeta());
      leaveRoom('Disconnected');
      return;
    }

    joinRoom().catch((error) => {
      logError('[lifecycle] joinRoom unhandled rejection', { name: error?.name, message: error?.message });
      setStatus('Failed to start call');
    });
  };

  const handleAutoLightingToggle = useCallback(() => {
    const nextValue = !settings.autoCameraLightingEnabled;
    logInfo('[settings] Auto camera lighting toggle', { enabled: nextValue });
    setSettings((previous) => ({ ...previous, autoCameraLightingEnabled: nextValue }));
    setStatus(nextValue ? 'Auto camera lighting enabled' : 'Auto camera lighting disabled');
  }, [settings.autoCameraLightingEnabled]);

  const handleSpeakerDefaultToggle = useCallback(() => {
    const nextValue = !settings.speakerEnabledByDefault;
    logInfo('[settings] Speaker default toggle', { enabled: nextValue });
    setSettings((previous) => ({ ...previous, speakerEnabledByDefault: nextValue }));
    if (!isInRoom) {
      setIsSpeakerEnabled(nextValue);
    }
    setStatus(nextValue ? 'Speaker default enabled' : 'Speaker default disabled');
  }, [isInRoom, settings.speakerEnabledByDefault]);

  const handleExportLogs = useCallback(async () => {
    try {
      logInfo('[lifecycle] Export Logs button press');
      const header = buildExportHeader({
        signalingUrl: signalingUrl.trim(),
        roomId: roomId.trim(),
        status,
        localStream,
        remoteStream,
        isInRoom,
        socket: socketRef.current,
        peerConnection: peerConnectionRef.current,
        callId: callIdRef.current,
      });
      const content = `${header}\n${getLogsAsText()}\n`;
      const result = await writeLogsFile(content);

      if (result.success) {
        const statusMessage = result.usedFallback
          ? `Logs saved to fallback (${result.label}): ${result.path}`
          : `Logs saved: ${result.path}`;
        logInfo('[lifecycle] Logs exported', {
          path: result.path,
          storage: result.label,
          usedFallback: result.usedFallback,
        });
        setStatus(statusMessage);
      } else {
        logError('[lifecycle] Failed to export logs', result.error);
        setStatus(`Failed to export logs: ${result.error?.message || 'Unknown error'}`);
      }
    } catch (error) {
      logError('[lifecycle] Unexpected export logs failure', error);
      setStatus(`Failed to export logs: ${error?.message || 'Unknown error'}`);
    }
  }, [isInRoom, localStream, remoteStream, roomId, signalingUrl, status]);

  const handleMuteToggle = useCallback(() => {
    const nextMuted = !isMuted;
    logInfo('[media] Mute toggle action', { nextMuted });
    if (!setTrackEnabled(localStreamRef.current, 'audio', !nextMuted)) {
      setStatus('Start preview to control audio');
      return;
    }

    setIsMuted(nextMuted);
    setStatus(nextMuted ? 'Muted microphone' : 'Unmuted microphone');
  }, [isMuted]);

  const handleVideoToggle = useCallback(() => {
    const nextVideoEnabled = !isVideoEnabled;
    logInfo('[media] Video toggle action', { nextVideoEnabled });
    if (!setTrackEnabled(localStreamRef.current, 'video', nextVideoEnabled)) {
      setStatus('Start preview to control video');
      return;
    }

    setIsVideoEnabled(nextVideoEnabled);
    setStatus(nextVideoEnabled ? 'Camera enabled' : 'Camera disabled');
  }, [isVideoEnabled]);

  const mainStream = isLocalPrimary ? localStream : remoteStream;
  const pipStream = isLocalPrimary ? remoteStream : localStream;

  return (
    <GestureHandlerRootView style={styles.container}>
      <SafeAreaView style={styles.container}>
        {isInRoom ? (
          <View style={styles.callScreen}>
            <View style={styles.topBar}>
              <Text style={styles.timerText}>{formatCallDuration(elapsedCallSeconds)}</Text>
              <View style={styles.qualityContainer}>
                <Text style={styles.qualityLabel}>{connectionQuality.label}</Text>
                <View style={styles.signalBars}>
                  {[0, 1, 2].map((barIndex) => (
                    <View
                      key={barIndex}
                      style={[
                        styles.signalBar,
                        styles[`signalBar${barIndex}`],
                        barIndex <= connectionQuality.bars - 1 && styles.signalBarActive,
                      ]}
                    />
                  ))}
                </View>
              </View>
            </View>

            {isReconnecting ? (
              <View style={styles.reconnectBanner}>
                <Text style={styles.reconnectBannerText}>Reconnecting… keeping your call alive</Text>
                <Pressable onPress={handleRetryReconnect} style={styles.retryButton}>
                  <Text style={styles.retryButtonText}>Retry</Text>
                </Pressable>
              </View>
            ) : null}

            <View style={styles.callStage} onLayout={handleCallStageLayout}>
              <View style={[styles.cozyBlob, styles.cozyBlobTop]} />
              <View style={[styles.cozyBlob, styles.cozyBlobBottom]} />
              {mainStream ? (
                <RTCView style={styles.remoteStream} streamURL={mainStream.toURL()} objectFit="cover" />
              ) : (
                <View style={styles.remotePlaceholder}>
                  <Text style={styles.remotePlaceholderText}>Waiting for someone to join…</Text>
                </View>
              )}

              {pipStream ? (
                <GestureDetector gesture={pipGesture}>
                  <Animated.View style={[styles.localPip, animatedPipStyle]}>
                    <RTCView
                      style={styles.localPipStream}
                      streamURL={pipStream.toURL()}
                      objectFit="cover"
                      mirror={!isLocalPrimary}
                    />
                  </Animated.View>
                </GestureDetector>
              ) : null}
            </View>

            <View style={styles.controlsRow}>
              <Pressable
                onPress={handleMuteToggle}
                style={({ pressed }) => [
                  styles.controlButton,
                  isMuted && styles.controlButtonActive,
                  !localStream && styles.controlButtonDisabled,
                  pressed && styles.controlButtonPressed,
                ]}
              >
                <Text style={styles.controlButtonText}>{isMuted ? 'Unmute' : 'Mute'}</Text>
              </Pressable>
              <Pressable
                onPress={handleVideoToggle}
                style={({ pressed }) => [
                  styles.controlButton,
                  !isVideoEnabled && styles.controlButtonActive,
                  !localStream && styles.controlButtonDisabled,
                  pressed && styles.controlButtonPressed,
                ]}
              >
                <Text style={styles.controlButtonText}>{isVideoEnabled ? 'Video Off' : 'Video On'}</Text>
              </Pressable>
              <Pressable
                onPress={handleSpeakerToggle}
                style={({ pressed }) => [
                  styles.controlButton,
                  isSpeakerEnabled && styles.controlButtonActive,
                  pressed && styles.controlButtonPressed,
                ]}
              >
                <Text style={styles.controlButtonText}>{isSpeakerEnabled ? 'Speaker' : 'Earpiece'}</Text>
              </Pressable>
            </View>

            <View style={styles.controlsRow}>
              <Pressable
                onPress={handleCameraSwitch}
                style={({ pressed }) => [
                  styles.controlButton,
                  !localStream && styles.controlButtonDisabled,
                  pressed && styles.controlButtonPressed,
                ]}
              >
                <Text style={styles.controlButtonText}>Swap Camera</Text>
              </Pressable>
              <Pressable
                onPress={handleRoomButtonPress}
                style={({ pressed }) => [styles.controlButton, styles.leaveButton, pressed && styles.controlButtonPressed]}
              >
                <Text style={styles.controlButtonText}>Leave</Text>
              </Pressable>
            </View>
            <Text style={styles.status}>{status}</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>studious-robot</Text>
            <Text style={styles.subtitle}>Phase 4 — Warm & cozy in-call interface</Text>

            <TextInput
              value={signalingUrl}
              onChangeText={setSignalingUrl}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              placeholder="Signaling URL"
            />
            <TextInput
              value={roomId}
              onChangeText={setRoomId}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              placeholder="Room ID"
            />

            <View style={styles.row}>
              <Button
                title="Start Preview"
                onPress={() => {
                  logInfo('Start Preview button press');
                  startLocalPreview().catch((error) => {
                    logError('startLocalPreview failed (permissions/device)', error);
                    setStatus('Failed to access camera/microphone');
                  });
                }}
              />
              <Button title="Join Room" onPress={handleRoomButtonPress} />
            </View>

            <View style={styles.row}>
              <Button
                title={isSettingsVisible ? 'Hide Settings' : 'Settings'}
                onPress={() => setIsSettingsVisible((previous) => !previous)}
              />
              <Button title="Export Logs" onPress={handleExportLogs} />
            </View>

            {isSettingsVisible ? (
              <View style={styles.settingsCard}>
                <Text style={styles.settingsTitle}>Settings</Text>
                <Pressable
                  onPress={handleAutoLightingToggle}
                  style={({ pressed }) => [
                    styles.settingsOption,
                    pressed && styles.settingsOptionPressed,
                  ]}
                >
                  <View>
                    <Text style={styles.settingsOptionLabel}>Auto camera lighting</Text>
                    <Text style={styles.settingsOptionHint}>Automatically adjusts camera for lighting conditions</Text>
                  </View>
                  <Text style={styles.settingsOptionValue}>
                    {settings.autoCameraLightingEnabled ? 'On' : 'Off'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={handleSpeakerDefaultToggle}
                  style={({ pressed }) => [
                    styles.settingsOption,
                    pressed && styles.settingsOptionPressed,
                  ]}
                >
                  <View>
                    <Text style={styles.settingsOptionLabel}>Speaker on join</Text>
                    <Text style={styles.settingsOptionHint}>Default audio route for new calls</Text>
                  </View>
                  <Text style={styles.settingsOptionValue}>
                    {settings.speakerEnabledByDefault ? 'On' : 'Off'}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            <Text style={styles.status}>{status}</Text>
          </ScrollView>
        )}
        <StatusBar barStyle="light-content" />
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#2d2329',
  },
  content: {
    padding: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '600',
    color: '#fff5e8',
  },
  input: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#6d5057',
    backgroundColor: '#45313a',
    color: '#fff5e8',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#dec8b5',
    marginBottom: 16,
  },
  status: {
    color: '#f1ddcb',
    marginBottom: 12,
  },
  settingsCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#6d5057',
    backgroundColor: '#3d2d35',
    padding: 10,
    marginBottom: 12,
    gap: 8,
  },
  settingsTitle: {
    color: '#fff5e8',
    fontSize: 16,
    fontWeight: '700',
  },
  settingsOption: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#6d5057',
    backgroundColor: '#4b3741',
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  settingsOptionPressed: {
    opacity: 0.85,
  },
  settingsOptionLabel: {
    color: '#fff5e8',
    fontWeight: '600',
  },
  settingsOptionHint: {
    color: '#dec8b5',
    fontSize: 12,
  },
  settingsOptionValue: {
    color: '#ffd4a3',
    fontWeight: '700',
    minWidth: 28,
    textAlign: 'right',
  },
  callScreen: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
  },
  topBar: {
    minHeight: 40,
    borderRadius: 999,
    paddingHorizontal: 12,
    marginBottom: 8,
    backgroundColor: '#4b3741',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  timerText: {
    color: '#fff5e8',
    fontWeight: '700',
  },
  qualityContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  qualityLabel: {
    color: '#dec8b5',
    fontSize: 12,
  },
  signalBars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
  },
  signalBar: {
    width: 6,
    borderRadius: 4,
    backgroundColor: '#78606b',
  },
  signalBar0: {
    height: 8,
  },
  signalBar1: {
    height: 12,
  },
  signalBar2: {
    height: 16,
  },
  signalBarActive: {
    backgroundColor: '#8be7a5',
  },
  reconnectBanner: {
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ffd9a8',
    backgroundColor: '#5a434d',
    paddingVertical: 8,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  reconnectBannerText: {
    flex: 1,
    color: '#ffd9a8',
    fontWeight: '600',
  },
  retryButton: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#ffd4a3',
  },
  retryButtonText: {
    color: '#3a2127',
    fontWeight: '700',
    fontSize: 12,
  },
  callStage: {
    flex: 1,
    minHeight: 280,
    borderRadius: 18,
    overflow: 'hidden',
    marginBottom: 12,
    backgroundColor: '#3a2c34',
    borderWidth: 1,
    borderColor: '#7d5962',
  },
  cozyBlob: {
    position: 'absolute',
    width: 170,
    height: 170,
    borderRadius: 85,
    backgroundColor: '#f9d2a8',
    opacity: 0.14,
  },
  cozyBlobTop: {
    top: -70,
    left: -45,
  },
  cozyBlobBottom: {
    bottom: -90,
    right: -45,
  },
  remoteStream: {
    flex: 1,
    backgroundColor: '#201a1e',
  },
  remotePlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2e242a',
  },
  remotePlaceholderText: {
    color: '#f1ddcb',
    fontSize: 16,
  },
  localPip: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: PIP_WIDTH,
    height: PIP_HEIGHT,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#ffd4a3',
    backgroundColor: '#1f171c',
  },
  localPipStream: {
    flex: 1,
  },
  controlsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  controlButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f3cfa9',
  },
  controlButtonActive: {
    backgroundColor: '#f08d89',
  },
  controlButtonDisabled: {
    opacity: 0.55,
  },
  controlButtonPressed: {
    opacity: 0.88,
  },
  controlButtonText: {
    color: '#3a2127',
    fontWeight: '700',
  },
  leaveButton: {
    backgroundColor: '#f08d89',
  },
});
