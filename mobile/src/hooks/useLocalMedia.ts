import { useCallback, useEffect, useRef, useState } from 'react';
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
  const mediaEpochRef = useRef(0);
  const cameraChangeRef = useRef(false);

  const releaseLocalMedia = useCallback(() => {
    mediaEpochRef.current += 1;
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

  useEffect(() => releaseLocalMedia, [releaseLocalMedia]);

  const startLocalPreview = useCallback(async (mediaType: 'audio' | 'video' = 'video') => {
    if (localStreamRef.current) {
      if (mediaType === 'audio') {
        localStreamRef.current.getVideoTracks().forEach(track => {
          track.stop();
          localStreamRef.current?.removeTrack(track);
        });
        setIsVideoEnabled(false);
      }
      return localStreamRef.current;
    }

    const epoch = mediaEpochRef.current;
    const permResult = await ensureCallPermissions(mediaType);
    if (epoch !== mediaEpochRef.current) return null;
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
        video: mediaType === 'audio' ? false : { facingMode: 'user' },
      });
      if (epoch !== mediaEpochRef.current || localStreamRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return epoch === mediaEpochRef.current ? localStreamRef.current : null;
      }
      logInfo('[CallFlow] Local media stream acquired', {
        audio: stream.getAudioTracks().length,
        video: stream.getVideoTracks().length,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      setIsMuted(!isTrackEnabled(stream, 'audio'));
      setIsVideoEnabled(mediaType !== 'audio' && isTrackEnabled(stream, 'video'));
      return stream;
    } catch (error) {
      logError('[CallFlow] Failed to acquire media', error);
      updateStatus(getMediaAccessStatus(error), 'error');
      throw error;
    }
  }, [setIsMuted, updateStatus]);

  const enableCamera = useCallback(async (stream: WebrtcMediaStream) => {
    if (cameraChangeRef.current) return;
    cameraChangeRef.current = true;
    let cameraStream: WebrtcMediaStream | null = null;
    try {
      const permissions = await ensureCallPermissions('video');
      if (localStreamRef.current !== stream) return;
      if (!permissions.ok) {
        updateStatus(permissions.message, 'error');
        return;
      }
        cameraStream = await mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user' },
        });
        const [track] = cameraStream.getVideoTracks();
        if (!track || localStreamRef.current !== stream) {
          cameraStream.getTracks().forEach(t => t.stop());
          return;
        }
        await replaceOutgoingVideoTrackRef.current?.(track);
        if (localStreamRef.current !== stream) {
          cameraStream.getTracks().forEach(t => t.stop());
          return;
        }
        stream.addTrack(track);
        setIsVideoEnabled(true);
        setIsFrontCamera(true);
        updateStatus('Camera enabled');
    } catch (error) {
        cameraStream?.getTracks().forEach(track => track.stop());
        logError('[CallFlow] Failed to enable camera', error);
        updateStatus(getMediaAccessStatus(error), 'error');
    } finally {
      cameraChangeRef.current = false;
    }
  }, [replaceOutgoingVideoTrackRef, updateStatus]);

  const handleVideoToggle = useCallback(async () => {
    const stream = localStreamRef.current;
    if (stream && !stream.getVideoTracks().length) {
      await enableCamera(stream);
      return;
    }
    const nextVideoEnabled = !isVideoEnabled;
    if (!setTrackEnabled(localStreamRef.current, 'video', nextVideoEnabled)) {
      updateStatus('Start preview to control video', 'error');
      return;
    }
    setIsVideoEnabled(nextVideoEnabled);
    updateStatus(nextVideoEnabled ? 'Camera enabled' : 'Camera disabled');
  }, [enableCamera, isVideoEnabled, updateStatus]);

  const handleCameraSwitch = useCallback(async () => {
    try {
      const [videoTrack] = localStreamRef.current?.getVideoTracks?.() ?? [];
      if (!videoTrack) {
        updateStatus('Enable camera before switching it', 'error');
        return;
      }

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
