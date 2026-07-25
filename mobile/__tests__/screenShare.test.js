import {
  getScreenShareErrorMessage,
  isScreenShareSupported,
  SCREEN_SHARE_CANCELLED,
  startScreenCapture,
  stopScreenCapture,
} from '../src/screenShare';

jest.mock('react-native-webrtc', () => ({
  mediaDevices: { getDisplayMedia: jest.fn() },
}));
jest.mock('../src/appLogger', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

const { mediaDevices } = require('react-native-webrtc');

function makeTrack(kind) {
  return { kind, stop: jest.fn() };
}

function makeStream({ video = [], audio = [] } = {}) {
  return {
    getTracks: () => [...video, ...audio],
    getVideoTracks: () => video,
    getAudioTracks: () => audio,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isScreenShareSupported', () => {
  test('is true when getDisplayMedia exists', () => {
    expect(isScreenShareSupported()).toBe(true);
  });

  test('is false when getDisplayMedia is missing', () => {
    const original = mediaDevices.getDisplayMedia;
    delete mediaDevices.getDisplayMedia;
    expect(isScreenShareSupported()).toBe(false);
    mediaDevices.getDisplayMedia = original;
  });
});

describe('startScreenCapture', () => {
  test('returns the video track when capture succeeds without audio', async () => {
    const videoTrack = makeTrack('video');
    mediaDevices.getDisplayMedia.mockResolvedValue(makeStream({ video: [videoTrack] }));

    const result = await startScreenCapture();

    expect(mediaDevices.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(result.ok).toBe(true);
    expect(result.videoTrack).toBe(videoTrack);
    expect(result.audioTrack).toBeNull();
    expect(result.audioShared).toBe(false);
  });

  test('returns the screen audio track when requested and available', async () => {
    const videoTrack = makeTrack('video');
    const audioTrack = makeTrack('audio');
    mediaDevices.getDisplayMedia.mockResolvedValue(
      makeStream({ video: [videoTrack], audio: [audioTrack] }),
    );

    const result = await startScreenCapture({ withAudio: true });

    expect(mediaDevices.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    expect(result.ok).toBe(true);
    expect(result.audioTrack).toBe(audioTrack);
    expect(result.audioShared).toBe(true);
  });

  test('degrades to video-only when screen audio is unavailable', async () => {
    const videoTrack = makeTrack('video');
    mediaDevices.getDisplayMedia
      .mockRejectedValueOnce(new Error('audio capture not supported'))
      .mockResolvedValueOnce(makeStream({ video: [videoTrack] }));

    const result = await startScreenCapture({ withAudio: true });

    expect(mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(2);
    expect(mediaDevices.getDisplayMedia).toHaveBeenLastCalledWith({ video: true });
    expect(result.ok).toBe(true);
    expect(result.audioShared).toBe(false);
  });

  test('reports cancellation when the user denies the consent dialog', async () => {
    const error = new Error('Permission denied');
    error.name = 'NotAllowedError';
    mediaDevices.getDisplayMedia.mockRejectedValue(error);

    const result = await startScreenCapture();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(SCREEN_SHARE_CANCELLED);
    expect(result.message).toBe('Screen sharing permission denied');
  });

  test('fails when no video track is returned and releases the stream', async () => {
    const audioTrack = makeTrack('audio');
    mediaDevices.getDisplayMedia.mockResolvedValue(makeStream({ audio: [audioTrack] }));

    const result = await startScreenCapture();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('failed');
    expect(audioTrack.stop).toHaveBeenCalled();
  });

  test('reports unsupported platforms without prompting', async () => {
    const original = mediaDevices.getDisplayMedia;
    delete mediaDevices.getDisplayMedia;

    const result = await startScreenCapture();

    expect(result).toEqual({
      ok: false,
      reason: 'unsupported',
      message: 'Screen sharing is not supported on this device',
    });
    mediaDevices.getDisplayMedia = original;
  });
});

describe('stopScreenCapture', () => {
  test('stops every track and tolerates missing streams', () => {
    const videoTrack = makeTrack('video');
    const audioTrack = makeTrack('audio');

    stopScreenCapture(makeStream({ video: [videoTrack], audio: [audioTrack] }));
    stopScreenCapture(null);

    expect(videoTrack.stop).toHaveBeenCalled();
    expect(audioTrack.stop).toHaveBeenCalled();
  });
});

describe('getScreenShareErrorMessage', () => {
  test('describes permission denials', () => {
    const error = new Error('User denied screen capture');
    expect(getScreenShareErrorMessage(error)).toBe('Screen sharing permission denied');
  });

  test('describes generic failures', () => {
    const { Platform } = require('react-native');
    const originalOS = Platform.OS;
    Platform.OS = 'android';
    try {
      expect(getScreenShareErrorMessage(new Error('boom'))).toBe(
        'Unable to start screen sharing: boom',
      );
    } finally {
      Platform.OS = originalOS;
    }
  });
});
