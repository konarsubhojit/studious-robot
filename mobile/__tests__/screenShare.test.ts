// @ts-check
import {
  getScreenShareErrorMessage,
  isScreenShareSupported,
  SCREEN_SHARE_CANCELLED,
  SCREEN_SHARE_NO_FRAMES,
  startScreenCapture,
  stopScreenCapture,
  verifyScreenShareFrames,
} from '../src/screenShare';

jest.mock('react-native-webrtc', () => ({
  mediaDevices: { getDisplayMedia: jest.fn() },
}));
jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

const mediaDevices = (require('react-native-webrtc').mediaDevices as any);

function makeTrack(/** @type {string} */ kind: string) {
  return { kind, stop: jest.fn() };
}

function makeStream(
  /** @type {{ video?: any[], audio?: any[] }} */ { video = [], audio = [] }: { video?: any[]; audio?: any[]; } = {},
) {
  return {
    getTracks: () => [...video, ...audio],
    getVideoTracks: () => video,
    getAudioTracks: () => audio,
  };
}

// Narrow a discriminated `{ ok }` result instead of casting it to `any`, so the
// assertions below still fail to compile if the returned shape changes.
/**
 * @template {{ ok: boolean }} T
 * @param {T} result
 * @returns {Extract<T, { ok: true }>}
 */
function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true; }> {
  if (!result.ok) {
    const { reason } = (result as any);
    throw new Error(`expected a successful result, got a failure: ${reason}`);
  }
  return (result as Extract<T, { ok: true }>);
}

/**
 * @template {{ ok: boolean }} T
 * @param {T} result
 * @returns {Extract<T, { ok: false }>}
 */
function expectNotOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: false; }> {
  if (result.ok) {
    throw new Error('expected a failed result, got a successful one');
  }
  return (result as Extract<T, { ok: false }>);
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

    const result = expectOk(await startScreenCapture());

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

    const result = expectOk(await startScreenCapture({ withAudio: true }));

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

    const result = expectOk(await startScreenCapture({ withAudio: true }));

    expect(mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(2);
    expect(mediaDevices.getDisplayMedia).toHaveBeenLastCalledWith({ video: true });
    expect(result.ok).toBe(true);
    expect(result.audioShared).toBe(false);
  });

  test('reports cancellation when the user denies the consent dialog', async () => {
    const error = new Error('Permission denied');
    error.name = 'NotAllowedError';
    mediaDevices.getDisplayMedia.mockRejectedValue(error);

    const result = expectNotOk(await startScreenCapture());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(SCREEN_SHARE_CANCELLED);
    expect(result.message).toBe('Screen sharing permission denied');
  });

  test('fails when no video track is returned and releases the stream', async () => {
    const audioTrack = makeTrack('audio');
    mediaDevices.getDisplayMedia.mockResolvedValue(makeStream({ audio: [audioTrack] }));

    const result = expectNotOk(await startScreenCapture());

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

describe('verifyScreenShareFrames', () => {
  const options = { timeoutMs: 20, intervalMs: 1 };

  test('succeeds once outbound frames are reported', async () => {
    let frames = 0;
    const peerConnection = {
      getStats: jest.fn(async () => {
        frames += 5;
        return new Map([['outbound-rtp-1', { type: 'outbound-rtp', kind: 'video', framesSent: frames }]]);
      }),
    };

    await expect(verifyScreenShareFrames(peerConnection, options)).resolves.toEqual({
      ok: true,
      frames: 5,
      verified: true,
    });
  });

  test('fails when the capture never produces a frame', async () => {
    const peerConnection = {
      getStats: jest.fn(async () => [
        { type: 'outbound-rtp', kind: 'video', framesSent: 0 },
        { type: 'outbound-rtp', kind: 'audio', packetsSent: 42 },
      ]),
    };

    const result = expectNotOk(await verifyScreenShareFrames(peerConnection, options));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(SCREEN_SHARE_NO_FRAMES);
    expect(result.message).toMatch(/black screen/i);
  });

  test('counts framesEncoded when framesSent is unavailable', async () => {
    const peerConnection = {
      getStats: jest.fn(async () => ({
        a: { type: 'outbound-rtp', mediaType: 'video', framesEncoded: 3 },
      })),
    };

    await expect(verifyScreenShareFrames(peerConnection, options)).resolves.toMatchObject({
      ok: true,
      frames: 3,
    });
  });

  test('does not fail a share it cannot measure', async () => {
    await expect(verifyScreenShareFrames(null, options)).resolves.toEqual({
      ok: true,
      frames: null,
      verified: false,
    });

    const peerConnection = {
      getStats: jest.fn(() => Promise.reject(new Error('closed'))),
    };
    await expect(verifyScreenShareFrames(peerConnection, options)).resolves.toEqual({
      ok: true,
      frames: null,
      verified: false,
    });
  });
});
