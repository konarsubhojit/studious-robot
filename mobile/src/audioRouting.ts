import { DeviceEventEmitter } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { logInfo, logWarn } from './appLogger';
import { setAudioSessionActive } from './audioSessionState';
import { ensureBluetoothPermission } from './permissions';

/**
 * @returns the error message, when there is one.
 */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/**
 * Canonical audio output routes understood by react-native-incall-manager's
 * `chooseAudioRoute`.  These string values must match the native
 * `AudioDevice` enum names exactly.
 */
export const AUDIO_ROUTES = {
  SPEAKER_PHONE: 'SPEAKER_PHONE',
  EARPIECE: 'EARPIECE',
  BLUETOOTH: 'BLUETOOTH',
  WIRED_HEADSET: 'WIRED_HEADSET',
};

/** Human-friendly labels for each route, shown in the output picker. */
export const AUDIO_ROUTE_LABELS = {
  [AUDIO_ROUTES.SPEAKER_PHONE]: 'Speaker',
  [AUDIO_ROUTES.EARPIECE]: 'Earpiece',
  [AUDIO_ROUTES.BLUETOOTH]: 'Bluetooth',
  [AUDIO_ROUTES.WIRED_HEADSET]: 'Wired headset',
};

/**
 * Preference order used whenever the route is picked automatically.
 *
 * External devices always win: a connected headset is an explicit signal that
 * the user does not want the loudspeaker, which is only chosen when nothing
 * else is available (or when the user picks it).
 */
export const AUDIO_ROUTE_PRIORITY = [
  AUDIO_ROUTES.BLUETOOTH,
  AUDIO_ROUTES.WIRED_HEADSET,
  AUDIO_ROUTES.EARPIECE,
  AUDIO_ROUTES.SPEAKER_PHONE,
];

const NATIVE_DEVICE_EVENT = 'onAudioDeviceChanged';

const GENERIC_AUDIO_SESSION_ERROR =
  'Unable to update in-call audio. Check app permissions in Settings and confirm the selected audio device is available.';
const AUDIO_ROUTE_FALLBACK_MESSAGE =
  'Requested audio route unavailable. Call will stay on speaker or earpiece.';

/**
 * Convert a route constant into a display label, falling back to the raw value
 * for any future/unknown device names.
 */
export function getAudioRouteLabel(route?: string): string {
  return (route && AUDIO_ROUTE_LABELS[route]) || route || 'Unknown';
}

/**
 * Start an in-call audio session.  Activates the audio focus, enables
 * proximity-sensor behaviour so the display dims when the handset is held to
 * the ear, and keeps the screen on throughout the call.
 *
 * This only catches errors that make it back across the JS bridge. Native
 * thread crashes (for example a manifest-missing SecurityException inside
 * WebRTC/InCallManager) must be prevented by manifest permissions; JS cannot
 * catch a SIGABRT or AndroidRuntime crash after the native thread aborts.
 *
 * @returns a failure
 *   always carries a user-facing message.
 */
export function startAudioSession(): { ok: true; } | { ok: false; error: unknown; message: string; } {
  try {
    InCallManager.start({ media: 'video' });
    InCallManager.setKeepScreenOn(true);
    // Chat media playback reads this so it never grabs the route from a live
    // call: the call flow owns the audio session, playback is the guest.
    setAudioSessionActive(true);
    return { ok: true };
  } catch (error) {
    return { ok: false, error, message: GENERIC_AUDIO_SESSION_ERROR };
  }
}

/**
 * Stop the in-call audio session.  Releases audio focus, deactivates the
 * proximity sensor override, and allows the screen to turn off normally.
 *
 * @returns a failure
 *   always carries a user-facing message.
 */
export function stopAudioSession(): { ok: true; } | { ok: false; error: unknown; message: string; } {
  setAudioSessionActive(false);
  try {
    InCallManager.setKeepScreenOn(false);
    InCallManager.stop();
    return { ok: true };
  } catch (error) {
    return { ok: false, error, message: GENERIC_AUDIO_SESSION_ERROR };
  }
}

/**
 * Switch the audio output route between loudspeaker and earpiece.
 *
 * When a Bluetooth audio device is paired and connected, `speakerEnabled=false`
 * will route through Bluetooth rather than the earpiece.
 *
 * @param speakerEnabled - `true` to route through the loudspeaker;
 *   `false` to route through the earpiece (or Bluetooth if available).
 */
