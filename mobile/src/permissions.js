import { PermissionsAndroid, Platform } from 'react-native';

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

function getRuntimePermissionDeniedMessage(permissions) {
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

async function getMissingPermissions(permissions) {
  const missing = [];

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
 * @returns {Promise<{
 *   camera: boolean,
 *   microphone: boolean,
 *   missing: string[],
 *   message: string | null,
 * }>} `missing` is empty when nothing is required or everything is granted.
 */
export async function getMissingCallPermissions() {
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

export async function ensureCallPermissions() {
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

  const results = await PermissionsAndroid.requestMultiple(missingPermissions);
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

export async function ensureBluetoothPermission({ requestIfNeeded = false } = {}) {
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
