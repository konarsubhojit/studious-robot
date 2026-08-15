import { DeviceEventEmitter } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { logWarn } from './appLogger';
import { ensureBluetoothPermission } from './permissions';

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

const NATIVE_DEVICE_EVENT = 'onAudioDeviceChanged';
const GENERIC_AUDIO_SESSION_ERROR =
  'Unable to update in-call audio. Check app permissions in Settings and confirm the selected audio device is available.';
const AUDIO_ROUTE_FALLBACK_MESSAGE =
  'Requested audio route unavailable. Call will stay on speaker or earpiece.';

/**
 * Convert a route constant into a display label, falling back to the raw value
 * for any future/unknown device names.
 *
 * @param {string} route
 * @returns {string}
 */
export function getAudioRouteLabel(route) {
  return AUDIO_ROUTE_LABELS[route] || route || 'Unknown';
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
 */
export function startAudioSession() {
  try {
    InCallManager.start({ media: 'video' });
    InCallManager.setKeepScreenOn(true);
    return { ok: true };
  } catch (error) {
    return { ok: false, error, message: GENERIC_AUDIO_SESSION_ERROR };
  }
}

/**
 * Stop the in-call audio session.  Releases audio focus, deactivates the
 * proximity sensor override, and allows the screen to turn off normally.
 */
export function stopAudioSession() {
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
 * @param {boolean} speakerEnabled - `true` to route through the loudspeaker;
 *   `false` to route through the earpiece (or Bluetooth if available).
 */
export function setAudioRoute(speakerEnabled) {
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
        logWarn('Audio route fallback to speaker failed', { message: fallbackError?.message });
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
 *
 * @param {object} [payload]
 * @returns {{ available: string[], selected: string|null }}
 */
export function parseAudioDeviceStatus(payload) {
  if (!payload || typeof payload !== 'object') {
    return { available: [], selected: null };
  }

  let available = [];
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
  const seen = new Set();
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

  return { available, selected };
}

/**
 * Explicitly route call audio to the given device.  Resolves with the updated
 * device status (available list + selected device) so callers can refresh UI.
 *
 * @param {string} route - One of {@link AUDIO_ROUTES}.
 * @returns {Promise<{ available: string[], selected: string|null }>}
 */
export async function chooseAudioRoute(route) {
  if (route === AUDIO_ROUTES.BLUETOOTH) {
    const bluetoothPermission = await ensureBluetoothPermission({ requestIfNeeded: true });
    if (!bluetoothPermission.ok) {
      const fallback = setAudioRoute(true);
      return {
        available: [AUDIO_ROUTES.SPEAKER_PHONE, AUDIO_ROUTES.EARPIECE],
        selected: fallback.selected || AUDIO_ROUTES.SPEAKER_PHONE,
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
    if (route === AUDIO_ROUTES.BLUETOOTH) {
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
 * Subscribe to native audio-device changes (headset plugged in, Bluetooth
 * connected/disconnected, route switched, …).
 *
 * @param {(status: { available: string[], selected: string|null }) => void} handler
 * @returns {() => void} unsubscribe function
 */
export function subscribeAudioDevices(handler) {
  const subscription = DeviceEventEmitter.addListener(NATIVE_DEVICE_EVENT, payload => {
    handler(parseAudioDeviceStatus(payload));
  });
  return () => subscription.remove();
}
