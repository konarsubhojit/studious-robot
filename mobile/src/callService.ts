import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { logError, logInfo, logVerbose, logWarn } from './appLogger';

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

/**
 * How long an explicit Picture-in-Picture request suppresses the next one.
 *
 * A single backgrounding used to fire two requests ~200 ms apart (one per
 * AppState transition), so the second could only ever be refused — and each
 * refusal was logged as if it said something new about the call.
 */
const PIP_REQUEST_DEDUPE_MS = 1000;

let lastPictureInPictureRequestAt = 0;

/** Forget the last request time, so a new call is never throttled by an old one. */
export function resetPictureInPictureRequestThrottle() {
  lastPictureInPictureRequestAt = 0;
}

/**
 * Ask the activity to enter Picture-in-Picture.
 *
 * Android only grants PiP while the activity is still resumed, so the app
 * relies primarily on the native user-leave path (`onUserLeaveHint`, plus
 * Android 12+ auto-enter). This explicit request stays available for callers
 * that know the activity is still in the foreground; the native side reports
 * the reason rather than throwing when it is not.
 */
export async function enterPictureInPicture() {
  const module = getNativeModule();
  if (!isCallServiceAvailable() || typeof module.enterPictureInPictureMode !== 'function') {
    logWarn('Picture-in-Picture request skipped', { reason: 'unsupported' });
    return false;
  }

  const now = Date.now();
  if (now - lastPictureInPictureRequestAt < PIP_REQUEST_DEDUPE_MS) {
    logWarn('Picture-in-Picture request skipped', {
      reason: 'duplicate-request',
      sinceLastRequestMs: now - lastPictureInPictureRequestAt,
    });
    return false;
  }
  lastPictureInPictureRequestAt = now;

  try {
    const entered = await module.enterPictureInPictureMode();
    if (entered) {
      logInfo('Picture-in-Picture mode entered');
    } else {
      // The activity declined (not resumed, OEM restriction, or PiP turned
      // off in settings) and named the reason in the native log. The call
      // keeps running, just without a window.
      logWarn('Picture-in-Picture mode was refused by the activity');
    }
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
    if (exited) {
      logInfo('Picture-in-Picture mode exited');
    } else {
      // Teardown calls this unconditionally, so "we were not in PiP" is the
      // common case and says nothing about the call — INFO here just buries
      // the lines that matter in the exported log.
      logVerbose('Picture-in-Picture exit skipped; not in Picture-in-Picture');
    }
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
