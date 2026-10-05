import { useCallback, useEffect, useRef, useState } from 'react';
import { logError, logInfo, logWarn } from '../appLogger';
import type { CallStatus } from '../components/StatusBanner';
import type { ScreenShareDelivery } from '../callUx';
import { SCREEN_SHARE_UNVERIFIED_GUIDANCE } from '../callUx';
import { errorMessage } from '../errors';
import { setTrackEnabled } from '../mediaControls';
import {
  isMicrophoneMuted,
  isSystemAudioSharing,
  isSystemAudioSupported,
  startSystemAudio,
  stopSystemAudio,
  type SystemAudioStatus,
} from '../screenAudio';
import {
  isScreenAudioCaptureSupported,
  isScreenShareSupported,
  SCREEN_SHARE_CANCELLED,
  startScreenCapture,
  stopScreenCapture,
  logScreenShareAudioRtpStats,
  verifyScreenShareFrames,
} from '../screenShare';

export type UseScreenShareParams = {
  /** holds an `RTCPeerConnection`. */
  peerConnectionRef: { current: any; };
  /** Additional participant connections in a group call. */
  peerConnectionsRef?: { current: Map<string, { pc: any }> };
  /** holds a `MediaStream`. */
  localStreamRef: { current: any; };
  setLocalStream: (stream: any) => void;
  setStatus: (message: string, severity?: CallStatus['severity']) => void;
  /** sends a fresh offer. */
  renegotiate?: () => Promise<void>;
};

type MutableValue<T = any> = { current: T; };

/**
 * Target bitrate for the screen encoding (~2.5 Mbps). Comfortably above the
 * camera's default so on-screen text stays legible under constrained
 * bandwidth instead of being downscaled like ordinary camera video.
 */
const SCREEN_SHARE_MAX_BITRATE = 2_500_000;

type ScreenShareResources = {
  screenStream: any;
  screenVideoTrack: any;
  cameraTrack: any;
  audioSender: any;
  videoSender: any;
  /** Whether {@link attachScreenVideo} created `videoSender` for the share. */
  addedVideoSender: boolean;
  previousVideoParameters: any;
  peerResources: Array<{
    pc: any;
    cameraTrack: any;
    audioSender: any;
    videoSender: any;
    addedVideoSender: boolean;
    previousVideoParameters: any;
  }>;
};

function takeScreenShareResources(refs: {
  screenStream: MutableValue;
  screenVideoTrack: MutableValue;
  screenAudioSender: MutableValue;
  cameraTrack: MutableValue;
  screenVideoSender: MutableValue;
  screenVideoSenderAdded: MutableValue<boolean>;
  previousVideoParameters: MutableValue;
  peerResources: MutableValue<ScreenShareResources['peerResources']>;
}): ScreenShareResources {
  const resources = {
    screenStream: refs.screenStream.current,
    screenVideoTrack: refs.screenVideoTrack.current,
    cameraTrack: refs.cameraTrack.current,
    audioSender: refs.screenAudioSender.current,
    videoSender: refs.screenVideoSender.current,
    addedVideoSender: refs.screenVideoSenderAdded.current,
    previousVideoParameters: refs.previousVideoParameters.current,
    peerResources: refs.peerResources.current,
  };
  refs.screenStream.current = null;
  refs.screenVideoTrack.current = null;
  refs.screenAudioSender.current = null;
  refs.cameraTrack.current = null;
  refs.screenVideoSender.current = null;
  refs.screenVideoSenderAdded.current = false;
  refs.previousVideoParameters.current = null;
  refs.peerResources.current = [];
  return resources;
}

function getPeerConnections(
  peerConnectionRef: MutableValue,
  peerConnectionsRef?: MutableValue<Map<string, { pc: any }>>,
): any[] {
  const connections = [peerConnectionRef.current, ...[...(peerConnectionsRef?.current.values() ?? [])]
    .map(entry => entry?.pc)];
  return [...new Set(connections.filter(Boolean))];
}

