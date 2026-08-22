import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import {
  enterPictureInPicture,
  exitPictureInPicture,
  isCallServiceAvailable,
  startCallService,
  stopCallService,
  subscribePictureInPictureMode,
} from '../src/callService';

const originalPlatform = Platform.OS;

function setCallServiceModule(module: any) {
  if (module === null) {
    delete NativeModules.CallService;
  } else {
    NativeModules.CallService = module;
  }
}

describe('callService', () => {
  afterEach(() => {
    Platform.OS = originalPlatform;
    setCallServiceModule(null);
    jest.clearAllMocks();
  });

  test('reports unavailable when native module is missing', () => {
    Platform.OS = 'android';
    setCallServiceModule(null);
    expect(isCallServiceAvailable()).toBe(false);
    expect(startCallService()).toBe(false);
    expect(stopCallService()).toBe(false);
  });

  test('is a no-op on non-Android platforms', () => {
    Platform.OS = 'ios';
    const startService = jest.fn();
    setCallServiceModule({ startService });
    expect(isCallServiceAvailable()).toBe(false);
    expect(startCallService()).toBe(false);
    expect(startService).not.toHaveBeenCalled();
  });

  test('starts and stops the foreground service on Android', () => {
    Platform.OS = 'android';
    const startService = jest.fn();
    const stopService = jest.fn();
    setCallServiceModule({ startService, stopService });

    expect(isCallServiceAvailable()).toBe(true);
    expect(startCallService()).toBe(true);
    expect(startService).toHaveBeenCalledTimes(1);
    expect(stopCallService()).toBe(true);
    expect(stopService).toHaveBeenCalledTimes(1);
  });

  test('startCallService returns false and swallows native errors', () => {
    Platform.OS = 'android';
    const startService = jest.fn(() => {
      throw new Error('boom');
    });
    setCallServiceModule({ startService });
    expect(startCallService()).toBe(false);
  });

  test('enterPictureInPicture resolves to the native result', async () => {
    Platform.OS = 'android';
    const enterPictureInPictureMode = jest.fn().mockResolvedValue(true);
    setCallServiceModule({ enterPictureInPictureMode });

    await expect(enterPictureInPicture()).resolves.toBe(true);
    expect(enterPictureInPictureMode).toHaveBeenCalledTimes(1);
  });

  test('enterPictureInPicture resolves false when unavailable', async () => {
    Platform.OS = 'ios';
    setCallServiceModule(null);
    await expect(enterPictureInPicture()).resolves.toBe(false);
  });

  test('stopCallService also leaves Picture-in-Picture so no frozen frame remains', () => {
    Platform.OS = 'android';
    const stopService = jest.fn();
    const exitPictureInPictureMode = jest.fn().mockResolvedValue(true);
    setCallServiceModule({ stopService, exitPictureInPictureMode });

    expect(stopCallService()).toBe(true);
    expect(exitPictureInPictureMode).toHaveBeenCalledTimes(1);
  });

  test('exitPictureInPicture resolves to the native result', async () => {
    Platform.OS = 'android';
    const exitPictureInPictureMode = jest.fn().mockResolvedValue(true);
    setCallServiceModule({ exitPictureInPictureMode });

    await expect(exitPictureInPicture()).resolves.toBe(true);
    expect(exitPictureInPictureMode).toHaveBeenCalledTimes(1);
  });

  test('exitPictureInPicture resolves false when the native module is missing', async () => {
    Platform.OS = 'android';
    setCallServiceModule(null);
    await expect(exitPictureInPicture()).resolves.toBe(false);
  });

  test('exitPictureInPicture swallows native errors', async () => {
    Platform.OS = 'android';
    setCallServiceModule({
      exitPictureInPictureMode: jest.fn(() => Promise.reject(new Error('boom'))),
    });
    await expect(exitPictureInPicture()).resolves.toBe(false);
  });

  test('subscribePictureInPictureMode forwards native mode changes', () => {
    const handler = jest.fn();
    const unsubscribe = subscribePictureInPictureMode(handler);

    DeviceEventEmitter.emit('CallService.pictureInPictureModeChanged', {
      isInPictureInPictureMode: false,
      dismissed: true,
    });
    expect(handler).toHaveBeenCalledWith({
      isInPictureInPictureMode: false,
      dismissed: true,
    });

    unsubscribe();
    DeviceEventEmitter.emit('CallService.pictureInPictureModeChanged', {
      isInPictureInPictureMode: true,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
