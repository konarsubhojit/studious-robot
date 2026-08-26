import { PermissionsAndroid, Platform } from 'react-native';
import type { Permission } from 'react-native';

export type { Permission };

const CAMERA_PERMISSION = PermissionsAndroid?.PERMISSIONS?.CAMERA;
const MICROPHONE_PERMISSION = PermissionsAndroid?.PERMISSIONS?.RECORD_AUDIO;
const BLUETOOTH_CONNECT_PERMISSION = PermissionsAndroid?.PERMISSIONS?.BLUETOOTH_CONNECT;
// Android 13+ (API 33) requires runtime consent to post any notification,
// including the branded incoming-call notification (IncomingCallNotificationModule)
// and ordinary chat push notifications. Not requested automatically by any
// native module used here, so it is requested alongside the other runtime
// permissions rather than left until the OS silently drops notifications.
const POST_NOTIFICATIONS_PERMISSION = PermissionsAndroid?.PERMISSIONS?.POST_NOTIFICATIONS;

const REQUIRED_CALL_PERMISSIONS = [CAMERA_PERMISSION, MICROPHONE_PERMISSION].filter(Boolean);

export function requiresBluetoothConnectPermission(androidApiLevel = Platform.Version) {
  return (
    Platform.OS === 'android' &&
    Number(androidApiLevel) >= 31 &&
    Boolean(BLUETOOTH_CONNECT_PERMISSION)
  );
}

export function requiresPostNotificationsPermission(androidApiLevel = Platform.Version) {
  return (
    Platform.OS === 'android' &&
    Number(androidApiLevel) >= 33 &&
    Boolean(POST_NOTIFICATIONS_PERMISSION)
  );
}

export function getCallRuntimePermissions(androidApiLevel = Platform.Version) {
  if (Platform.OS !== 'android') {
    return [];
  }

  const permissions = [...REQUIRED_CALL_PERMISSIONS];
  if (requiresBluetoothConnectPermission(androidApiLevel)) {
    permissions.push(BLUETOOTH_CONNECT_PERMISSION);
  }
  if (requiresPostNotificationsPermission(androidApiLevel)) {
    permissions.push(POST_NOTIFICATIONS_PERMISSION);
  }
  return permissions;
}

function getRuntimePermissionDeniedMessage(permissions: Permission[]): string {
  const denied = new Set(permissions);
  const deniedCamera = denied.has(CAMERA_PERMISSION);
  const deniedMicrophone = denied.has(MICROPHONE_PERMISSION);
  const deniedBluetooth = denied.has(BLUETOOTH_CONNECT_PERMISSION);
  const deniedNotifications = denied.has(POST_NOTIFICATIONS_PERMISSION);

  if (deniedCamera && deniedMicrophone) {
    return 'Camera and microphone permissions are required to start a call';
  }
  if (deniedCamera) {
    return 'Camera permission is required to start a call';
  }
  if (deniedMicrophone) {
    return 'Microphone permission is required to start a call';
  }
  if (deniedBluetooth) {
    return 'Bluetooth permission denied. Call will stay on speaker or earpiece.';
  }
  if (deniedNotifications) {
    return 'Notification permission denied. You may miss incoming call and message alerts — enable it from Settings to fix this.';
  }
  return 'Required Android permissions are missing';
}

async function getMissingPermissions(permissions: Permission[]): Promise<Permission[]> {
  const missing: Permission[] = [];

  for (const permission of permissions) {
    if (!permission) {
      continue;
    }

    const granted = await PermissionsAndroid.check(permission);
    if (!granted) {
      missing.push(permission);
    }
  }

  return missing;
}

/**
 * Report which *required* call permissions (camera / microphone) are missing,
 * without prompting for them.
 *
 * Answering a call from a push cold start happens with no foreground Activity,
 * so a runtime prompt cannot be shown; the answer path uses this to name the
 * missing permission in logs and in the user-visible status instead of failing
 * silently inside `getUserMedia`.
 *
 * @returns `missing` is empty when nothing is required or everything is granted.
 */
export async function getMissingCallPermissions(): Promise<{
    camera: boolean;
    microphone: boolean;
    missing: string[];
    message: string | null;
}> {
  if (Platform.OS !== 'android' || !PermissionsAndroid?.check) {
    return { camera: false, microphone: false, missing: [], message: null };
  }

  const missing = await getMissingPermissions(REQUIRED_CALL_PERMISSIONS);
  return {
    camera: missing.includes(CAMERA_PERMISSION),
    microphone: missing.includes(MICROPHONE_PERMISSION),
    missing,
    message: missing.length > 0 ? getRuntimePermissionDeniedMessage(missing) : null,
  };
}