function resetScreenShareState({
  setIsScreenSharing,
  setIsScreenAudioShared,
  setScreenShareDelivery,
}: {
  setIsScreenSharing: (value: boolean) => void;
  setIsScreenAudioShared: (value: boolean) => void;
  setScreenShareDelivery: (value: ScreenShareDelivery) => void;
}) {
  setIsScreenSharing(false);
  setIsScreenAudioShared(false);
  setScreenShareDelivery('idle');
}

/**
 * Detach and drop a sender that only existed for the share.
 *
 * @param kind - names the sender in the log line when removal fails.
 */
async function removeScreenSender(pc: any, sender: any, kind: 'audio' | 'video') {
  if (!pc || !sender) return;
  try {
    await sender.replaceTrack?.(null);
    pc.removeTrack?.(sender);
  } catch (error) {
    logWarn(`Failed to remove screen ${kind} sender`, {
      message: errorMessage(error),
    });
  }
}

/**
 * Restore the sender's pre-share encoding parameters (bitrate, degradation
 * preference, resolution scale) captured by {@link applyScreenEncodingHints}.
 *
 * Guarded like its counterpart: `setParameters` may be unavailable, and a
 * camera-only call must never be left with the screen's raised bitrate.
 */
async function restoreVideoSenderParameters(sender: any, previousParameters: any) {
  if (!sender || typeof sender.setParameters !== 'function' || !previousParameters) return;
  try {
    await sender.setParameters(previousParameters);
  } catch (error) {
    logWarn('Failed to restore camera encoding parameters after screen share', {
      message: errorMessage(error),
    });
  }
}

async function restoreCameraTrack(
  pc: any,
  cameraTrack: any,
  videoSender: any,
  previousVideoParameters: any,
) {
  if (cameraTrack) cameraTrack.enabled = true;
  try {
    const sender =
      videoSender ?? pc?.getSenders?.().find((candidate: any) => candidate.track?.kind === 'video');
    if (sender) await sender.replaceTrack(cameraTrack ?? null);
    await restoreVideoSenderParameters(sender, previousVideoParameters);
  } catch (error) {
    logWarn('Failed to restore camera track after screen share', {
      message: errorMessage(error),
    });
  }
}

function restoreLocalStream(
  localStream: any,
  screenVideoTrack: any,
  cameraTrack: any,
  setLocalStream: (stream: any) => void,
) {
  if (!localStream) return;
  if (screenVideoTrack) localStream.removeTrack?.(screenVideoTrack);
  if (cameraTrack) localStream.addTrack?.(cameraTrack);
  setLocalStream(localStream);
}

async function renegotiateAfterScreenShareStop(
  renegotiateRef: MutableValue<UseScreenShareParams['renegotiate']>,
  setStatus: UseScreenShareParams['setStatus'],
) {
  try {
    await renegotiateRef.current?.();
  } catch (error) {
    logWarn('Renegotiation after screen share stop failed', {
      message: errorMessage(error),
    });
  }
  setStatus('Screen sharing stopped');
}

function acceptedScreenCapture(
  capture: Awaited<ReturnType<typeof startScreenCapture>>,
  setStatus: UseScreenShareParams['setStatus'],
) {
  if (capture.ok) return capture;
  if (capture.reason === SCREEN_SHARE_CANCELLED) {
    logInfo('Screen sharing cancelled by user');
    setStatus('Screen sharing cancelled');
    return null;
  }
  logWarn('Screen sharing unavailable', { reason: capture.reason, message: capture.message });
  setStatus(capture.message, 'error');
  return null;
}

/**
 * Raise the outgoing video sender's parameters for screen content: a
 * maintained resolution (never downscaled to save bandwidth, unlike camera
 * video) and a bitrate high enough to keep on-screen text legible.
 *
 * Every step is guarded — `setParameters`/`getParameters`/`contentHint` are
 * not available on every `react-native-webrtc` runtime — and a failure is
 * logged rather than thrown, since a soft picture is far better than a
 * share that fails to start.
 *
 * @returns the sender's parameters from before this call, to be restored by
 *   {@link restoreVideoSenderParameters} once the share ends; `null` when
 *   nothing was changed (unsupported runtime, or no sender to change).
 */