export function setAudioRoute(speakerEnabled: boolean): { ok: boolean; selected: string | null; error?: unknown; message?: string; } {
  try {
    InCallManager.setForceSpeakerphoneOn(speakerEnabled);
    InCallManager.setSpeakerphoneOn(speakerEnabled);
    return {
      ok: true,
      selected: speakerEnabled ? AUDIO_ROUTES.SPEAKER_PHONE : AUDIO_ROUTES.EARPIECE,
    };
  } catch (error) {
    if (!speakerEnabled) {
      try {
        InCallManager.setForceSpeakerphoneOn(true);
        InCallManager.setSpeakerphoneOn(true);
      } catch (fallbackError) {
        logWarn('Audio route fallback to speaker failed', {
          message: errorMessage(fallbackError),
        });
      }
      return {
        ok: false,
        error,
        selected: AUDIO_ROUTES.SPEAKER_PHONE,
        message: AUDIO_ROUTE_FALLBACK_MESSAGE,
      };
    }

    return { ok: false, error, selected: null, message: GENERIC_AUDIO_SESSION_ERROR };
  }
}

/**
 * Normalise the audio-device status payload emitted by the native module (and
 * returned by `chooseAudioRoute`) into a predictable shape.
 *
 * The native side sends `availableAudioDeviceList` as a JSON-encoded string
 * (e.g. '["SPEAKER_PHONE","EARPIECE"]') and `selectedAudioDevice` as a plain
 * string ('' when none is selected).  This helper tolerates already-parsed
 * arrays, malformed JSON, and missing fields.
 */
export function parseAudioDeviceStatus(payload?: { availableAudioDeviceList?: unknown; selectedAudioDevice?: unknown; } | null): { available: string[]; selected: string | null; } {
  if (!payload || typeof payload !== 'object') {
    return { available: [], selected: null };
  }

  let available: unknown[] = [];
  const rawList = payload.availableAudioDeviceList;
  if (Array.isArray(rawList)) {
    available = rawList;
  } else if (typeof rawList === 'string' && rawList.length > 0) {
    try {
      const parsed = JSON.parse(rawList);
      if (Array.isArray(parsed)) {
        available = parsed;
      }
    } catch {
      available = [];
    }
  }

  // Keep only recognised, de-duplicated device names so the UI never renders
  // empty or "NONE" entries.
  const seen: Set<string> = new Set();
  available = available.filter(device => {
    if (typeof device !== 'string') {
      return false;
    }
    if (device === 'NONE' || seen.has(device)) {
      return false;
    }
    seen.add(device);
    return true;
  });

  const selected =
    typeof payload.selectedAudioDevice === 'string' && payload.selectedAudioDevice.length > 0
      ? payload.selectedAudioDevice
      : null;

  return { available: (available as string[]), selected };
}

/**
 * Explicitly route call audio to the given device.  Resolves with the updated
 * device status (available list + selected device) so callers can refresh UI.
 *
 * @param route - One of {@link AUDIO_ROUTES}.
 * @param options - when false, a failed
 *   Bluetooth selection is reported without forcing the loudspeaker, so the
 *   caller can try the next device in its own preference order.
 * @returns a failure always carries a user-facing message.
 */
export async function chooseAudioRoute(route: string, { fallbackToSpeaker = true }: { fallbackToSpeaker?: boolean; } = {}): Promise<{ available: string[]; selected: string | null; ok: true; } |
{
    available: string[];
    selected: string | null;
    ok: false;
    reason?: string;
    error?: unknown;
    message: string;
}> {
  if (route === AUDIO_ROUTES.BLUETOOTH) {
    const bluetoothPermission = await ensureBluetoothPermission({ requestIfNeeded: true });
    if (!bluetoothPermission.ok) {
      logWarn('Bluetooth permission denied; cannot route call audio to Bluetooth', {
        message: bluetoothPermission.message,
      });
      const fallback = fallbackToSpeaker ? setAudioRoute(true) : { selected: null };
      return {
        available: [AUDIO_ROUTES.SPEAKER_PHONE, AUDIO_ROUTES.EARPIECE],
        selected: fallbackToSpeaker ? fallback.selected || AUDIO_ROUTES.SPEAKER_PHONE : null,
        ok: false,
        reason: 'permission-denied',
        message: bluetoothPermission.message,
      };
    }
  }

  try {
    const result = await InCallManager.chooseAudioRoute(route);
    return { ...parseAudioDeviceStatus(result), ok: true };
  } catch (error) {
    if (route === AUDIO_ROUTES.BLUETOOTH && fallbackToSpeaker) {
      const fallback = setAudioRoute(true);
      return {
        available: [AUDIO_ROUTES.SPEAKER_PHONE, AUDIO_ROUTES.EARPIECE],
        selected: fallback.selected || AUDIO_ROUTES.SPEAKER_PHONE,
        ok: false,
        error,
        message: AUDIO_ROUTE_FALLBACK_MESSAGE,
      };
    }

    return {
      available: [],
      selected: null,
      ok: false,
      error,
      message: GENERIC_AUDIO_SESSION_ERROR,
    };
  }
}

