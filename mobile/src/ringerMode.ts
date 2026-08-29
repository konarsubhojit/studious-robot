import { NativeModules, Platform } from 'react-native';
import { logWarn } from './appLogger';
import { errorMessage } from './errors';

/**
 * The device's current ringer setting, as the receiving side of a call sees it.
 *
 * An incoming call must respect the switch the user flicked: a phone on silent
 * stays quiet, a phone on vibrate buzzes without playing a ringtone, and only a
 * phone in its normal profile rings out loud.  Android exposes this through
 * `AudioManager.getRingerMode()`, which the first-party
 * `IncomingCallNotification` native module surfaces (see
 * `android/app/src/main/java/com/wetalk/IncomingCallNotificationModule.kt`).
 *
 * iOS has no equivalent readable API — the mute switch is deliberately not
 * exposed to apps — so the mode is reported as `null` ("unknown") there and
 * CallKit, which already honours the switch, owns the ringing instead.
 */
export const RINGER_MODES = {
  SILENT: 'silent',
  VIBRATE: 'vibrate',
  NORMAL: 'normal',
} as const;

export type RingerMode = (typeof RINGER_MODES)[keyof typeof RINGER_MODES];

const KNOWN_MODES: string[] = [RINGER_MODES.SILENT, RINGER_MODES.VIBRATE, RINGER_MODES.NORMAL];

function getNativeModule() {
  if (Platform.OS !== 'android') return null;
  return NativeModules?.IncomingCallNotification || null;
}

/**
 * Read the current ringer mode.
 *
 * @returns `null` when the platform (or the native module) cannot report it,
 *   which callers must treat as "no opinion" rather than as silent — refusing
 *   to ring on an unknown mode would drop calls silently.
 */
export async function getRingerMode(): Promise<RingerMode | null> {
  const module = getNativeModule();
  if (!module || typeof module.getRingerMode !== 'function') return null;

  try {
    const mode = await module.getRingerMode();
    return KNOWN_MODES.includes(mode) ? (mode as RingerMode) : null;
  } catch (error) {
    logWarn('[RingerMode] getRingerMode failed', { message: errorMessage(error) });
    return null;
  }
}

/**
 * Whether an incoming call may play an audible ringtone right now.
 *
 * Only an explicit silent/vibrate mode suppresses the sound; an unknown mode
 * rings, so a missing native module never makes calls inaudible.
 */
export async function shouldRingAudibly(): Promise<boolean> {
  const mode = await getRingerMode();
  return mode !== RINGER_MODES.SILENT && mode !== RINGER_MODES.VIBRATE;
}

/**
 * Whether an incoming call may vibrate right now.  Vibrate mode buzzes,
 * silent mode does not.
 */
export async function shouldVibrateForRing(): Promise<boolean> {
  return (await getRingerMode()) !== RINGER_MODES.SILENT;
}
