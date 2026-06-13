import { NativeModules, Platform } from 'react-native';
import { logError, logInfo } from './appLogger';

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
