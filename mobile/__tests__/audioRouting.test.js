jest.mock('react-native-incall-manager', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  setForceSpeakerphoneOn: jest.fn(),
  setSpeakerphoneOn: jest.fn(),
  setKeepScreenOn: jest.fn(),
  chooseAudioRoute: jest.fn(),
}));

import { DeviceEventEmitter } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import {
  AUDIO_ROUTES,
  chooseAudioRoute,
  getAudioRouteLabel,
  parseAudioDeviceStatus,
  setAudioRoute,
  startAudioSession,
  stopAudioSession,
  subscribeAudioDevices,
} from '../src/audioRouting';

describe('audioRouting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('startAudioSession', () => {
    test('starts InCallManager with video media', () => {
      startAudioSession();
      expect(InCallManager.start).toHaveBeenCalledWith({ media: 'video' });
    });

    test('keeps the screen on during the call', () => {
      startAudioSession();
      expect(InCallManager.setKeepScreenOn).toHaveBeenCalledWith(true);
    });
  });

  describe('stopAudioSession', () => {
    test('releases the screen-on lock before stopping', () => {
      stopAudioSession();
      expect(InCallManager.setKeepScreenOn).toHaveBeenCalledWith(false);
    });

    test('stops InCallManager to release audio focus', () => {
      stopAudioSession();
      expect(InCallManager.stop).toHaveBeenCalled();
    });
  });

  describe('setAudioRoute', () => {
    test('forces speaker when speakerEnabled is true', () => {
      setAudioRoute(true);
      expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenCalledWith(true);
      expect(InCallManager.setSpeakerphoneOn).toHaveBeenCalledWith(true);
    });

    test('routes to earpiece/bluetooth when speakerEnabled is false', () => {
      setAudioRoute(false);
      expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenCalledWith(false);
      expect(InCallManager.setSpeakerphoneOn).toHaveBeenCalledWith(false);
    });
  });

  describe('getAudioRouteLabel', () => {
    test('maps known routes to friendly labels', () => {
      expect(getAudioRouteLabel(AUDIO_ROUTES.SPEAKER_PHONE)).toBe('Speaker');
      expect(getAudioRouteLabel(AUDIO_ROUTES.EARPIECE)).toBe('Earpiece');
      expect(getAudioRouteLabel(AUDIO_ROUTES.BLUETOOTH)).toBe('Bluetooth');
      expect(getAudioRouteLabel(AUDIO_ROUTES.WIRED_HEADSET)).toBe('Wired headset');
    });

    test('falls back to the raw value for unknown routes', () => {
      expect(getAudioRouteLabel('FUTURE_DEVICE')).toBe('FUTURE_DEVICE');
      expect(getAudioRouteLabel(undefined)).toBe('Unknown');
    });
  });

  describe('parseAudioDeviceStatus', () => {
    test('parses a JSON-encoded device list and selected device', () => {
      const status = parseAudioDeviceStatus({
        availableAudioDeviceList: '["SPEAKER_PHONE","EARPIECE","BLUETOOTH"]',
        selectedAudioDevice: 'BLUETOOTH',
      });
      expect(status.available).toEqual(['SPEAKER_PHONE', 'EARPIECE', 'BLUETOOTH']);
      expect(status.selected).toBe('BLUETOOTH');
    });

    test('accepts an already-parsed array', () => {
      const status = parseAudioDeviceStatus({
        availableAudioDeviceList: ['SPEAKER_PHONE', 'EARPIECE'],
        selectedAudioDevice: '',
      });
      expect(status.available).toEqual(['SPEAKER_PHONE', 'EARPIECE']);
      expect(status.selected).toBeNull();
    });

    test('drops NONE entries and de-duplicates', () => {
      const status = parseAudioDeviceStatus({
        availableAudioDeviceList: '["SPEAKER_PHONE","NONE","SPEAKER_PHONE"]',
        selectedAudioDevice: 'SPEAKER_PHONE',
      });
      expect(status.available).toEqual(['SPEAKER_PHONE']);
    });

    test('tolerates malformed JSON and missing payloads', () => {
      expect(parseAudioDeviceStatus({ availableAudioDeviceList: 'not-json' }).available).toEqual([]);
      expect(parseAudioDeviceStatus(undefined)).toEqual({ available: [], selected: null });
      expect(parseAudioDeviceStatus(null)).toEqual({ available: [], selected: null });
    });
  });

  describe('chooseAudioRoute', () => {
    test('delegates to InCallManager and returns parsed status', async () => {
      InCallManager.chooseAudioRoute.mockResolvedValue({
        availableAudioDeviceList: '["SPEAKER_PHONE","BLUETOOTH"]',
        selectedAudioDevice: 'BLUETOOTH',
      });
      const status = await chooseAudioRoute(AUDIO_ROUTES.BLUETOOTH);
      expect(InCallManager.chooseAudioRoute).toHaveBeenCalledWith('BLUETOOTH');
      expect(status).toEqual({ available: ['SPEAKER_PHONE', 'BLUETOOTH'], selected: 'BLUETOOTH' });
    });
  });

  describe('subscribeAudioDevices', () => {
    test('parses native payloads and unsubscribes on teardown', () => {
      const handler = jest.fn();
      const unsubscribe = subscribeAudioDevices(handler);

      DeviceEventEmitter.emit('onAudioDeviceChanged', {
        availableAudioDeviceList: '["SPEAKER_PHONE","EARPIECE"]',
        selectedAudioDevice: 'EARPIECE',
      });
      expect(handler).toHaveBeenCalledWith({
        available: ['SPEAKER_PHONE', 'EARPIECE'],
        selected: 'EARPIECE',
      });

      handler.mockClear();
      unsubscribe();
      DeviceEventEmitter.emit('onAudioDeviceChanged', {
        availableAudioDeviceList: '["SPEAKER_PHONE"]',
        selectedAudioDevice: 'SPEAKER_PHONE',
      });
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
