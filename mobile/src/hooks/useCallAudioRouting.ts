import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { logError, logInfo, logWarn } from '../appLogger';
import {
  applyPreferredAudioRoute,
  AUDIO_ROUTES,
  chooseAudioRoute,
  restoreInCallAudioSession,
  setAudioRoute,
  startAudioSession,
  stopAudioSession,
  subscribeAudioDevices,
} from '../audioRouting';
import {
  describeChosenRoute,
  describeDetachedManualRoute,
  mergeDiscoveredDevices,
  shouldUpgradeToSpeaker,
} from '../call/audioRouteRules';
import { errorMessage } from '../errors';
import { triggerHaptic } from '../haptics';
import { MediaStreamLike, setTrackEnabled } from '../mediaControls';

type AudioDeviceSnapshot = {
  available: readonly string[];
  selected: string | null;
};

type UseCallAudioRoutingParams = {
  isInCall: boolean;
  isInCallRef: MutableRefObject<boolean>;
  isMuted: boolean;
  localStreamRef: MutableRefObject<MediaStreamLike | null>;
  setIsMuted: Dispatch<SetStateAction<boolean>>;
  speakerEnabledByDefault?: boolean;
  updateStatus: (message: string, severity?: 'info' | 'success' | 'warning' | 'error') => void;
};

export default function useCallAudioRouting({
  isInCall,
  isInCallRef,
  isMuted,
  localStreamRef,
  setIsMuted,
  speakerEnabledByDefault,
  updateStatus,
}: UseCallAudioRoutingParams) {
  const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(false);
  const [audioDevices, setAudioDevices] = useState<AudioDeviceSnapshot>({
    available: [],
    selected: null,
  });
  const manualAudioRouteRef = useRef<string | null>(null);
  const selectedAudioRouteRef = useRef<string | null>(null);

  const publishAudioDevices = useCallback((next: AudioDeviceSnapshot) => {
    setAudioDevices(previous => {
      const sameAvailable =
        previous.available === next.available ||
        (
          previous.available.length === next.available.length &&
          previous.available.every((device, index) => device === next.available[index])
        );
      return sameAvailable && previous.selected === next.selected ? previous : next;
    });
  }, []);

  useEffect(() => {
    selectedAudioRouteRef.current = audioDevices.selected;
  }, [audioDevices.selected]);

  const handleMuteToggle = useCallback(() => {
    const nextMuted = !isMuted;
    if (!setTrackEnabled(localStreamRef.current, 'audio', !nextMuted)) {
      updateStatus('Start preview to control audio', 'error');
      return;
    }
    triggerHaptic('tap');
    setIsMuted(nextMuted);

    // Unmuting re-opens the capture path, which can leave the device out of
    // in-call audio mode (and therefore without its echo canceller). Put the
    // session and selected output device back in place.
    if (!nextMuted && isInCallRef.current) {
      restoreInCallAudioSession(selectedAudioRouteRef.current)
        .then(result => {
          if (!result.ok) {
            logWarn('[CallFlow] Audio session restore after unmute failed', {
              message: result.message,
            });
          }
        })
        .catch(error => {
          logWarn('[CallFlow] Audio session restore after unmute threw', {
            message: errorMessage(error),
          });
        });
    }

    updateStatus(nextMuted ? 'Muted microphone' : 'Unmuted microphone');
  }, [isInCallRef, isMuted, localStreamRef, setIsMuted, updateStatus]);

  const chooseAudioOutput = useCallback(
    async (route: string) => {
      try {
        manualAudioRouteRef.current = route;
        const result = await chooseAudioRoute(route);
        if (!result.ok) {
          publishAudioDevices({
            available: result.available,
            selected: result.selected,
          });
          setIsSpeakerEnabled(result.selected === AUDIO_ROUTES.SPEAKER_PHONE);
          updateStatus(result.message, 'error');
          return;
        }
        publishAudioDevices({
          available: result.available,
          selected: result.selected,
        });
        setIsSpeakerEnabled(route === AUDIO_ROUTES.SPEAKER_PHONE);
        updateStatus(describeChosenRoute(route));
      } catch (error) {
        logError('[CallFlow] chooseAudioOutput failed', error);
        updateStatus('Unable to switch audio output', 'error');
      }
    },
    [publishAudioDevices, updateStatus],
  );

  useEffect(() => {
    if (!isInCall) return undefined;

    const result = startAudioSession();
    if (!result.ok) {
      logWarn('[CallFlow] InCallManager start failed', {
        message: result.message,
      });
      updateStatus(result.message, 'error');
    }

    return () => {
      const stopResult = stopAudioSession();
      if (!stopResult.ok) {
        logWarn('[CallFlow] InCallManager stop failed', {
          message: stopResult.message,
        });
      }
    };
  }, [isInCall, updateStatus]);

  const applyAutomaticAudioRoute = useCallback(
    async (available: string[]) => {
      if (manualAudioRouteRef.current) return;
      const result = await applyPreferredAudioRoute(available);
      if (
        shouldUpgradeToSpeaker({
          routed: result.ok,
          selected: result.selected,
          speakerEnabledByDefault,
        })
      ) {
        const speakerResult = await chooseAudioRoute(AUDIO_ROUTES.SPEAKER_PHONE);
        if (speakerResult.ok) {
          publishAudioDevices({
            available: mergeDiscoveredDevices(speakerResult.available, result.available),
            selected: speakerResult.selected,
          });
          setIsSpeakerEnabled(true);
          return;
        }
        logWarn('[CallFlow] Speaker default unavailable; keeping automatic route', {
          message: speakerResult.message,
        });
      }
      publishAudioDevices({ available: result.available, selected: result.selected });
      setIsSpeakerEnabled(result.selected === AUDIO_ROUTES.SPEAKER_PHONE);
      if (!result.ok) {
        logWarn('[CallFlow] Automatic audio routing degraded', {
          message: result.message,
        });
      }
    },
    [publishAudioDevices, speakerEnabledByDefault],
  );

  useEffect(() => {
    if (!isInCall) {
      manualAudioRouteRef.current = null;
      return undefined;
    }

    applyAutomaticAudioRoute([]);
    return subscribeAudioDevices(nextDevices => {
      logInfo('[CallFlow] Audio devices changed', nextDevices);
      publishAudioDevices(nextDevices);
      const detached = describeDetachedManualRoute({
        manualRoute: manualAudioRouteRef.current,
        availableRoutes: nextDevices.available,
      });
      if (detached) {
        manualAudioRouteRef.current = null;
        updateStatus(detached.message);
      }
      applyAutomaticAudioRoute(nextDevices.available);
    });
  }, [applyAutomaticAudioRoute, isInCall, publishAudioDevices, updateStatus]);

  useEffect(() => {
    if (!isInCall || !isSpeakerEnabled) return;
    const result = setAudioRoute(true);
    if (!result.ok) {
      logWarn('[CallFlow] Audio route update failed', {
        message: result.message,
      });
    }
  }, [isInCall, isSpeakerEnabled]);

  const resetAudioRouting = useCallback(() => {
    publishAudioDevices({ available: [], selected: null });
  }, [publishAudioDevices]);

  return {
    audioDevices,
    chooseAudioOutput,
    handleMuteToggle,
    isSpeakerEnabled,
    resetAudioRouting,
  };
}
