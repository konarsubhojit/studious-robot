// @ts-check
jest.mock('react-native-incall-manager', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  setForceSpeakerphoneOn: jest.fn(),
  setSpeakerphoneOn: jest.fn(),
  setKeepScreenOn: jest.fn(),
  chooseAudioRoute: jest.fn(),
}));

const mockEnsureBluetoothPermission = jest.fn();

jest.mock('../src/permissions', () => ({
  ensureBluetoothPermission: (/** @type {any[]} */ ...args: any[]) => mockEnsureBluetoothPermission(...args),
}));

import { DeviceEventEmitter } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import {
  applyPreferredAudioRoute,
  AUDIO_ROUTES,
  chooseAudioRoute,
  selectPreferredAudioRoute,
  getAudioRouteLabel,
  parseAudioDeviceStatus,
  setAudioRoute,
  startAudioSession,
  stopAudioSession,
  subscribeAudioDevices,
} from '../src/audioRouting';

const startMock = (InCallManager.start as jest.Mock);
const stopMock = (InCallManager.stop as jest.Mock);
const setForceSpeakerphoneOnMock = (InCallManager.setForceSpeakerphoneOn as jest.Mock);
const chooseAudioRouteMock = (InCallManager.chooseAudioRoute as jest.Mock);

describe('audioRouting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('startAudioSession', () => {
    test('starts InCallManager with video media', () => {
      expect(startAudioSession()).toEqual({ ok: true });
      expect(InCallManager.start).toHaveBeenCalledWith({ media: 'video' });
    });

    test('keeps the screen on during the call', () => {
      startAudioSession();
      expect(InCallManager.setKeepScreenOn).toHaveBeenCalledWith(true);
    });

    test('returns an error result instead of throwing when native start fails', () => {
      startMock.mockImplementation(() => {
        throw new Error('missing WAKE_LOCK');
      });

      expect(startAudioSession()).toMatchObject({
        ok: false,
        message: expect.stringContaining('Unable to update in-call audio'),
      });
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

    test('returns an error result instead of throwing when native stop fails', () => {
      stopMock.mockImplementation(() => {
        throw new Error('stop failed');
      });

      expect(stopAudioSession()).toMatchObject({
        ok: false,
        message: expect.stringContaining('Unable to update in-call audio'),
      });
    });
  });

  describe('setAudioRoute', () => {
    test('forces speaker when speakerEnabled is true', () => {
      expect(setAudioRoute(true)).toEqual({
        ok: true,
        selected: AUDIO_ROUTES.SPEAKER_PHONE,
      });
      expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenCalledWith(true);
      expect(InCallManager.setSpeakerphoneOn).toHaveBeenCalledWith(true);
    });

    test('routes to earpiece/bluetooth when speakerEnabled is false', () => {
      expect(setAudioRoute(false)).toEqual({
        ok: true,
        selected: AUDIO_ROUTES.EARPIECE,
      });
      expect(InCallManager.setForceSpeakerphoneOn).toHaveBeenCalledWith(false);
      expect(InCallManager.setSpeakerphoneOn).toHaveBeenCalledWith(false);
    });

    test('falls back to speaker when route update fails', () => {
      setForceSpeakerphoneOnMock
        .mockImplementationOnce(() => {
          throw new Error('missing BLUETOOTH_CONNECT');
        })
        .mockImplementation(() => {});

      expect(setAudioRoute(false)).toMatchObject({
        ok: false,
        selected: AUDIO_ROUTES.SPEAKER_PHONE,
      });
      expect(InCallManager.setSpeakerphoneOn).toHaveBeenCalledWith(true);
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
      expect(parseAudioDeviceStatus({ availableAudioDeviceList: 'not-json' }).available).toEqual(
        [],
      );
      expect(parseAudioDeviceStatus(undefined)).toEqual({ available: [], selected: null });
      expect(parseAudioDeviceStatus(null)).toEqual({ available: [], selected: null });
    });
  });

  describe('chooseAudioRoute', () => {
    beforeEach(() => {
      mockEnsureBluetoothPermission.mockResolvedValue({
        ok: true,
        granted: true,
        requested: false,
      });
    });

    test('delegates to InCallManager and returns parsed status', async () => {
      chooseAudioRouteMock.mockResolvedValue({
        availableAudioDeviceList: '["SPEAKER_PHONE","BLUETOOTH"]',
        selectedAudioDevice: 'BLUETOOTH',
      });
      const status = await chooseAudioRoute(AUDIO_ROUTES.BLUETOOTH);
      expect(mockEnsureBluetoothPermission).toHaveBeenCalledWith({ requestIfNeeded: true });
      expect(InCallManager.chooseAudioRoute).toHaveBeenCalledWith('BLUETOOTH');
      expect(status).toEqual({
        available: ['SPEAKER_PHONE', 'BLUETOOTH'],
        selected: 'BLUETOOTH',
        ok: true,
      });
    });

    test('falls back gracefully when Bluetooth permission is denied', async () => {
      mockEnsureBluetoothPermission.mockResolvedValue({
        ok: false,
        granted: false,
        requested: true,
        message: 'Bluetooth permission denied. Call will stay on speaker or earpiece.',
      });

      const status = await chooseAudioRoute(AUDIO_ROUTES.BLUETOOTH);

      expect(InCallManager.chooseAudioRoute).not.toHaveBeenCalled();
      expect(status).toMatchObject({
        ok: false,
        selected: AUDIO_ROUTES.SPEAKER_PHONE,
        message: 'Bluetooth permission denied. Call will stay on speaker or earpiece.',
      });
    });

    test('returns a non-throwing error result when native route selection fails', async () => {
      chooseAudioRouteMock.mockRejectedValue(new Error('native failure'));

      const status = await chooseAudioRoute(AUDIO_ROUTES.EARPIECE);

      expect(status).toMatchObject({
        ok: false,
        selected: null,
        message: expect.stringContaining('Unable to update in-call audio'),
      });
    });
  });

  describe('selectPreferredAudioRoute', () => {
    test('prefers Bluetooth, then wired, then earpiece, then speaker', () => {
      expect(
        selectPreferredAudioRoute(['SPEAKER_PHONE', 'EARPIECE', 'WIRED_HEADSET', 'BLUETOOTH']),
      ).toBe(AUDIO_ROUTES.BLUETOOTH);
      expect(selectPreferredAudioRoute(['SPEAKER_PHONE', 'EARPIECE', 'WIRED_HEADSET'])).toBe(
        AUDIO_ROUTES.WIRED_HEADSET,
      );
      expect(selectPreferredAudioRoute(['SPEAKER_PHONE', 'EARPIECE'])).toBe(AUDIO_ROUTES.EARPIECE);
      expect(selectPreferredAudioRoute(['SPEAKER_PHONE'])).toBe(AUDIO_ROUTES.SPEAKER_PHONE);
    });

    test('never defaults to the loudspeaker when nothing is known', () => {
      expect(selectPreferredAudioRoute()).toBe(AUDIO_ROUTES.EARPIECE);
      expect(selectPreferredAudioRoute([])).toBe(AUDIO_ROUTES.EARPIECE);
    });
  });

  describe('applyPreferredAudioRoute', () => {
    beforeEach(() => {
      mockEnsureBluetoothPermission.mockResolvedValue({ ok: true, granted: true });
    });

    test('routes to Bluetooth when a headset is connected', async () => {
      chooseAudioRouteMock.mockResolvedValue({
        availableAudioDeviceList: '["BLUETOOTH","EARPIECE","SPEAKER_PHONE"]',
        selectedAudioDevice: 'BLUETOOTH',
      });

      const result = await applyPreferredAudioRoute([
        'BLUETOOTH',
        'EARPIECE',
        'SPEAKER_PHONE',
      ]);

      expect(InCallManager.chooseAudioRoute).toHaveBeenCalledWith('BLUETOOTH');
      expect(result).toMatchObject({ ok: true, selected: AUDIO_ROUTES.BLUETOOTH });
    });

    test('discovers devices on the first selection and upgrades to the better one', async () => {
      chooseAudioRouteMock.mockImplementation(async (/** @type {string} */ route: string) => ({
        availableAudioDeviceList: '["BLUETOOTH","EARPIECE"]',
        selectedAudioDevice: route,
      }));

      const result = await applyPreferredAudioRoute([]);

      expect(InCallManager.chooseAudioRoute).toHaveBeenNthCalledWith(1, 'EARPIECE');
      expect(InCallManager.chooseAudioRoute).toHaveBeenNthCalledWith(2, 'BLUETOOTH');
      expect(result).toMatchObject({ ok: true, selected: AUDIO_ROUTES.BLUETOOTH });
    });

    test('falls back to the wired headset instead of the speaker when Bluetooth is denied', async () => {
      mockEnsureBluetoothPermission.mockResolvedValue({
        ok: false,
        granted: false,
        message: 'Bluetooth permission denied. Call will stay on speaker or earpiece.',
      });
      chooseAudioRouteMock.mockResolvedValue({
        availableAudioDeviceList: '["WIRED_HEADSET","SPEAKER_PHONE"]',
        selectedAudioDevice: 'WIRED_HEADSET',
      });

      const result = await applyPreferredAudioRoute([
        'BLUETOOTH',
        'WIRED_HEADSET',
        'SPEAKER_PHONE',
      ]);

      expect(InCallManager.setForceSpeakerphoneOn).not.toHaveBeenCalled();
      expect(InCallManager.chooseAudioRoute).toHaveBeenCalledWith('WIRED_HEADSET');
      expect(result).toMatchObject({ ok: true, selected: AUDIO_ROUTES.WIRED_HEADSET });
    });

    test('reports a degraded result when every device fails', async () => {
      chooseAudioRouteMock.mockRejectedValue(new Error('native failure'));

      const result = await applyPreferredAudioRoute(['EARPIECE', 'SPEAKER_PHONE']);

      expect(result.ok).toBe(false);
      expect(result.selected).toBe(AUDIO_ROUTES.SPEAKER_PHONE);
      expect((result as any).message).toEqual(expect.any(String));
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