/**
 * Highest-priority route among the currently available devices.
 *
 * Falls back to the earpiece (never the loudspeaker) when the device list is
 * empty or contains nothing recognised, which is what the native side reports
 * for a brief moment right after the audio session starts.
 *
 * @returns one of {@link AUDIO_ROUTES}
 */
export function selectPreferredAudioRoute(available: string[] = []): string {
  const devices = new Set(Array.isArray(available) ? available : []);
  return AUDIO_ROUTE_PRIORITY.find(route => devices.has(route)) ?? AUDIO_ROUTES.EARPIECE;
}

/**
 * Route call audio to the best available device.
 *
 * Walks {@link AUDIO_ROUTE_PRIORITY} downwards so a denied Bluetooth
 * permission (or a headset that disappears mid-switch) degrades to the wired
 * headset/earpiece instead of jumping to the loudspeaker.  Selecting
 * `BLUETOOTH` also starts the SCO link natively — simply having a device
 * connected does not route call audio to it.
 *
 * When the caller does not know the device list yet (call start), pass an
 * empty array: the first selection reports the available devices, and the
 * route is re-evaluated once against that freshly discovered list.
 *
 * @param available - devices reported by the native module.
 * @param options - internal recursion guard.
 * @returns the applied route; a failure always carries a user-facing message.
 */
export async function applyPreferredAudioRoute(available: string[] = [], { allowRediscovery = true }: { allowRediscovery?: boolean; } = {}): Promise<{ ok: true; selected: string; available: string[]; } |
{ ok: false; selected: string; available: string[]; message: string; }> {
  const devices = Array.isArray(available) ? available : [];
  const candidates = AUDIO_ROUTE_PRIORITY.filter(route => devices.includes(route));
  if (candidates.length === 0) {
    candidates.push(AUDIO_ROUTES.EARPIECE);
  }

  let lastMessage;
  for (const route of candidates) {
    const result = await chooseAudioRoute(route, { fallbackToSpeaker: false });
    if (result.ok) {
      const discovered = result.available.length > 0 ? result.available : devices;
      const preferred = selectPreferredAudioRoute(discovered);
      if (allowRediscovery && preferred !== route && discovered.includes(preferred)) {
        // The native module only reports the device list once a route has been
        // selected, so a better device may have shown up just now.
        return applyPreferredAudioRoute(discovered, { allowRediscovery: false });
      }
      logInfo('Audio routed to preferred device', { route, available: discovered });
      return { ok: true, selected: result.selected || route, available: discovered };
    }
    lastMessage = result.message;
    logWarn('Preferred audio route unavailable; trying next device', {
      route,
      message: result.message,
    });
  }

  return {
    ok: false,
    selected: AUDIO_ROUTES.SPEAKER_PHONE,
    available: devices,
    message: lastMessage || AUDIO_ROUTE_FALLBACK_MESSAGE,
  };
}

/**
 * Subscribe to native audio-device changes (headset plugged in, Bluetooth
 * connected/disconnected, route switched, …).
 *
 * @returns unsubscribe function
 */
export function subscribeAudioDevices(handler: (status: { available: string[]; selected: string | null; }) => void): () => void {
  const subscription = DeviceEventEmitter.addListener(NATIVE_DEVICE_EVENT, payload => {
    handler(parseAudioDeviceStatus(payload));
  });
  return () => subscription.remove();
}
