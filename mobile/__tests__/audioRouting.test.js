jest.mock('react-native-incall-manager', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  setForceSpeakerphoneOn: jest.fn(),
  setSpeakerphoneOn: jest.fn(),
  setKeepScreenOn: jest.fn(),
}));

import InCallManager from 'react-native-incall-manager';
import { setAudioRoute, startAudioSession, stopAudioSession } from '../src/audioRouting';

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
});