function applyScreenEncodingHints(videoTrack: any, sender: any): any {
  if (videoTrack) {
    try {
      videoTrack.contentHint = 'detail';
    } catch (error) {
      logWarn('Failed to set screen track content hint', { message: errorMessage(error) });
    }
  }

  if (!sender || typeof sender.setParameters !== 'function') return null;
  try {
    const previousParameters =
      typeof sender.getParameters === 'function' ? sender.getParameters() : null;
    const baseParameters = previousParameters ? { ...previousParameters } : {};
    const encodings =
      Array.isArray(baseParameters.encodings) && baseParameters.encodings.length
        ? baseParameters.encodings.map((encoding: any) => ({ ...encoding }))
        : [{}];
    encodings[0] = {
      ...encodings[0],
      maxBitrate: SCREEN_SHARE_MAX_BITRATE,
      scaleResolutionDownBy: 1,
    };
    sender.setParameters({
      ...baseParameters,
      degradationPreference: 'maintain-resolution',
      encodings,
    });
    return previousParameters;
  } catch (error) {
    logWarn('Failed to apply screen share encoding parameters', {
      message: errorMessage(error),
    });
    return null;
  }
}

async function attachScreenVideo(pc: any, stream: any, videoTrack: any) {
  const existingSender = pc.getSenders?.().find((sender: any) => sender.track?.kind === 'video') ??
    pc.getTransceivers?.().find((transceiver: any) => transceiver.receiver?.track?.kind === 'video')?.sender;
  const cameraTrack = existingSender?.track ?? null;
  const sender = existingSender ?? pc.addTrack?.(videoTrack, stream) ?? null;
  if (existingSender) await existingSender.replaceTrack(videoTrack);
  logInfo('Screen track attached to peer connection', {
    replacedSender: Boolean(existingSender),
    trackId: videoTrack?.id ?? null,
    trackEnabled: videoTrack?.enabled !== false,
    direction: pc
      .getTransceivers?.()
      ?.find((transceiver: any) => transceiver.sender?.track?.id === videoTrack?.id)?.direction ?? null,
  });
  if (cameraTrack) cameraTrack.enabled = false;
  const previousVideoParameters = applyScreenEncodingHints(videoTrack, sender);
  return {
    cameraTrack,
    videoSender: sender,
    // An audio-only call has no video sender to borrow, so one is created for
    // the share and has to be taken away again when it ends.
    addedVideoSender: !existingSender && Boolean(sender),
    previousVideoParameters,
  };
}

function attachScreenAudio(pc: any, stream: any, audioTrack: any) {
  return audioTrack ? pc.addTrack?.(audioTrack, stream) ?? null : null;
}

/**
 * Start mixing the device's own audio into the call, when this build can.
 *
 * Unlike a `getDisplayMedia` audio track this needs no sender and no
 * renegotiation: the mix rides the microphone track that is already being
 * sent. The local audio track is re-enabled because mute moves to the audio
 * device module for as long as the mix runs (see `screenAudio.ts`), and a
 * disabled track would silence the shared audio along with the microphone.
 *
 * @returns the native outcome, or `null` when this build has no mixer.
 */
async function attachSystemAudio(localStream: any): Promise<SystemAudioStatus | null> {
  if (!isSystemAudioSupported()) return null;
  const status = await startSystemAudio();
  if (status.sharing) setTrackEnabled(localStream, 'audio', true);
  return status;
}

/** Stop the mix and hand mute back to the local audio track. */
async function detachSystemAudio(localStream: any) {
  if (!isSystemAudioSharing()) return;
  await stopSystemAudio();
  setTrackEnabled(localStream, 'audio', !isMicrophoneMuted());
}

function replaceLocalCamera(
  localStream: any,
  cameraTrack: any,
  videoTrack: any,
  setLocalStream: (stream: any) => void,
) {
  if (!localStream) return;
  if (cameraTrack) localStream.removeTrack?.(cameraTrack);
  localStream.addTrack?.(videoTrack);
  setLocalStream(localStream);
}

