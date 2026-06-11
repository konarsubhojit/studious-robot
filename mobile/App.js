import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { io } from 'socket.io-client';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
} from 'react-native-webrtc';
import { isTrackEnabled, setTrackEnabled } from './src/mediaControls';
import { getIceServers } from './src/webrtcConfig';

const DEFAULT_SIGNALING_URL = process.env.SIGNALING_URL || 'http://localhost:4173';
const DEFAULT_ROOM_ID = process.env.ROOM_ID || 'room-1';

export default function App() {
  const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);
  const [roomId, setRoomId] = useState(DEFAULT_ROOM_ID);
  const [status, setStatus] = useState('Ready');
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isInRoom, setIsInRoom] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const roomIdRef = useRef(roomId);

  useEffect(() => {
    roomIdRef.current = roomId.trim();
  }, [roomId]);

  const closePeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    setRemoteStream(null);
  }, []);

  const leaveRoom = useCallback((nextStatus = 'Disconnected') => {
    setIsInRoom(false);
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

    const connection = new RTCPeerConnection({ iceServers: getIceServers() });
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        connection.addTrack(track, localStreamRef.current);
      });
    }

    connection.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('ice-candidate', {
          roomId: roomIdRef.current,
          candidate: event.candidate,
        });
      }
    };

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
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

  const startLocalPreview = useCallback(async () => {
    if (localStreamRef.current) {
      syncMediaState(localStreamRef.current);
      return localStreamRef.current;
    }

    const stream = await mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: 'user',
      },
    });
    localStreamRef.current = stream;
    setLocalStream(stream);
    syncMediaState(stream);
    setStatus('Local preview ready');
    return stream;
  }, [syncMediaState]);

  const joinRoom = useCallback(async () => {
    try {
      if (!signalingUrl.trim() || !roomId.trim()) {
        setStatus('Signaling URL and room ID are required');
        return;
      }

      leaveRoom();
      await startLocalPreview();
      setStatus('Connecting to signaling server...');

      const socket = io(signalingUrl.trim(), { transports: ['websocket'] });
      socketRef.current = socket;

      socket.on('connect', () => {
        setStatus('Connected to signaling. Joining room...');
        setIsInRoom(true);
        socket.emit('join-room', roomIdRef.current);
      });

      socket.on('room-full', () => {
        leaveRoom(`Room "${roomIdRef.current}" is full`);
      });

      socket.on('peer-joined', async () => {
        const peer = ensurePeerConnection();
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit('offer', { roomId: roomIdRef.current, sdp: offer });
        setStatus('Offer sent');
      });

      socket.on('offer', async ({ sdp } = {}) => {
        if (!sdp) return;
        const peer = ensurePeerConnection();
        await peer.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('answer', { roomId: roomIdRef.current, sdp: answer });
        setStatus('Answer sent');
      });

      socket.on('answer', async ({ sdp } = {}) => {
        if (!sdp) return;
        const peer = ensurePeerConnection();
        await peer.setRemoteDescription(new RTCSessionDescription(sdp));
        setStatus('Call connected');
      });

      socket.on('ice-candidate', async ({ candidate } = {}) => {
        if (!candidate) return;
        const peer = ensurePeerConnection();
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
      });

      socket.on('peer-left', () => {
        closePeerConnection();
        setStatus('Peer left room');
      });

      socket.on('disconnect', () => {
        setIsInRoom(false);
        closePeerConnection();
        setStatus('Socket disconnected');
      });

      socket.on('connect_error', () => {
        setIsInRoom(false);
        setStatus('Unable to connect to signaling server');
      });
    } catch (error) {
      console.error('joinRoom failed during media/signaling setup:', error);
      setStatus('Failed to access camera/microphone');
    }
  }, [closePeerConnection, ensurePeerConnection, leaveRoom, roomId, signalingUrl, startLocalPreview]);

  useEffect(() => () => {
    leaveRoom();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
  }, [leaveRoom]);

  const handleRoomButtonPress = () => {
    if (isInRoom) {
      leaveRoom('Disconnected');
      return;
    }

    joinRoom();
  };

  const handleMuteToggle = useCallback(() => {
    const nextMuted = !isMuted;
    if (!setTrackEnabled(localStreamRef.current, 'audio', !nextMuted)) {
      setStatus('Start preview to control audio');
      return;
    }

    setIsMuted(nextMuted);
    setStatus(nextMuted ? 'Muted microphone' : 'Unmuted microphone');
  }, [isMuted]);

  const handleVideoToggle = useCallback(() => {
    const nextVideoEnabled = !isVideoEnabled;
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
              startLocalPreview().catch((error) => {
                console.error('startLocalPreview failed (permissions/device):', error);
                setStatus('Failed to access camera/microphone');
              });
            }}
          />
          <Button title={isInRoom ? 'Leave Room' : 'Join Room'} onPress={handleRoomButtonPress} />
        </View>

        <Text style={styles.status}>{status}</Text>

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
