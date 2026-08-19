import { useCallback, useEffect, useRef, useState } from 'react';
import { logError, logInfo, logWarn } from '../appLogger';
import {
  isScreenShareSupported,
  SCREEN_SHARE_CANCELLED,
  startScreenCapture,
  stopScreenCapture,
  verifyScreenShareFrames,
} from '../screenShare';

/**
 * Screen-sharing state machine shared by both call flows.
 *
 * While sharing, the outgoing camera track is replaced (via `replaceTrack`) by
 * the captured screen track so the remote peer sees the screen without any
 * renegotiation.  The camera track is kept alive but disabled so the previous
 * video source can be restored instantly when sharing stops.
 *
 * Screen audio is optional (MS Teams' *Include computer sound*): when enabled
 * and the platform provides an audio track, the track is added as an extra
 * sender, which does require a renegotiation round-trip through `renegotiate`.
 * The microphone track is left untouched so mute keeps working independently.
 *
 * @param {object}   params
 * @param {{ current: object | null }} params.peerConnectionRef
 * @param {{ current: object | null }} params.localStreamRef
 * @param {(stream: object | null) => void} params.setLocalStream
 * @param {(message: string, severity?: string) => void} params.setStatus
 * @param {() => Promise<void>} [params.renegotiate] - sends a fresh offer.
 */