async function renegotiateAfterScreenShareStart(
  pc: any,
  renegotiateRef: MutableValue<UseScreenShareParams['renegotiate']>,
) {
  try {
    await renegotiateRef.current?.();
    logInfo('Renegotiation after screen share start completed', {
      signalingState: pc.signalingState ?? null,
    });
  } catch (error) {
    logWarn('Renegotiation after screen share start failed', {
      message: errorMessage(error),
    });
  }
}

async function verifyScreenShareDelivery({
  stream,
  screenStreamRef,
  peerConnectionRef,
  setScreenShareDelivery,
  isScreenAudioEnabled,
  audioShared,
  audioFallbackReason,
  systemAudio,
  setStatus,
}: {
  stream: any;
  screenStreamRef: MutableValue;
  peerConnectionRef: MutableValue;
  setScreenShareDelivery: (value: ScreenShareDelivery) => void;
  isScreenAudioEnabled: boolean;
  audioShared: boolean;
  audioFallbackReason?: 'unsupported' | 'denied';
  systemAudio?: SystemAudioStatus | null;
  setStatus: UseScreenShareParams['setStatus'];
}) {
  await logScreenShareAudioRtpStats(peerConnectionRef.current, {
    requestedAudio: isScreenAudioEnabled,
    audioObtained: audioShared,
  });
  const frameCheck = await verifyScreenShareFrames(peerConnectionRef.current);
  if (!frameCheck.ok && screenStreamRef.current === stream) {
    logWarn('Screen sharing produced no frames yet; keeping share active', {
      reason: frameCheck.reason,
    });
    setScreenShareDelivery('unverified');
    setStatus(
      SCREEN_SHARE_UNVERIFIED_GUIDANCE,
      'warning',
    );
    return;
  }
  if (screenStreamRef.current === stream) {
    setScreenShareDelivery(frameCheck.ok && frameCheck.verified ? 'confirmed' : 'unverified');
  }
  if (audioFallbackReason || (isScreenAudioEnabled && !audioShared)) {
    const reason = systemAudio?.reason ?? `audio capture ${audioFallbackReason ?? 'unsupported'}`;
    setStatus(`Screen sharing started without system audio: ${reason}.`, 'warning');
    return;
  }
  // Android playback capture is opt-out per app, so a capture that is running
  // is not the same as a capture that can hear anything: DRM-protected audio
  // and apps that refuse capture come through as digital silence. Say so
  // rather than promising audio the other side will never receive.
  if (audioShared && systemAudio?.state === 'silent') {
    setStatus(
      'Sharing screen. No system audio captured yet — some apps block audio capture.',
      'warning',
    );
    return;
  }
  setStatus(audioShared ? 'Sharing screen with audio' : 'Sharing screen', 'success');
}

/**
 * Undo a half-applied share after `startScreenShare` threw.
 *
 * The throw can happen after the senders were already attached, so the peer
 * connection is put back the way a normal stop would leave it — otherwise a
 * sender stays pinned to the stopped screen track and the remote peer sees
 * its last frame for the rest of the call.
 */