/**
 * Report every runtime permission — required and optional — that has not been
 * granted, without prompting for any of them.
 *
 * `getMissingCallPermissions` deliberately narrows to camera and microphone
 * because it answers "can this call proceed?". The first-run primer asks a
 * different question — "is there anything left to explain?" — and must include
 * the optional ones (Bluetooth routing, notifications) it is about to request.
 */
export async function getMissingRuntimePermissions(): Promise<string[]> {
  if (Platform.OS !== 'android' || !PermissionsAndroid?.check) {
    return [];
  }
  return getMissingPermissions(getCallRuntimePermissions());
}

/**
 * Request the runtime permissions a call needs.
 *
 * @returns a denial always carries a user-facing message.
 */
export async function ensureCallPermissions(): Promise<{ ok: true; warningMessage: string | null; deniedPermissions: string[]; } |
{ ok: false; message: string; warningMessage: null; deniedPermissions: string[]; }> {
  if (
    Platform.OS !== 'android' ||
    !PermissionsAndroid?.check ||
    !PermissionsAndroid?.requestMultiple
  ) {
    return { ok: true, warningMessage: null, deniedPermissions: [] };
  }

  // ACCESS_NETWORK_STATE, WAKE_LOCK, INTERNET, MODIFY_AUDIO_SETTINGS, and the
  // foreground-service permissions are normal/install-time permissions. Android
  // does not expose them via PermissionsAndroid, so the manifest declarations
  // are the real fix for native-thread SecurityExceptions from WebRTC/InCall.
  const permissions = getCallRuntimePermissions();
  const missingPermissions = await getMissingPermissions(permissions);

  if (missingPermissions.length === 0) {
    return { ok: true, warningMessage: null, deniedPermissions: [] };
  }

  const results = (await PermissionsAndroid.requestMultiple(missingPermissions) as Record<string, string>);
  const deniedRequiredPermissions = missingPermissions.filter(
    permission =>
      REQUIRED_CALL_PERMISSIONS.includes(permission) &&
      results[permission] !== PermissionsAndroid.RESULTS.GRANTED,
  );
  const deniedOptionalPermissions = missingPermissions.filter(
    permission =>
      !REQUIRED_CALL_PERMISSIONS.includes(permission) &&
      results[permission] !== PermissionsAndroid.RESULTS.GRANTED,
  );

  if (deniedRequiredPermissions.length > 0) {
    return {
      ok: false,
      deniedPermissions: deniedRequiredPermissions,
      message: getRuntimePermissionDeniedMessage(deniedRequiredPermissions),
      warningMessage: null,
    };
  }

  return {
    ok: true,
    deniedPermissions: deniedOptionalPermissions,
    warningMessage:
      deniedOptionalPermissions.length > 0
        ? getRuntimePermissionDeniedMessage(deniedOptionalPermissions)
        : null,
  };
}

/**
 * Check — and optionally request — the runtime permission Bluetooth call audio
 * needs on Android 12+.
 *
 * @returns a denial always carries a user-facing message.
 */
export async function ensureBluetoothPermission({ requestIfNeeded = false }: { requestIfNeeded?: boolean; } = {}): Promise<{ ok: true; granted: true; requested: boolean; } |
{ ok: false; granted: false; requested: boolean; message: string; }> {
  if (
    Platform.OS !== 'android' ||
    !requiresBluetoothConnectPermission() ||
    !PermissionsAndroid?.check ||
    !PermissionsAndroid?.requestMultiple
  ) {
    return { ok: true, granted: true, requested: false };
  }

  const granted = await PermissionsAndroid.check(BLUETOOTH_CONNECT_PERMISSION);
  if (granted) {
    return { ok: true, granted: true, requested: false };
  }

  if (!requestIfNeeded) {
    return {
      ok: false,
      granted: false,
      requested: false,
      message: getRuntimePermissionDeniedMessage([BLUETOOTH_CONNECT_PERMISSION]),
    };
  }

  const results = await PermissionsAndroid.requestMultiple([BLUETOOTH_CONNECT_PERMISSION]);
  if (results[BLUETOOTH_CONNECT_PERMISSION] === PermissionsAndroid.RESULTS.GRANTED) {
    return { ok: true, granted: true, requested: true };
  }

  return {
    ok: false,
    granted: false,
    requested: true,
    message: getRuntimePermissionDeniedMessage([BLUETOOTH_CONNECT_PERMISSION]),
  };
}

// ─── Attachment (photo / camera / voice) permissions ──────────────────────

const MEDIA_IMAGES_PERMISSION = PermissionsAndroid?.PERMISSIONS?.READ_MEDIA_IMAGES;
const READ_EXTERNAL_STORAGE_PERMISSION = PermissionsAndroid?.PERMISSIONS?.READ_EXTERNAL_STORAGE;

/**
 * The runtime permission that gates reading the photo library, which changed
 * name (and scope) in Android 13 (API 33): `READ_MEDIA_IMAGES` replaced the
 * broader `READ_EXTERNAL_STORAGE` for image access.
 *
 * @returns `undefined` on iOS (handled by Info.plist,
 *   not `PermissionsAndroid`) or when neither permission constant exists.
 */