export default function useScreenShare({
  peerConnectionRef,
  localStreamRef,
  setLocalStream,
  setStatus,
  renegotiate,
}) {
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isScreenAudioShared, setIsScreenAudioShared] = useState(false);
  // User preference: include screen (system) audio with the next share.
  const [isScreenAudioEnabled, setIsScreenAudioEnabled] = useState(false);

  const screenStreamRef = useRef(null);
  const screenVideoTrackRef = useRef(null);
  const screenAudioSenderRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const isTogglingRef = useRef(false);

  const renegotiateRef = useRef(renegotiate);
  useEffect(() => {
    renegotiateRef.current = renegotiate;
  }, [renegotiate]);

  /**
   * Restore the camera track locally and on the peer connection, and release
   * every screen-capture resource. Safe to call when not sharing.
   *
   * @param {{ silent?: boolean }} [options] - `silent` skips status updates and
   *   renegotiation (used during teardown when the call is already ending).
   */
  const stopScreenShare = useCallback(
    async ({ silent = false } = {}) => {
      const screenStream = screenStreamRef.current;
      const screenVideoTrack = screenVideoTrackRef.current;
      const cameraTrack = cameraTrackRef.current;
      const audioSender = screenAudioSenderRef.current;

      screenStreamRef.current = null;
      screenVideoTrackRef.current = null;
      screenAudioSenderRef.current = null;
      cameraTrackRef.current = null;

      if (!screenStream && !screenVideoTrack) {
        setIsScreenSharing(false);
        setIsScreenAudioShared(false);
        return;
      }

      const pc = peerConnectionRef.current;

      if (pc && audioSender) {
        try {
          await audioSender.replaceTrack?.(null);
          pc.removeTrack?.(audioSender);
        } catch (error) {
          logWarn('Failed to remove screen audio sender', { message: error?.message });
        }
      }

      if (cameraTrack) {
        cameraTrack.enabled = true;
        try {
          const sender = pc?.getSenders?.().find(s => s.track?.kind === 'video');
          if (sender) {
            await sender.replaceTrack(cameraTrack);
          }
        } catch (error) {
          logWarn('Failed to restore camera track after screen share', {
            message: error?.message,
          });
        }
      }

      const localStream = localStreamRef.current;
      if (localStream) {
        if (screenVideoTrack) {
          localStream.removeTrack?.(screenVideoTrack);
        }
        if (cameraTrack) {
          localStream.addTrack?.(cameraTrack);
        }
        setLocalStream(localStream);
      }

      stopScreenCapture(screenStream);
      setIsScreenSharing(false);
      setIsScreenAudioShared(false);
      logInfo('Screen sharing stopped');

      if (!silent) {
        try {
          await renegotiateRef.current?.();
        } catch (error) {
          logWarn('Renegotiation after screen share stop failed', {
            message: error?.message,
          });
        }
        setStatus('Screen sharing stopped');
      }
    },
    [localStreamRef, peerConnectionRef, setLocalStream, setStatus],
  );

  /**
   * Prompt for screen-capture consent and start sharing the screen (plus screen
   * audio when enabled and available).
   */
  const startScreenShare = useCallback(async () => {
    if (screenStreamRef.current) return;

    const pc = peerConnectionRef.current;
    if (!pc) {
      setStatus('Screen sharing needs an active call', 'error');
      return;
    }

    const capture = await startScreenCapture({ withAudio: isScreenAudioEnabled });
    if (!capture.ok) {
      if (capture.reason === SCREEN_SHARE_CANCELLED) {
        logInfo('Screen sharing cancelled by user');
        setStatus('Screen sharing cancelled');
        return;
      }
      logWarn('Screen sharing unavailable', { reason: capture.reason, message: capture.message });
      setStatus(capture.message, 'error');
      return;
    }

    const { stream, videoTrack, audioTrack, audioShared } = capture;

    try {
      const videoSender = pc.getSenders?.().find(s => s.track?.kind === 'video');
      const cameraTrack = videoSender?.track ?? null;
      if (videoSender) {
        await videoSender.replaceTrack(videoTrack);
      } else {
        pc.addTrack?.(videoTrack, stream);
      }

      // A share that shows nothing on the remote side is almost always a track
      // that never reached the peer connection, so record exactly what was
      // attached and in which direction the transceiver ends up negotiated.
      logInfo('Screen track attached to peer connection', {
        replacedSender: Boolean(videoSender),
        trackId: videoTrack?.id ?? null,
        trackEnabled: videoTrack?.enabled !== false,
        direction:
          pc
            .getTransceivers?.()
            ?.find(transceiver => transceiver.sender?.track?.id === videoTrack?.id)?.direction ??
          null,
      });

      // Keep the camera track alive (but paused) so it can be restored without
      // re-prompting for permissions or re-opening the camera device.
      if (cameraTrack) {
        cameraTrack.enabled = false;
      }
      cameraTrackRef.current = cameraTrack;

      let audioSender = null;
      if (audioTrack) {
        // An extra audio sender changes the SDP, so renegotiation is required.
        audioSender = pc.addTrack?.(audioTrack, stream) ?? null;
      }

      screenStreamRef.current = stream;
      screenVideoTrackRef.current = videoTrack;
      screenAudioSenderRef.current = audioSender;

      const localStream = localStreamRef.current;
      if (localStream) {
        if (cameraTrack) {
          localStream.removeTrack?.(cameraTrack);
        }
        localStream.addTrack?.(videoTrack);
        setLocalStream(localStream);
      }

      // The OS "stop sharing" affordance ends the track directly.
      videoTrack.onended = () => {
        logInfo('Screen capture ended by the system');
        stopScreenShare().catch(error => {
          logError('Failed to stop screen share after system end', error);
        });
      };

      setIsScreenSharing(true);
      setIsScreenAudioShared(audioShared);

      try {
        await renegotiateRef.current?.();
        logInfo('Renegotiation after screen share start completed', {
          signalingState: pc.signalingState ?? null,
        });
      } catch (error) {
        logWarn('Renegotiation after screen share start failed', {
          message: error?.message,
        });
      }

      // A capture that never produces frames looks fine locally but shows the
      // remote peer a black screen, so surface it as a failure instead of
      // silently "succeeding".
      const frameCheck = await verifyScreenShareFrames(peerConnectionRef.current);
      if (!frameCheck.ok && screenStreamRef.current === stream) {
        logError('Screen sharing produced no frames; stopping', {
          reason: frameCheck.reason,
        });
        await stopScreenShare({ silent: true });
        setStatus(frameCheck.message, 'error');
        return;
      }

      if (isScreenAudioEnabled && !audioShared) {
        setStatus('Sharing screen (screen audio unavailable on this device)', 'warning');
      } else {
        setStatus(audioShared ? 'Sharing screen with audio' : 'Sharing screen', 'success');
      }
    } catch (error) {
      logError('Failed to start screen sharing', error);
      stopScreenCapture(stream);
      screenStreamRef.current = null;
      screenVideoTrackRef.current = null;
      screenAudioSenderRef.current = null;
      if (cameraTrackRef.current) {
        cameraTrackRef.current.enabled = true;
        cameraTrackRef.current = null;
      }
      setIsScreenSharing(false);
      setIsScreenAudioShared(false);
      setStatus('Unable to start screen sharing', 'error');
    }
  }, [
    isScreenAudioEnabled,
    localStreamRef,
    peerConnectionRef,
    setLocalStream,
    setStatus,
    stopScreenShare,
  ]);

  /** Start sharing when idle, stop when already sharing. */
  const handleScreenShareToggle = useCallback(async () => {
    if (isTogglingRef.current) return;
    isTogglingRef.current = true;
    try {
      if (screenStreamRef.current) {
        await stopScreenShare();
      } else {
        await startScreenShare();
      }
    } finally {
      isTogglingRef.current = false;
    }
  }, [startScreenShare, stopScreenShare]);

  /**
   * Toggle the "include screen audio" preference. Applies to the next share;
   * changing it mid-share is rejected with a hint so the SDP stays stable.
   */
  const handleScreenAudioToggle = useCallback(() => {
    if (screenStreamRef.current) {
      setStatus('Stop sharing to change the screen audio setting');
      return;
    }
    setIsScreenAudioEnabled(previous => {
      const next = !previous;
      setStatus(next ? 'Screen audio will be shared' : 'Screen audio will not be shared');
      return next;
    });
  }, [setStatus]);

  /** Release capture resources without touching signaling (call teardown). */
  const resetScreenShare = useCallback(() => {
    stopScreenShare({ silent: true }).catch(error => {
      logWarn('Silent screen share stop failed', { message: error?.message });
    });
  }, [stopScreenShare]);

  useEffect(() => resetScreenShare, [resetScreenShare]);

  // @remarks Future group-call support: `isScreenSharing` here and
  // `isRemoteScreenSharing` in useCallFlow.js are single booleans because only
  // one-to-one calls exist today. Multi-participant calls would need to turn
  // both into per-participant maps, with a "N people viewing" count hanging
  // off the same `call.media-state` relay mechanism.
  return {
    isScreenSharing,
    isScreenAudioShared,
    isScreenAudioEnabled,
    isScreenShareSupported: isScreenShareSupported(),
    startScreenShare,
    stopScreenShare,
    handleScreenShareToggle,
    handleScreenAudioToggle,
    resetScreenShare,
  };
}
