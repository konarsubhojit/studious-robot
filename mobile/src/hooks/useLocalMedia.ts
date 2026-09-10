import { useCallback, useRef, useState } from 'react';
import { mediaDevices } from 'react-native-webrtc';
import { logError, logInfo, logWarn } from '../appLogger';
import { getMediaAccessStatus } from '../diagnostics';
import { isTrackEnabled, setTrackEnabled } from '../mediaControls';
import { ensureCallPermissions } from '../permissions';
import type { ReplaceOutgoingVideoTrack, WebrtcMediaStream } from './usePeerConnection';

type MutableRef<T> = { current: T };

type UseLocalMediaParams = {
  replaceOutgoingVideoTrackRef: MutableRef<ReplaceOutgoingVideoTrack | null>;
  setIsMuted: (value: boolean) => void;
  updateStatus: (message: string, severity?: 'info' | 'success' | 'warning' | 'error') => void;
};

/**
 * Owns the camera/microphone stream and the controls that mutate its tracks.
 * `useCallFlow` still composes the call lifecycle around it, but it no longer
 * reaches into media acquisition or camera-switch details directly.
 */
export default function useLocalMedia({
  replaceOutgoingVideoTrackRef,
  setIsMuted,
  updateStatus,
}: UseLocalMediaParams) {
  const [localStream, setLocalStream] = useState(null as WebrtcMediaStream | null);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const localStreamRef = useRef(null as WebrtcMediaStream | null);

  const releaseLocalMedia = useCallback(() => {
    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks?.().forEach(track => {
        try {
          track.stop();
        } catch {
          // Best-effort: the track may already have been ended by the OS.
        }
      });
      localStreamRef.current = null;
    }
    setLocalStream(null);
  }, []);

  const startLocalPreview = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;

    const permResult = await ensureCallPermissions();
    if (!permResult.ok) {
      updateStatus(permResult.message, 'error');
      return null;
    }
    if (permResult.warningMessage) {
      logWarn('[CallFlow] Optional permission denied', {
        message: permResult.warningMessage,
      });
    }

    try {
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: 'user' },
      });
      logInfo('[CallFlow] Local media stream acquired', {
        audio: stream.getAudioTracks().length,
        video: stream.getVideoTracks().length,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      setIsMuted(!isTrackEnabled(stream, 'audio'));
      setIsVideoEnabled(isTrackEnabled(stream, 'video'));
      return stream;
    } catch (error) {
      logError('[CallFlow] Failed to acquire media', error);
      updateStatus(getMediaAccessStatus(error), 'error');
      throw error;
    }
  }, [setIsMuted, updateStatus]);

  const handleVideoToggle = useCallback(() => {
    const nextVideoEnabled = !isVideoEnabled;
    if (!setTrackEnabled(localStreamRef.current, 'video', nextVideoEnabled)) {
      updateStatus('Start preview to control video', 'error');
      return;
    }
    setIsVideoEnabled(nextVideoEnabled);
    updateStatus(nextVideoEnabled ? 'Camera enabled' : 'Camera disabled');
  }, [isVideoEnabled, updateStatus]);

  const handleCameraSwitch = useCallback(async () => {
    try {
      const [videoTrack] = localStreamRef.current?.getVideoTracks?.() ?? [];

      if (typeof videoTrack?._switchCamera === 'function') {
        videoTrack._switchCamera();
        setIsFrontCamera(prev => !prev);
        updateStatus('Camera switched');
        return;
      }

      const nextFacingMode = isFrontCamera ? 'environment' : 'user';
      const newStream = await mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: nextFacingMode },
      });
      const [newVideoTrack] = newStream.getVideoTracks();
      if (!newVideoTrack) {
        newStream.getTracks().forEach(t => t.stop());
        updateStatus('Camera switch unavailable', 'error');
        return;
      }

      await replaceOutgoingVideoTrackRef.current?.(newVideoTrack);

      videoTrack?.stop();
      if (localStreamRef.current) {
        if (videoTrack) localStreamRef.current.removeTrack(videoTrack);
        localStreamRef.current.addTrack(newVideoTrack);
      }
      setLocalStream(localStreamRef.current);
      setIsFrontCamera(prev => !prev);
      updateStatus('Camera switched');
    } catch (error) {
      logError('[CallFlow] Camera switch failed', error);
      updateStatus('Camera switch unavailable', 'error');
    }
  }, [isFrontCamera, replaceOutgoingVideoTrackRef, updateStatus]);

  return {
    handleCameraSwitch,
    handleVideoToggle,
    isFrontCamera,
    isVideoEnabled,
    localStream,
    localStreamRef,
    releaseLocalMedia,
    setLocalStream,
    startLocalPreview,
  };
}
