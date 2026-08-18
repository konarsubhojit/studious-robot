import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { logError, logInfo } from './appLogger';

/** Native event emitted by `MainActivity.onPictureInPictureModeChanged`. */
const PIP_MODE_CHANGED_EVENT = 'CallService.pictureInPictureModeChanged';

function getNativeModule() {
  return NativeModules?.CallService || null;
}

export function isCallServiceAvailable() {
  return Platform.OS === 'android' && Boolean(getNativeModule());
}

export function startCallService() {
  const module = getNativeModule();
  if (!isCallServiceAvailable() || typeof module.startService !== 'function') {
    return false;
  }

  try {
    module.startService();
    logInfo('Foreground call service started');
    return true;
  } catch (error) {
    logError('Failed to start foreground call service', error);
    return false;
  }
}

export function stopCallService() {
  const module = getNativeModule();
  if (!isCallServiceAvailable() || typeof module.stopService !== 'function') {
    return false;
  }

  try {
    module.stopService();
    // A call that ends while the app is in Picture-in-Picture must take the PiP
    // window with it: stopping the service only disables *future* auto-enter,
    // so without this the window stays on screen showing the last decoded frame
    // of a stream whose peer connection is already closed.
    exitPictureInPicture();
    logInfo('Foreground call service stopped');
    return true;
  } catch (error) {
    logError('Failed to stop foreground call service', error);
    return false;
  }
}

export async function enterPictureInPicture() {
  const module = getNativeModule();
  if (!isCallServiceAvailable() || typeof module.enterPictureInPictureMode !== 'function') {
    return false;
  }

  try {
    const entered = await module.enterPictureInPictureMode();
    logInfo('Picture-in-Picture mode requested', { entered: Boolean(entered) });
    return Boolean(entered);
  } catch (error) {
    logError('Failed to enter Picture-in-Picture mode', error);
    return false;
  }
}

/**
 * Leave Picture-in-Picture mode, bringing the call screen back to full screen.
 *
 * Resolves `false` when the app is not in PiP (or on a platform without the
 * native module), so callers can invoke it unconditionally during teardown.
 *
 * @returns {Promise<boolean>}
 */
export async function exitPictureInPicture() {
  const module = getNativeModule();
  if (!isCallServiceAvailable() || typeof module.exitPictureInPictureMode !== 'function') {
    return false;
  }

  try {
    const exited = await module.exitPictureInPictureMode();
    logInfo('Picture-in-Picture exit requested', { exited: Boolean(exited) });
    return Boolean(exited);
  } catch (error) {
    logError('Failed to exit Picture-in-Picture mode', error);
    return false;
  }
}

/**
 * Subscribe to real Picture-in-Picture mode changes reported by the activity.
 *
 * The handler receives `{ isInPictureInPictureMode, dismissed }`, where
 * `dismissed` is true when PiP was left because the user closed the window.
 *
 * @param {(status: { isInPictureInPictureMode: boolean, dismissed: boolean }) => void} handler
 * @returns {() => void} unsubscribe function
 */
export function subscribePictureInPictureMode(handler) {
  const subscription = DeviceEventEmitter.addListener(PIP_MODE_CHANGED_EVENT, payload => {
    handler({
      isInPictureInPictureMode: Boolean(payload?.isInPictureInPictureMode),
      dismissed: Boolean(payload?.dismissed),
    });
  });
  return () => subscription.remove();
}