async function resetFailedScreenShareStart({
  pc,
  stream,
  localStreamRef,
  screenStreamRef,
  screenVideoTrackRef,
  screenAudioSenderRef,
  cameraTrackRef,
  screenVideoSenderRef,
  screenVideoSenderAddedRef,
  previousVideoParametersRef,
  peerResourcesRef,
  setIsScreenSharing,
  setIsScreenAudioShared,
  setScreenShareDelivery,
  setStatus,
}: {
  pc: any;
  stream: any;
  localStreamRef: MutableValue;
  screenStreamRef: MutableValue;
  screenVideoTrackRef: MutableValue;
  screenAudioSenderRef: MutableValue;
  cameraTrackRef: MutableValue;
  screenVideoSenderRef: MutableValue;
  screenVideoSenderAddedRef: MutableValue<boolean>;
  previousVideoParametersRef: MutableValue;
  peerResourcesRef: MutableValue<ScreenShareResources['peerResources']>;
  setIsScreenSharing: (value: boolean) => void;
  setIsScreenAudioShared: (value: boolean) => void;
  setScreenShareDelivery: (value: ScreenShareDelivery) => void;
  setStatus: UseScreenShareParams['setStatus'];
}) {
  await detachSystemAudio(localStreamRef.current);
  stopScreenCapture(stream);
  const peerResources = peerResourcesRef.current;
  if (peerResources.length) {
    await Promise.all(peerResources.map(async resource => {
      await removeScreenSender(resource.pc, resource.audioSender, 'audio');
      if (resource.addedVideoSender) {
        await removeScreenSender(resource.pc, resource.videoSender, 'video');
      } else {
        await restoreCameraTrack(
          resource.pc,
          resource.cameraTrack,
          resource.videoSender,
          resource.previousVideoParameters,
        );
      }
    }));
  } else {
    await removeScreenSender(pc, screenAudioSenderRef.current, 'audio');
    if (screenVideoSenderAddedRef.current) {
      await removeScreenSender(pc, screenVideoSenderRef.current, 'video');
    } else {
      await restoreCameraTrack(
        pc,
        cameraTrackRef.current,
        screenVideoSenderRef.current,
        previousVideoParametersRef.current,
      );
    }
  }
  screenStreamRef.current = null;
  screenVideoTrackRef.current = null;
  screenAudioSenderRef.current = null;
  screenVideoSenderRef.current = null;
  screenVideoSenderAddedRef.current = false;
  previousVideoParametersRef.current = null;
  peerResourcesRef.current = [];
  if (cameraTrackRef.current) {
    cameraTrackRef.current.enabled = true;
    cameraTrackRef.current = null;
  }
  resetScreenShareState({ setIsScreenSharing, setIsScreenAudioShared, setScreenShareDelivery });
  setStatus('Unable to start screen sharing', 'error');
}

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
 * A runtime that returns no audio track disables the option for the rest of
 * the session (`isScreenAudioCaptureSupported`) instead of warning after every
 * share about something the device cannot do.
 */
