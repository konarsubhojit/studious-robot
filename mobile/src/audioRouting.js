import { DeviceEventEmitter } from 'react-native';
import InCallManager from 'react-native-incall-manager';

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
 */
export function startAudioSession() {
  InCallManager.start({ media: 'video' });
  InCallManager.setKeepScreenOn(true);
}

/**
 * Stop the in-call audio session.  Releases audio focus, deactivates the
 * proximity sensor override, and allows the screen to turn off normally.
 */
export function stopAudioSession() {
  InCallManager.setKeepScreenOn(false);
  InCallManager.stop();
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
  InCallManager.setForceSpeakerphoneOn(speakerEnabled);
  InCallManager.setSpeakerphoneOn(speakerEnabled);
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
  available = available.filter((device) => {
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
  const result = await InCallManager.chooseAudioRoute(route);
  return parseAudioDeviceStatus(result);
}

/**
 * Subscribe to native audio-device changes (headset plugged in, Bluetooth
 * connected/disconnected, route switched, …).
 *
 * @param {(status: { available: string[], selected: string|null }) => void} handler
 * @returns {() => void} unsubscribe function
 */
export function subscribeAudioDevices(handler) {
  const subscription = DeviceEventEmitter.addListener(NATIVE_DEVICE_EVENT, (payload) => {
    handler(parseAudioDeviceStatus(payload));
  });
  return () => subscription.remove();
}
