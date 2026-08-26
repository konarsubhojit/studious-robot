import { Platform } from 'react-native';
import { getCallRuntimePermissions } from './permissions';

/**
 * What the app is about to ask the OS for, and why — in the user's terms.
 *
 * The app requests camera, microphone, Bluetooth and notification access in
 * one burst the moment registration completes (`useStartupPermissions`), which
 * means a brand-new user's first experience is four system dialogs with no
 * context: Android's dialogs name the permission ("Allow WeTalk to take
 * pictures and record video?") but never the reason, and a permission denied
 * twice on Android 11+ is permanently denied — recoverable only from the OS
 * settings app, which the user has no reason to visit.
 *
 * So the reasons are stated first, in one screen, before any dialog appears.
 * This module owns only the copy and the list; it is deliberately free of React
 * and of any request logic, so both are testable without a renderer.
 */

export type PermissionPrimerItem = {
  /** Stable key — the Android permission string it explains. */
  key: string;
  /** Semantic `ICONS` key. */
  icon: string;
  title: string;
  /** Why the app needs it, phrased as the capability the user gets. */
  description: string;
  /**
   * Whether a call is impossible without it. Optional permissions degrade a
   * feature; required ones stop the app doing the thing it exists for.
   */
  required: boolean;
};

const PERMISSION_COPY: Record<string, Omit<PermissionPrimerItem, 'key'>> = {
  'android.permission.RECORD_AUDIO': {
    icon: 'micOn',
    title: 'Microphone',
    description: 'So the person you call can hear you. Without it, calls are one-way.',
    required: true,
  },
  'android.permission.CAMERA': {
    icon: 'videoOn',
    title: 'Camera',
    description: 'For video calls. Audio calls work without it.',
    required: true,
  },
  'android.permission.BLUETOOTH_CONNECT': {
    icon: 'permissionBluetooth',
    title: 'Nearby devices',
    description: 'To route call audio to your headset. Otherwise calls stay on the speaker.',
    required: false,
  },
  'android.permission.POST_NOTIFICATIONS': {
    icon: 'settingsNotifications',
    title: 'Notifications',
    description: 'To tell you about incoming calls and messages while the app is closed.',
    required: false,
  },
};

/**
 * The permissions this platform will actually be asked for, in the order they
 * are explained.
 *
 * Derived from `getCallRuntimePermissions` rather than hardcoded, so a
 * permission that the OS version does not require (Bluetooth below Android 12,
 * notifications below Android 13) is never explained — an explanation for a
 * dialog that will not appear is worse than no explanation.
 *
 * @param androidApiLevel Overridable for tests; defaults to the running OS.
 */
export function getPermissionPrimerItems(
  androidApiLevel: number | string = Platform.Version,
): PermissionPrimerItem[] {
  return getCallRuntimePermissions(androidApiLevel)
    .map(permission => {
      const copy = PERMISSION_COPY[(permission as string)];
      return copy ? { key: (permission as string), ...copy } : null;
    })
    .filter((item): item is PermissionPrimerItem => item !== null);
}

/**
 * Whether there is anything to explain on this platform at all.
 *
 * iOS asks for permissions lazily, at the moment of first use, with its own
 * purpose strings from `Info.plist` — so a primer there would be a screen that
 * precedes nothing.
 */
export function shouldShowPermissionPrimer(
  androidApiLevel: number | string = Platform.Version,
): boolean {
  return getPermissionPrimerItems(androidApiLevel).length > 0;
}
