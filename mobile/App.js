import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { io } from 'socket.io-client';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
} from 'react-native-webrtc';
import { getIceServers } from './src/webrtcConfig';

const DEFAULT_SIGNALING_URL = process.env.EXPO_PUBLIC_SIGNALING_URL || 'http://localhost:3001';
const DEFAULT_ROOM_ID = process.env.EXPO_PUBLIC_ROOM_ID || 'room-1';

export default function App() {
  const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);
  const [roomId, setRoomId] = useState(DEFAULT_ROOM_ID);
  const [status, setStatus] = useState('Ready');
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isInRoom, setIsInRoom] = useState(false);

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

  const startLocalPreview = useCallback(async () => {
    if (localStreamRef.current) {
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
    setStatus('Local preview ready');
    return stream;
  }, []);

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

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>studious-robot</Text>
        <Text style={styles.subtitle}>Phase 3 — Android WebRTC handshake</Text>

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

        <Text style={styles.streamLabel}>Local stream</Text>
        {localStream ? <RTCView style={styles.stream} streamURL={localStream.toURL()} /> : <View style={styles.emptyStream} />}

        <Text style={styles.streamLabel}>Remote stream</Text>
        {remoteStream ? <RTCView style={styles.stream} streamURL={remoteStream.toURL()} /> : <View style={styles.emptyStream} />}
      </ScrollView>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#101420',
  },
  content: {
    padding: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '600',
    color: '#f6f8ff',
  },
  input: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#384666',
    backgroundColor: '#1b2438',
    color: '#f6f8ff',
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
    color: '#adb6ca',
    marginBottom: 16,
  },
  status: {
    color: '#d8def0',
    marginBottom: 12,
  },
  streamLabel: {
    color: '#d8def0',
    marginBottom: 8,
  },
  stream: {
    height: 220,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#000',
    marginBottom: 16,
  },
  emptyStream: {
    height: 220,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#384666',
    backgroundColor: '#141c2e',
    marginBottom: 16,
  },
});
