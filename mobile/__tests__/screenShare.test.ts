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

function makeTrack(kind: string) {
  return { kind, stop: jest.fn() };
}

function makeStream(
  { video = [], audio = [] }: { video?: any[]; audio?: any[]; } = {},
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

  test('reports a bare NotAllowedError rejection as a denial, not an unknown failure', async () => {
    // react-native-webrtc rejects with a plain object whose message is the DOM
    // exception name; that used to surface as "Unknown error".
    mediaDevices.getDisplayMedia.mockRejectedValue({ message: 'NotAllowedError' });

    const result = expectNotOk(await startScreenCapture());

    expect(result.reason).toBe(SCREEN_SHARE_CANCELLED);
    expect(result.message).toBe('Screen sharing permission denied');
  });

  test('does not re-prompt for consent after a denial of the audio request', async () => {
    mediaDevices.getDisplayMedia.mockRejectedValue({ message: 'NotAllowedError' });

    const result = expectNotOk(await startScreenCapture({ withAudio: true }));

    // The consent token is consumed by the prompt, so the video-only retry
    // could only ask a user who has already said no.
    expect(mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe(SCREEN_SHARE_CANCELLED);
  });

  test('fails when no video track is returned and releases the stream', async () => {
    const audioTrack = makeTrack('audio');
    mediaDevices.getDisplayMedia.mockResolvedValue(makeStream({ audio: [audioTrack] }));

    const result = expectNotOk(await startScreenCapture());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('failed');
    expect(audioTrack.stop).toHaveBeenCalled();
  });

  test('rejects a capture that is not a media stream instead of passing it on', async () => {
    // A malformed descriptor used to travel into the call logic as `any`.
    mediaDevices.getDisplayMedia.mockResolvedValue({ tracks: [] });

    const result = expectNotOk(await startScreenCapture());

    expect(result.reason).toBe('failed');
    expect(result.message).toBe('Screen sharing did not return a media stream');
  });

  test('ignores track lists that are not arrays of tracks', async () => {
    const videoTrack = makeTrack('video');
    mediaDevices.getDisplayMedia.mockResolvedValue({
      getTracks: () => [videoTrack],
      getVideoTracks: () => [videoTrack, { kind: 'video' }],
      getAudioTracks: () => 'not-a-list',
    });

    const result = expectOk(await startScreenCapture({ withAudio: true }));

    expect(result.videoTrack).toBe(videoTrack);
    expect(result.audioTrack).toBeNull();
    expect(result.audioShared).toBe(false);
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

  test('tolerates streams whose track accessor is malformed', () => {
    expect(() => stopScreenCapture({ getTracks: () => { throw new Error('closed'); } })).not.toThrow();
    expect(() => stopScreenCapture({ getTracks: () => null })).not.toThrow();
    expect(() => stopScreenCapture({ getTracks: 'nope' })).not.toThrow();
  });
});

describe('getScreenShareErrorMessage', () => {
  test('describes permission denials', () => {
    const error = new Error('User denied screen capture');
    expect(getScreenShareErrorMessage(error)).toBe('Screen sharing permission denied');
  });

  test('names a non-Error rejection instead of calling it unknown', () => {
    const { Platform } = require('react-native');
    const originalOS = Platform.OS;
    Platform.OS = 'android';
    try {
      expect(getScreenShareErrorMessage({ message: 'MediaProjection stopped' })).toBe(
        'Unable to start screen sharing: MediaProjection stopped',
      );
    } finally {
      Platform.OS = originalOS;
    }
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

  test('ignores stats entries that are not outbound video objects', async () => {
    const peerConnection = {
      getStats: jest.fn(async () => [
        null,
        'outbound-rtp',
        { type: 'inbound-rtp', kind: 'video', framesSent: 99 },
        { type: 'outbound-rtp', kind: 'video', framesSent: 2 },
      ]),
    };

    await expect(verifyScreenShareFrames(peerConnection, options)).resolves.toMatchObject({
      ok: true,
      frames: 2,
    });
  });

  test('does not measure a report that is not iterable', async () => {
    const peerConnection = { getStats: jest.fn(async () => 'no stats here') };

    const result = expectNotOk(await verifyScreenShareFrames(peerConnection, options));
    expect(result.reason).toBe(SCREEN_SHARE_NO_FRAMES);
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
