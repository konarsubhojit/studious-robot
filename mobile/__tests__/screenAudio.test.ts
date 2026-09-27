import { NativeModules, Platform } from 'react-native';
import {
  applyMicrophoneMute,
  getSystemAudioStatus,
  isMicrophoneMuted,
  isSystemAudioSharing,
  isSystemAudioSupported,
  recordMicrophoneMute,
  resetSystemAudioState,
  startSystemAudio,
  stopSystemAudio,
} from '../src/screenAudio';

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

const { logWarn } = require('../src/appLogger');

const originalPlatform = Platform.OS;

type NativeStatus = Record<string, unknown>;

function capturing(overrides: NativeStatus = {}): NativeStatus {
  return {
    installed: true,
    state: 'CAPTURING',
    sharing: true,
    mixedFrames: 120,
    bytesCaptured: 184_320,
    bufferOverflows: 0,
    ...overrides,
  };
}

function makeNativeModule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    start: jest.fn().mockResolvedValue(capturing()),
    stop: jest.fn().mockResolvedValue({ installed: true, state: 'IDLE', sharing: false }),
    getStatus: jest.fn().mockResolvedValue(capturing()),
    setMicrophoneMuted: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function installNativeModule(module: unknown) {
  if (module === null) {
    delete (NativeModules as Record<string, unknown>).ScreenAudio;
    return;
  }
  (NativeModules as Record<string, unknown>).ScreenAudio = module;
}

