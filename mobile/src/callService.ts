import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { logError, logInfo, logWarn } from './appLogger';

/** Native event emitted by `MainActivity.onPictureInPictureModeChanged`. */
const PIP_MODE_CHANGED_EVENT = 'CallService.pictureInPictureModeChanged';

/** Native event emitted when a control in the PiP window is tapped. */
const PIP_ACTION_EVENT = 'CallService.pictureInPictureAction';

/** Controls offered by the Picture-in-Picture window (see `MainActivity`). */
export type PictureInPictureControl = 'mute' | 'hangUp';

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
 */
export async function exitPictureInPicture(): Promise<boolean> {
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
 * @returns unsubscribe function
 */
export function subscribePictureInPictureMode(handler: (status: { isInPictureInPictureMode: boolean; dismissed: boolean; }) => void): () => void {
  const subscription = DeviceEventEmitter.addListener(PIP_MODE_CHANGED_EVENT, payload => {
    handler({
      isInPictureInPictureMode: Boolean(payload?.isInPictureInPictureMode),
      dismissed: Boolean(payload?.dismissed),
    });
  });
  return () => subscription.remove();
}

/**
 * Publish the current microphone state so the Picture-in-Picture window's mute
 * control shows the matching icon and label.
 *
 * A PiP window never receives touches on the app's own views, so its
 * system-drawn controls are the only in-PiP affordances there are — and a
 * control that says "Mute" while the mic is already muted is worse than none.
 *
 * @returns true when the state was handed to the native module.
 */
export function setPictureInPictureMuted(isMuted: boolean): boolean {
  const module = getNativeModule();
  if (!isCallServiceAvailable() || typeof module.setPictureInPictureMuted !== 'function') {
    return false;
  }

  try {
    module.setPictureInPictureMuted(Boolean(isMuted));
    return true;
  } catch (error) {
    logError('Failed to publish the Picture-in-Picture mute state', error);
    return false;
  }
}

/**
 * Subscribe to taps on the Picture-in-Picture window's controls.
 *
 * The handler receives the control that was tapped; unknown controls (an older
 * JS bundle paired with a newer binary) are dropped rather than guessed at.
 *
 * @returns unsubscribe function
 */
export function subscribePictureInPictureAction(handler: (control: PictureInPictureControl) => void): () => void {
  const subscription = DeviceEventEmitter.addListener(PIP_ACTION_EVENT, payload => {
    const control = payload?.control;
    if (control !== 'mute' && control !== 'hangUp') {
      logWarn('Ignoring unknown Picture-in-Picture control', { control });
      return;
    }
    handler(control);
  });
  return () => subscription.remove();
}