export default function useScreenShare({
  peerConnectionRef,
  peerConnectionsRef,
  localStreamRef,
  setLocalStream,
  setStatus,
  renegotiate,
}: UseScreenShareParams) {
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isScreenAudioShared, setIsScreenAudioShared] = useState(false);
  // The frame verification already runs on every share; this publishes its
  // result so the sharer gets the positive confirmation too, not only the
  // "no frames" failure.
  const [screenShareDelivery, setScreenShareDelivery] =
    useState<ScreenShareDelivery>('idle');
  // User preference: include screen (system) audio with the next share.
  const [isScreenAudioEnabled, setIsScreenAudioEnabled] = useState(() =>
    isSystemAudioSupported() || isScreenAudioCaptureSupported());
  // Whether asking for screen audio is worth offering at all. Starts true and
  // flips once a capture has shown this runtime never returns an audio track,
  // so the control can say so instead of silently dropping the request.
  const [isScreenAudioSupported, setIsScreenAudioSupported] = useState(() =>
    isSystemAudioSupported() || isScreenAudioCaptureSupported());

  const screenStreamRef = useRef((null as any));
  const screenVideoTrackRef = useRef((null as any));
  const screenAudioSenderRef = useRef((null as any));
  const cameraTrackRef = useRef((null as any));
  const screenVideoSenderRef = useRef((null as any));
  const screenVideoSenderAddedRef = useRef(false);
  const previousVideoParametersRef = useRef((null as any));
  const peerResourcesRef = useRef([] as ScreenShareResources['peerResources']);
  const isTogglingRef = useRef(false);
  // Mirrored into state because the control has to *look* busy: the toggle
  // round-trips through a system capture prompt and (with screen audio) a
  // renegotiation, and a button that stays enabled through all of it reads as
  // broken and invites a second tap the guard then silently swallows.
  const [isTogglingScreenShare, setIsTogglingScreenShare] = useState(false);

  const renegotiateRef = useRef(renegotiate);
  useEffect(() => {
    renegotiateRef.current = renegotiate;
  }, [renegotiate]);

  /**
   * Restore the camera track locally and on the peer connection, and release
   * every screen-capture resource. Safe to call when not sharing.
   *
   * @param options - `silent` skips status updates and
   *   renegotiation (used during teardown when the call is already ending).
   */
  const stopScreenShare = useCallback(
    async ({ silent = false } = {}) => {
      const resources = takeScreenShareResources({
        screenStream: screenStreamRef,
        screenVideoTrack: screenVideoTrackRef,
        screenAudioSender: screenAudioSenderRef,
        cameraTrack: cameraTrackRef,
        screenVideoSender: screenVideoSenderRef,
        screenVideoSenderAdded: screenVideoSenderAddedRef,
        previousVideoParameters: previousVideoParametersRef,
        peerResources: peerResourcesRef,
      });

      if (!resources.screenStream && !resources.screenVideoTrack) {
        await detachSystemAudio(localStreamRef.current);
        resetScreenShareState({ setIsScreenSharing, setIsScreenAudioShared, setScreenShareDelivery });
        return;
      }

      // Before the capture is torn down: the mix borrows its MediaProjection.
      await detachSystemAudio(localStreamRef.current);

      if (resources.peerResources.length) {
        await Promise.all(resources.peerResources.map(async resource => {
          await removeScreenSender(resource.pc, resource.audioSender, 'audio');
          if (resource.addedVideoSender) {
            await removeScreenSender(resource.pc, resource.videoSender, 'video');
          } else {
            await restoreCameraTrack(
              resource.pc,
              resource.cameraTrack,
              resource.videoSender,
              resource.previousVideoParameters,
            );
          }
        }));
      } else {
        const pc = peerConnectionRef.current;
        await removeScreenSender(pc, resources.audioSender, 'audio');
        if (resources.addedVideoSender) {
          await removeScreenSender(pc, resources.videoSender, 'video');
        } else {
          await restoreCameraTrack(
            pc,
            resources.cameraTrack,
            resources.videoSender,
            resources.previousVideoParameters,
          );
        }
      }
      restoreLocalStream(
        localStreamRef.current,
        resources.screenVideoTrack,
        resources.cameraTrack,
        setLocalStream,
      );
      stopScreenCapture(resources.screenStream);
      resetScreenShareState({ setIsScreenSharing, setIsScreenAudioShared, setScreenShareDelivery });
      logInfo('Screen sharing stopped');

      if (!silent) {
        await renegotiateAfterScreenShareStop(renegotiateRef, setStatus);
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

    const peerConnections = getPeerConnections(peerConnectionRef, peerConnectionsRef);
    const pc = peerConnections[0];
    if (!pc) {
      setStatus('Screen sharing needs an active call', 'error');
      return;
    }

    // When the native mixer is available it replaces the `getDisplayMedia`
    // audio request outright. Asking for a track this runtime never returns
    // would only teach `isScreenAudioCaptureSupported` that screen audio is
    // impossible and disable the option for the rest of the session.
    const usesSystemAudioMixer = isScreenAudioEnabled && isSystemAudioSupported();
    const capture = acceptedScreenCapture(
      await startScreenCapture({ withAudio: isScreenAudioEnabled && !usesSystemAudioMixer }),
      setStatus,
    );
    if (!capture) return;
    // Without the mixer, the capture is the only place the runtime's
    // screen-audio capability becomes observable; publish it so the control
    // can stop offering an option this device will never honour.
    const audioCaptureSupported = isSystemAudioSupported() || isScreenAudioCaptureSupported();
    setIsScreenAudioSupported(audioCaptureSupported);
    if (!audioCaptureSupported) setIsScreenAudioEnabled(false);
    const {
      stream,
      videoTrack,
      audioTrack,
      audioShared: capturedAudioShared,
      audioFallbackReason,
    } = capture as any;

    try {
      const peerResources: ScreenShareResources['peerResources'] = [];
      for (const currentPc of peerConnections) {
        const { cameraTrack, videoSender, addedVideoSender, previousVideoParameters } =
          await attachScreenVideo(currentPc, stream, videoTrack);
        const resource: ScreenShareResources['peerResources'][number] = {
          pc: currentPc,
          cameraTrack,
          videoSender,
          addedVideoSender,
          previousVideoParameters,
          audioSender: null,
        };
        peerResources.push(resource);
        peerResourcesRef.current = peerResources;
        resource.audioSender = attachScreenAudio(currentPc, stream, audioTrack);
      }
      const primary = peerResources[0];
      cameraTrackRef.current = primary?.cameraTrack ?? null;
      screenVideoSenderRef.current = primary?.videoSender ?? null;
      screenVideoSenderAddedRef.current = Boolean(primary?.addedVideoSender);
      previousVideoParametersRef.current = primary?.previousVideoParameters ?? null;
      screenAudioSenderRef.current = primary?.audioSender ?? null;
      screenStreamRef.current = stream;
      screenVideoTrackRef.current = videoTrack;
      replaceLocalCamera(localStreamRef.current, primary?.cameraTrack ?? null, videoTrack, setLocalStream);
      // Started once the projection exists and before renegotiation, though it
      // needs neither a sender nor an SDP change: the mix rides the microphone
      // track the call is already sending.
      const systemAudio = usesSystemAudioMixer
        ? await attachSystemAudio(localStreamRef.current)
        : null;
      const audioShared = systemAudio ? systemAudio.sharing : Boolean(capturedAudioShared);
      // The OS "stop sharing" affordance ends the track directly.
      videoTrack.onended = () => {
        logInfo('Screen capture ended by the system');
        stopScreenShare().catch(error => {
          logError('Failed to stop screen share after system end', error);
        });
      };

      setIsScreenSharing(true);
      setIsScreenAudioShared(audioShared);
      setScreenShareDelivery('checking');
      await renegotiateAfterScreenShareStart(pc, renegotiateRef);
      await verifyScreenShareDelivery({
        stream,
        screenStreamRef,
        peerConnectionRef: { current: pc },
        setScreenShareDelivery,
        isScreenAudioEnabled,
        audioShared,
        audioFallbackReason,
        systemAudio,
        setStatus,
      });
    } catch (error) {
      logError('Failed to start screen sharing', error);
      await resetFailedScreenShareStart({
        pc,
        stream,
        localStreamRef,
        screenStreamRef,
        screenVideoTrackRef,
        screenAudioSenderRef,
        cameraTrackRef,
        screenVideoSenderRef,
        screenVideoSenderAddedRef,
        previousVideoParametersRef,
        peerResourcesRef,
        setIsScreenSharing,
        setIsScreenAudioShared,
        setScreenShareDelivery,
        setStatus,
      });
    }
  }, [
    isScreenAudioEnabled,
    localStreamRef,
    peerConnectionRef,
    peerConnectionsRef,
    setLocalStream,
    setStatus,
    stopScreenShare,
  ]);

  /** Start sharing when idle, stop when already sharing. */
  const handleScreenShareToggle = useCallback(async () => {
    if (isTogglingRef.current) return;
    isTogglingRef.current = true;
    setIsTogglingScreenShare(true);
    try {
      if (screenStreamRef.current) {
        await stopScreenShare();
      } else {
        await startScreenShare();
      }
    } finally {
      isTogglingRef.current = false;
      setIsTogglingScreenShare(false);
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
    if (!isScreenAudioSupported) {
      setStatus('This device cannot capture system audio', 'warning');
      return;
    }
    setIsScreenAudioEnabled(previous => {
      const next = !previous;
      setStatus(next ? 'Screen audio will be shared' : 'Screen audio will not be shared');
      return next;
    });
  }, [isScreenAudioSupported, setStatus]);

  /** Release capture resources without touching signaling (call teardown). */
  const resetScreenShare = useCallback(() => {
    stopScreenShare({ silent: true }).catch(error => {
      logWarn('Silent screen share stop failed', {
        message: errorMessage(error),
      });
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
    isTogglingScreenShare,
    isScreenAudioShared,
    isScreenAudioEnabled,
    isScreenAudioSupported,
    screenShareDelivery,
    isScreenShareSupported: isScreenShareSupported(),
    startScreenShare,
    stopScreenShare,
    handleScreenShareToggle,
    handleScreenAudioToggle,
    resetScreenShare,
  };
}