describe('screenAudio', () => {
  beforeEach(() => {
    Platform.OS = 'android';
    resetSystemAudioState();
    jest.clearAllMocks();
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    installNativeModule(null);
  });

  describe('isSystemAudioSupported', () => {
    it('is false without the native module', () => {
      installNativeModule(null);
      expect(isSystemAudioSupported()).toBe(false);
    });

    it('is false on iOS even when a module is registered', () => {
      installNativeModule(makeNativeModule());
      Platform.OS = 'ios';
      expect(isSystemAudioSupported()).toBe(false);
    });

    it('rejects a module that does not implement the whole contract', () => {
      installNativeModule({ start: jest.fn() });
      expect(isSystemAudioSupported()).toBe(false);
    });

    it('is true for a complete Android module', () => {
      installNativeModule(makeNativeModule());
      expect(isSystemAudioSupported()).toBe(true);
    });
  });

  describe('startSystemAudio', () => {
    it('reports unavailable without the native module', async () => {
      installNativeModule(null);
      await expect(startSystemAudio()).resolves.toMatchObject({
        installed: false,
        state: 'unavailable',
        sharing: false,
      });
      expect(isSystemAudioSharing()).toBe(false);
    });

    it('maps the native status onto the JS shape', async () => {
      installNativeModule(makeNativeModule());
      await expect(startSystemAudio()).resolves.toEqual({
        installed: true,
        state: 'capturing',
        reason: undefined,
        sharing: true,
        mixedFrames: 120,
        bytesCaptured: 184_320,
        bufferOverflows: 0,
      });
      expect(isSystemAudioSharing()).toBe(true);
    });

    it('surfaces a capture that is running but hearing only silence', async () => {
      installNativeModule(
        makeNativeModule({
          start: jest
            .fn()
            .mockResolvedValue(capturing({ state: 'SILENT', mixedFrames: 0, bytesCaptured: 0 })),
        }),
      );
      const status = await startSystemAudio();
      expect(status.state).toBe('silent');
      expect(status.sharing).toBe(true);
    });

    it('keeps the reason a failed start gives', async () => {
      installNativeModule(
        makeNativeModule({
          start: jest.fn().mockResolvedValue({
            installed: true,
            state: 'UNAVAILABLE',
            sharing: false,
            reason: 'No screen share is running',
          }),
        }),
      );
      await expect(startSystemAudio()).resolves.toMatchObject({
        state: 'unavailable',
        reason: 'No screen share is running',
        sharing: false,
      });
    });

    it('treats an unknown native state as unavailable', async () => {
      installNativeModule(
        makeNativeModule({ start: jest.fn().mockResolvedValue({ state: 'SOMETHING_NEW' }) }),
      );
      await expect(startSystemAudio()).resolves.toMatchObject({ state: 'unavailable' });
    });

    it('does not let a rejected start escape into the screen share', async () => {
      installNativeModule(
        makeNativeModule({ start: jest.fn().mockRejectedValue(new Error('boom')) }),
      );
      await expect(startSystemAudio()).resolves.toMatchObject({ sharing: false });
      expect(isSystemAudioSharing()).toBe(false);
      expect(logWarn).toHaveBeenCalledWith(
        'System audio sharing failed to start',
        expect.objectContaining({ message: 'boom' }),
      );
    });

    it('carries an existing mute over to the audio device module', async () => {
      const native = makeNativeModule();
      installNativeModule(native);
      recordMicrophoneMute(true);
      await startSystemAudio();
      expect(native.setMicrophoneMuted).toHaveBeenCalledWith(true);
    });
  });

  describe('stopSystemAudio', () => {
    it('does nothing when nothing is being shared', async () => {
      const native = makeNativeModule();
      installNativeModule(native);
      await stopSystemAudio();
      expect(native.stop).not.toHaveBeenCalled();
    });

    it('releases the native mute so the track can carry it again', async () => {
      const native = makeNativeModule();
      installNativeModule(native);
      recordMicrophoneMute(true);
      await startSystemAudio();
      await stopSystemAudio();
      expect(native.setMicrophoneMuted).toHaveBeenLastCalledWith(false);
      expect(native.stop).toHaveBeenCalled();
      // The user's choice outlives the share; the caller re-applies it.
      expect(isMicrophoneMuted()).toBe(true);
      expect(isSystemAudioSharing()).toBe(false);
    });

    it('still forgets it was sharing when the native stop rejects', async () => {
      const native = makeNativeModule({ stop: jest.fn().mockRejectedValue(new Error('gone')) });
      installNativeModule(native);
      await startSystemAudio();
      await expect(stopSystemAudio()).resolves.toBeUndefined();
      expect(isSystemAudioSharing()).toBe(false);
    });
  });

  describe('applyMicrophoneMute', () => {
    it('declines to handle the mute when nothing is being mixed', () => {
      installNativeModule(makeNativeModule());
      expect(applyMicrophoneMute(true)).toBe(false);
      // Declining means the caller still has to apply it to the track, and
      // only the caller knows whether that worked, so nothing is recorded
      // here. Recording a mute that never took effect would later replay it
      // onto a microphone the UI is describing the other way.
      expect(isMicrophoneMuted()).toBe(false);
    });

    it('records the mute it applied natively', async () => {
      installNativeModule(makeNativeModule());
      await startSystemAudio();
      expect(applyMicrophoneMute(true)).toBe(true);
      expect(isMicrophoneMuted()).toBe(true);
    });

    it('handles the mute natively while sharing, so shared audio survives', async () => {
      const native = makeNativeModule();
      installNativeModule(native);
      await startSystemAudio();
      expect(applyMicrophoneMute(true)).toBe(true);
      expect(native.setMicrophoneMuted).toHaveBeenLastCalledWith(true);
    });

    it('does not throw when the native mute rejects', async () => {
      const native = makeNativeModule({
        setMicrophoneMuted: jest.fn().mockResolvedValue(true),
      });
      installNativeModule(native);
      await startSystemAudio();
      native.setMicrophoneMuted.mockRejectedValueOnce(new Error('detached'));
      expect(() => applyMicrophoneMute(true)).not.toThrow();
      await Promise.resolve();
    });
  });

  describe('getSystemAudioStatus', () => {
    it('reports unavailable without the native module', async () => {
      installNativeModule(null);
      await expect(getSystemAudioStatus()).resolves.toMatchObject({ state: 'unavailable' });
    });

    it('reports the live counters that make a silent share diagnosable', async () => {
      installNativeModule(makeNativeModule());
      await startSystemAudio();
      await expect(getSystemAudioStatus()).resolves.toMatchObject({
        state: 'capturing',
        mixedFrames: 120,
        bytesCaptured: 184_320,
        sharing: true,
      });
    });

    it('coerces malformed counters instead of leaking NaN', async () => {
      installNativeModule(
        makeNativeModule({
          getStatus: jest.fn().mockResolvedValue({ state: 'CAPTURING', mixedFrames: 'lots' }),
        }),
      );
      await expect(getSystemAudioStatus()).resolves.toMatchObject({ mixedFrames: 0 });
    });
  });
});
