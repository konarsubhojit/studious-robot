import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
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
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
} from 'react-native-webrtc';
import appConfig from './app.json';
import { clearLogs, getLogsAsText, logDebug, logError, logInfo, logWarn } from './src/appLogger';
import {
  enterPictureInPicture,
  startCallService,
  stopCallService,
} from './src/callService';
import { applyLightingAdjustment } from './src/cameraLighting';
import { isTrackEnabled, setTrackEnabled } from './src/mediaControls';
import { getSocketOptions, isRecoverableDisconnectReason } from './src/socketConfig';
import { getIceServers } from './src/webrtcConfig';

const DEFAULT_SIGNALING_URL = process.env.SIGNALING_URL || 'http://localhost:4173';
const DEFAULT_ROOM_ID = process.env.ROOM_ID || 'room-1';

// How often to re-evaluate ambient lighting and auto-adjust the camera.
const LIGHTING_ADJUST_INTERVAL_MS = 8000;

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
}) {
  const lines = [
    'studious-robot diagnostic logs',
    `exportedAt: ${new Date().toISOString()}`,
    `appName: ${appConfig?.displayName || appConfig?.name || 'unknown'}`,
    `applicationId: ${getApplicationId()}`,
    `platform: ${Platform.OS}`,
    `osVersion: ${Platform.Version}`,
    `reactNativeVersion: ${getReactNativeVersion()}`,
    `signalingUrl: ${sanitizeUrlForLog(signalingUrl)}`,
    `roomId: ${roomId || ''}`,
    `appStatus: ${status || ''}`,
    `hasLocalStream: ${Boolean(localStream)}`,
    `hasRemoteStream: ${Boolean(remoteStream)}`,
    `isInRoom: ${Boolean(isInRoom)}`,
    `socketConnected: ${Boolean(socket?.connected)}`,
    `socketId: ${socket?.id || 'none'}`,
    `socketTransport: ${getSocketTransportName(socket)}`,
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

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const roomIdRef = useRef(roomId);
  const isInRoomRef = useRef(false);
  const lightingIntervalRef = useRef(null);

  useEffect(() => {
    isInRoomRef.current = isInRoom;
  }, [isInRoom]);

  useEffect(() => {
    clearLogs();
    logInfo('App mounted', {
      defaultSignalingUrl: sanitizeUrlForLog(DEFAULT_SIGNALING_URL),
      defaultRoomId: DEFAULT_ROOM_ID,
      platform: Platform.OS,
    });
  }, []);

  useEffect(() => {
    roomIdRef.current = roomId.trim();
  }, [roomId]);

  const closePeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      logInfo('Closing RTCPeerConnection');
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    setRemoteStream(null);
  }, []);

  const leaveRoom = useCallback((nextStatus = 'Disconnected') => {
    logInfo('Leaving room', {
      nextStatus,
      hadSocket: Boolean(socketRef.current),
      hadPeerConnection: Boolean(peerConnectionRef.current),
    });
    setIsInRoom(false);
    setIsReconnecting(false);
    stopCallService();
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    closePeerConnection();
    setStatus(nextStatus);
  }, [closePeerConnection]);

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
        setStatus('Remote stream connected');
      }
    };

    peerConnectionRef.current = connection;
    return connection;
  }, []);

  const syncMediaState = useCallback((stream) => {
    setIsMuted(!isTrackEnabled(stream, 'audio'));
    setIsVideoEnabled(isTrackEnabled(stream, 'video'));
  }, []);

  const adjustCameraLighting = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream?.getVideoTracks) {
      return;
    }
    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) {
      return;
    }
    await applyLightingAdjustment(videoTrack);
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
    adjustCameraLighting();
    lightingIntervalRef.current = setInterval(() => {
      adjustCameraLighting();
    }, LIGHTING_ADJUST_INTERVAL_MS);
  }, [adjustCameraLighting, stopLightingMonitor]);

  const startLocalPreview = useCallback(async () => {
    if (localStreamRef.current) {
      logInfo('Local media stream already available');
      syncMediaState(localStreamRef.current);
      startLightingMonitor();
      return localStreamRef.current;
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
    startLightingMonitor();
    setStatus('Local preview ready');
    return stream;
  }, [startLightingMonitor, syncMediaState]);

  const joinRoom = useCallback(async () => {
    try {
      const trimmedSignalingUrl = signalingUrl.trim();
      const trimmedRoomId = roomId.trim();
      logInfo('Join Room button press', {
        signalingUrl: sanitizeUrlForLog(trimmedSignalingUrl),
        roomId: trimmedRoomId,
      });

      if (!trimmedSignalingUrl || !trimmedRoomId) {
        setStatus('Signaling URL and room ID are required');
        return;
      }

      leaveRoom();
      await startLocalPreview();
      setStatus('Connecting to signaling server...');

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
        setStatus('Connected to signaling. Joining room...');
        setIsInRoom(true);
        setIsReconnecting(false);
        socket.emit('join-room', roomIdRef.current);
        startCallService();
      });

      const manager = socket.io;
      if (manager && typeof manager.on === 'function') {
        manager.on('reconnect_attempt', (attempt) => {
          logWarn('Socket.IO reconnect attempt', { attempt });
          setIsReconnecting(true);
          setStatus('Reconnecting…');
        });

        manager.on('reconnect', (attempt) => {
          logInfo('Socket.IO reconnected', { attempt });
          setIsReconnecting(false);
          setStatus('Reconnected. Rejoining room...');
          socket.emit('join-room', roomIdRef.current);
        });

        manager.on('reconnect_failed', () => {
          logError('Socket.IO reconnect failed');
          leaveRoom('Reconnection failed');
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
        leaveRoom(`Room "${roomIdRef.current}" is full`);
      });

      socket.on('peer-joined', async () => {
        logInfo('peer-joined', { roomId: roomIdRef.current });
        try {
          const peer = ensurePeerConnection();
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          socket.emit('offer', { roomId: roomIdRef.current, sdp: offer });
          logInfo('Offer created and sent', { sdpType: offer?.type || 'unknown' });
          setStatus('Offer sent');
        } catch (error) {
          logError('Failed to create/send offer', error);
          setStatus('Failed to create offer');
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
          setStatus('Answer sent');
        } catch (error) {
          logError('Failed to process offer/create answer', error);
          setStatus('Failed to process offer');
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
          setStatus('Call connected');
        } catch (error) {
          logError('Failed to apply remote answer', error);
          setStatus('Failed to apply answer');
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
        setStatus('Socket disconnected');
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
        setStatus(`Unable to connect: ${error?.message || 'Unknown error'}`);
      });
    } catch (error) {
      logError('joinRoom failed during media/signaling setup', error);
      setStatus('Failed to access camera/microphone');
    }
  }, [closePeerConnection, ensurePeerConnection, leaveRoom, roomId, signalingUrl, startLocalPreview]);

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
    if (Platform.OS !== 'android') {
      return undefined;
    }

    const subscription = AppState.addEventListener('change', (nextState) => {
      if ((nextState === 'background' || nextState === 'inactive') && isInRoomRef.current) {
        logInfo('App backgrounded during call; requesting Picture-in-Picture', { nextState });
        enterPictureInPicture();
      }
    });

    return () => subscription.remove();
  }, []);

  const handleRoomButtonPress = () => {
    if (isInRoom) {
      logInfo('Leave Room button press');
      leaveRoom('Disconnected');
      return;
    }

    joinRoom();
  };

  const handleExportLogs = useCallback(async () => {
    try {
      logInfo('Export Logs button press');
      const header = buildExportHeader({
        signalingUrl: signalingUrl.trim(),
        roomId: roomId.trim(),
        status,
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
        setStatus(statusMessage);
      } else {
        logError('Failed to export logs', result.error);
        setStatus(`Failed to export logs: ${result.error?.message || 'Unknown error'}`);
      }
    } catch (error) {
      logError('Unexpected export logs failure', error);
      setStatus(`Failed to export logs: ${error?.message || 'Unknown error'}`);
    }
  }, [isInRoom, localStream, remoteStream, roomId, signalingUrl, status]);

  const handleMuteToggle = useCallback(() => {
    const nextMuted = !isMuted;
    logInfo('Mute toggle action', { nextMuted });
    if (!setTrackEnabled(localStreamRef.current, 'audio', !nextMuted)) {
      setStatus('Start preview to control audio');
      return;
    }

    setIsMuted(nextMuted);
    setStatus(nextMuted ? 'Muted microphone' : 'Unmuted microphone');
  }, [isMuted]);

  const handleVideoToggle = useCallback(() => {
    const nextVideoEnabled = !isVideoEnabled;
    logInfo('Video toggle action', { nextVideoEnabled });
    if (!setTrackEnabled(localStreamRef.current, 'video', nextVideoEnabled)) {
      setStatus('Start preview to control video');
      return;
    }

    setIsVideoEnabled(nextVideoEnabled);
    setStatus(nextVideoEnabled ? 'Camera enabled' : 'Camera disabled');
  }, [isVideoEnabled]);

  return (
    <SafeAreaView style={styles.container}>
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
          <Button title={isInRoom ? 'Leave Room' : 'Join Room'} onPress={handleRoomButtonPress} />
        </View>

        <View style={styles.row}>
          <Button title="Export Logs" onPress={handleExportLogs} />
        </View>

        <Text style={styles.status}>{status}</Text>
        {isReconnecting ? (
          <Text style={styles.reconnecting}>Reconnecting… keeping your call alive</Text>
        ) : null}

        <Text style={styles.streamLabel}>In call</Text>
        <View style={styles.callStage}>
          <View style={[styles.cozyBlob, styles.cozyBlobTop]} />
          <View style={[styles.cozyBlob, styles.cozyBlobBottom]} />
          {remoteStream ? (
            <RTCView style={styles.remoteStream} streamURL={remoteStream.toURL()} objectFit="cover" />
          ) : (
            <View style={styles.remotePlaceholder}>
              <Text style={styles.remotePlaceholderText}>Waiting for someone to join…</Text>
            </View>
          )}
          {localStream ? (
            <View style={styles.localPip}>
              <RTCView style={styles.localPipStream} streamURL={localStream.toURL()} objectFit="cover" mirror />
            </View>
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
        </View>
      </ScrollView>
      <StatusBar barStyle="light-content" />
    </SafeAreaView>
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
  reconnecting: {
    color: '#ffd9a8',
    fontWeight: '600',
    marginBottom: 12,
  },
  streamLabel: {
    color: '#f1ddcb',
    fontWeight: '600',
    marginBottom: 8,
  },
  callStage: {
    height: 320,
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
    right: 12,
    bottom: 12,
    width: 110,
    height: 155,
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
    gap: 12,
    marginBottom: 12,
  },
  controlButton: {
    flex: 1,
    minHeight: 48,
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
});