export function getPhotoLibraryPermission(androidApiLevel: number | string = Platform.Version): Permission | undefined {
  if (Platform.OS !== 'android') return undefined;
  return Number(androidApiLevel) >= 33 ? MEDIA_IMAGES_PERMISSION : READ_EXTERNAL_STORAGE_PERMISSION;
}

const WRITE_EXTERNAL_STORAGE_PERMISSION = PermissionsAndroid?.PERMISSIONS?.WRITE_EXTERNAL_STORAGE;

/**
 * Whether writing into the shared Downloads folder still needs a runtime
 * grant. Android 10 (API 29) introduced scoped storage, where an app writes
 * its own downloads without any permission at all, so only API 28 and below
 * prompt.
 */
export function requiresDownloadStoragePermission(androidApiLevel: number | string = Platform.Version): boolean {
  return (
    Platform.OS === 'android' &&
    Number(androidApiLevel) <= 28 &&
    Boolean(WRITE_EXTERNAL_STORAGE_PERMISSION)
  );
}

/**
 * Ensure the runtime permission needed to save a downloaded attachment into
 * the shared Downloads folder is granted, requesting it if not.
 *
 * A denial is not fatal: the caller falls back to app-private storage, so this
 * reports the outcome rather than throwing.
 */
export async function ensureDownloadPermission({ androidApiLevel = Platform.Version }: { androidApiLevel?: number | string; } = {}): Promise<{ ok: boolean; granted: boolean; message?: string | null; }> {
  if (
    !requiresDownloadStoragePermission(androidApiLevel) ||
    !PermissionsAndroid?.check ||
    !PermissionsAndroid?.requestMultiple
  ) {
    return { ok: true, granted: true, message: null };
  }

  const alreadyGranted = await PermissionsAndroid.check(WRITE_EXTERNAL_STORAGE_PERMISSION);
  if (alreadyGranted) return { ok: true, granted: true, message: null };

  const results = (await PermissionsAndroid.requestMultiple([
    WRITE_EXTERNAL_STORAGE_PERMISSION,
  ]) as Record<string, string>);
  const granted = results[WRITE_EXTERNAL_STORAGE_PERMISSION] === PermissionsAndroid.RESULTS.GRANTED;
  return {
    ok: granted,
    granted,
    message: granted
      ? null
      : 'Storage permission denied. The attachment will be saved inside the app instead.',
  };
}

/**
 * User-facing text for a denied attachment permission.
 */
function getAttachmentPermissionDeniedMessage(kind: string): string {
  if (kind === 'photo') return 'Photo library permission is required to attach a photo';
  if (kind === 'camera') return 'Camera permission is required to take a photo';
  if (kind === 'voice') return 'Microphone permission is required to record a voice note';
  return 'Required permission is missing';
}

/**
 * The Android runtime permission constant `ensureAttachmentPermission` needs to
 * check/request for `kind`.
 */
function attachmentPermissionFor(kind: string, androidApiLevel?: number | string): Permission | undefined {
  if (kind === 'photo') return getPhotoLibraryPermission(androidApiLevel);
  if (kind === 'camera') return CAMERA_PERMISSION;
  if (kind === 'voice') return MICROPHONE_PERMISSION;
  return undefined;
}

/**
 * Ensure the runtime permission needed to attach a photo, take a camera
 * photo, or record a voice note is granted, requesting it if not.
 *
 * The file picker (`kind: 'file'`) needs no runtime grant on Android — it
 * goes through the Storage Access Framework, which is scoped per pick — so
 * it always resolves `ok: true` without prompting.
 */
export async function ensureAttachmentPermission(
  kind: 'photo' | 'camera' | 'voice' | 'file',
  { androidApiLevel = Platform.Version }: { androidApiLevel?: number | string; } = {},
): Promise<{ ok: boolean; granted: boolean; message?: string | null; }> {
  if (
    Platform.OS !== 'android' ||
    kind === 'file' ||
    !PermissionsAndroid?.check ||
    !PermissionsAndroid?.requestMultiple
  ) {
    return { ok: true, granted: true, message: null };
  }

  const permission = attachmentPermissionFor(kind, androidApiLevel);
  if (!permission) return { ok: true, granted: true, message: null };

  const alreadyGranted = await PermissionsAndroid.check(permission);
  if (alreadyGranted) return { ok: true, granted: true, message: null };

  const results = (await PermissionsAndroid.requestMultiple([permission]) as Record<string, string>);
  const granted = results[permission] === PermissionsAndroid.RESULTS.GRANTED;
  return {
    ok: granted,
    granted,
    message: granted ? null : getAttachmentPermissionDeniedMessage(kind),
  };
}
