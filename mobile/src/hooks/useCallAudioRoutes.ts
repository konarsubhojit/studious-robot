import { useCallback, useEffect, useRef, useState } from 'react';
import { logError, logInfo, logWarn } from '../appLogger';
import {
  applyPreferredAudioRoute,
  AUDIO_ROUTES,
  chooseAudioRoute,
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

type MutableRef<T> = { current: T };

/** The output devices offered in the call screen, and which one is live. */
export type AudioDevices = { available: any[]; selected: any };

export type UseCallAudioRoutesParams = {
  /** True only while a call is up; the audio session is scoped to this. */
  isInCall: boolean;
  /** Persisted "speaker on join" preference. */
  speakerEnabledByDefault: boolean;
  /** Surfaces routing failures and hand-overs. Must be referentially stable. */
  updateStatus: (message: string, severity?: 'error') => void;
};

export type CallAudioRoutes = {
  /** Whether the loudspeaker is the live output. */
  isSpeakerEnabled: boolean;
  /** The discovered output devices and the current selection. */
  audioDevices: AudioDevices;
  /**
   * Mirror of `audioDevices.selected`, so callbacks that restore the in-call
   * audio session (unmute, for one) can read the live route without taking the
   * device list as a dependency.
   */
  selectedAudioRouteRef: MutableRef<string | null>;
  /** Switch output to `route` by explicit user choice, pinning it for the call. */
  chooseAudioOutput: (route: string) => Promise<void>;
  /**
   * Clear the device list when a call ends. Stable for the lifetime of the
   * hook, so callers may keep empty dependency arrays.
   */
  resetAudioDevices: () => void;
};

/**
 * Owns in-call audio output: the `InCallManager` audio session, automatic
 * route selection, the device-change subscription and the manual override.
 *
 * Each of the three effects here is self-contained. The audio session is
 * started and stopped by the same effect; the device subscription's
 * unsubscriber *is* that effect's cleanup return; the speaker-apply effect
 * holds no resource at all. Nothing this hook creates is torn down elsewhere,
 * and `useCallFlow`'s aggregate unmount teardown needs no entry for it.
 *
 * Deliberately *not* here: muting. `handleMuteToggle` looks like an audio
 * concern but manipulates the local `MediaStream`'s tracks, so it stays with
 * the code that owns that stream. It reads the live route through
 * `selectedAudioRouteRef`, which this hook returns.
 *
 * @param params
 */
export default function useCallAudioRoutes({
  isInCall,
  speakerEnabledByDefault,
  updateStatus,
}: UseCallAudioRoutesParams): CallAudioRoutes {
  const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(false);
  // The output the user picked by hand, if any. Set for the duration of a call
  // so automatic routing does not undo an explicit choice.
  const manualAudioRouteRef = useRef((null as string | null));
  const [audioDevices, setAudioDevices] = useState<AudioDevices>({
    available: [],
    selected: null,
  });
  // Mirrors the selected audio output so callbacks can re-apply it without
  // being re-created every time the device list changes.
  const selectedAudioRouteRef = useRef((null as string | null));

  useEffect(() => {
    selectedAudioRouteRef.current = audioDevices.selected;
  }, [audioDevices.selected]);

  const resetAudioDevices = useCallback(() => {
    setAudioDevices({ available: [], selected: null });
  }, []);

  const chooseAudioOutput = useCallback(
    /** @param route */
    async (route: string) => {
      try {
        manualAudioRouteRef.current = route;
        const result = await chooseAudioRoute(route);
        if (!result.ok) {
          setAudioDevices({
            available: result.available,
            selected: result.selected,
          });
          setIsSpeakerEnabled(result.selected === AUDIO_ROUTES.SPEAKER_PHONE);
          updateStatus(result.message, 'error');
          return;
        }
        setAudioDevices({
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
    [updateStatus],
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

  // Pick the best available output (Bluetooth → wired → earpiece → speaker)
  // unless the user already chose one explicitly during this call.
  const applyAutomaticAudioRoute = useCallback(
    /** @param available */
    async (available: string[]) => {
      if (manualAudioRouteRef.current) return;
      const result = await applyPreferredAudioRoute(available);
      // "Speaker on join": with no headset/Bluetooth device attached the
      // automatic pick is the earpiece; the persisted preference upgrades
      // that to speakerphone.
      if (
        shouldUpgradeToSpeaker({
          routed: result.ok,
          selected: result.selected,
          speakerEnabledByDefault,
        })
      ) {
        const speakerResult = await chooseAudioRoute(AUDIO_ROUTES.SPEAKER_PHONE);
        if (speakerResult.ok) {
          setAudioDevices({
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
      setAudioDevices({ available: result.available, selected: result.selected });
      setIsSpeakerEnabled(result.selected === AUDIO_ROUTES.SPEAKER_PHONE);
      if (!result.ok) {
        logWarn('[CallFlow] Automatic audio routing degraded', {
          message: result.message,
        });
      }
    },
    [speakerEnabledByDefault],
  );

  useEffect(() => {
    if (!isInCall) {
      manualAudioRouteRef.current = null;
      return undefined;
    }

    // The device list is discovered by the first selection (see
    // applyPreferredAudioRoute), so no list is needed here.
    applyAutomaticAudioRoute([]);
    // Re-evaluate whenever a device is plugged in or removed mid-call.
    return subscribeAudioDevices(nextDevices => {
      logInfo('[CallFlow] Audio devices changed', nextDevices);
      setAudioDevices(nextDevices);
      // A *detachable* device the user picked by hand can vanish mid-call (a
      // headset runs out of battery, a cable is pulled). The automatic route
      // silently takes over below, which is right — but the hand-over is
      // announced and the manual choice released.
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
  }, [applyAutomaticAudioRoute, isInCall, updateStatus]);

  useEffect(() => {
    if (!isInCall || !isSpeakerEnabled) return;
    const result = setAudioRoute(true);
    if (!result.ok) {
      logWarn('[CallFlow] Audio route update failed', {
        message: result.message,
      });
    }
  }, [isInCall, isSpeakerEnabled]);

  return {
    isSpeakerEnabled,
    audioDevices,
    selectedAudioRouteRef,
    chooseAudioOutput,
    resetAudioDevices,
  };
}
