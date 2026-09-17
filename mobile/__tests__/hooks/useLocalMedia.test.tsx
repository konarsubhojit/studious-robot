import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useLocalMedia from '../../src/hooks/useLocalMedia';

jest.mock('react-native-webrtc', () => ({
  mediaDevices: {
    getUserMedia: jest.fn(),
  },
}));

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('../../src/diagnostics', () => ({
  getMediaAccessStatus: jest.fn(() => 'Camera or microphone unavailable'),
}));

jest.mock('../../src/mediaControls', () => ({
  isTrackEnabled: jest.fn((_stream, kind) => kind !== 'audio'),
  setTrackEnabled: jest.fn(() => true),
}));

jest.mock('../../src/permissions', () => ({
  ensureCallPermissions: jest.fn(() => Promise.resolve({ ok: true })),
}));

const { mediaDevices } = require('react-native-webrtc');
const mediaControls = require('../../src/mediaControls');
const { ensureCallPermissions } = require('../../src/permissions');

function TestHook({ params, resultRef }: any) {
  resultRef.current = useLocalMedia(params);
  return null;
}

function makeTrack(overrides: any = {}) {
  return {
    enabled: true,
    id: 'track',
    kind: 'video',
    stop: jest.fn(),
    ...overrides,
  };
}

function makeStream({
  audioTracks = [makeTrack({ id: 'audio', kind: 'audio' })],
  videoTracks = [makeTrack()],
} = {}) {
  const tracks = [...audioTracks, ...videoTracks];
  return {
    addTrack: jest.fn((track: any) => tracks.push(track)),
    getAudioTracks: jest.fn(() => audioTracks),
    getTracks: jest.fn(() => tracks),
    getVideoTracks: jest.fn(() => videoTracks),
    removeTrack: jest.fn((track: any) => {
      const index = tracks.indexOf(track);
      if (index >= 0) tracks.splice(index, 1);
    }),
  };
}

function setup(overrides: any = {}) {
  const replaceOutgoingVideoTrack = jest.fn(() => Promise.resolve());
  const params = {
    replaceOutgoingVideoTrackRef: { current: replaceOutgoingVideoTrack },
    setIsMuted: jest.fn(),
    updateStatus: jest.fn(),
    ...overrides,
  };
  const resultRef: { current: any } = { current: null };
  let instance: renderer.ReactTestRenderer;
  act(() => {
    instance = renderer.create(<TestHook params={params} resultRef={resultRef} />);
  });
  return { instance: instance!, params, replaceOutgoingVideoTrack, resultRef };
}

beforeEach(() => {
  jest.clearAllMocks();
  ensureCallPermissions.mockResolvedValue({ ok: true });
  mediaControls.isTrackEnabled.mockImplementation((_stream: any, kind: string) => kind !== 'audio');
  mediaControls.setTrackEnabled.mockReturnValue(true);
});

describe('useLocalMedia', () => {
  test('audio-only acquisition never requests camera permission or video capture', async () => {
    const stream = makeStream({ videoTracks: [] });
    mediaDevices.getUserMedia.mockResolvedValue(stream);
    const { resultRef } = setup();
    await act(async () => { await resultRef.current.startLocalPreview('audio'); });
    expect(ensureCallPermissions).toHaveBeenCalledWith('audio');
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(resultRef.current.isVideoEnabled).toBe(false);
  });

  test('camera is acquired only on explicit upgrade and installed on the reserved sender', async () => {
    const stream = makeStream({ videoTracks: [] });
    const camera = makeTrack();
    mediaDevices.getUserMedia.mockResolvedValueOnce(stream)
      .mockResolvedValueOnce(makeStream({ audioTracks: [], videoTracks: [camera] }));
    const { resultRef, replaceOutgoingVideoTrack } = setup();
    await act(async () => { await resultRef.current.startLocalPreview('audio'); });
    await act(async () => { await resultRef.current.handleVideoToggle(); });
    expect(ensureCallPermissions).toHaveBeenLastCalledWith('video');
    expect(mediaDevices.getUserMedia).toHaveBeenLastCalledWith({
      audio: false, video: { facingMode: 'user' },
    });
    expect(replaceOutgoingVideoTrack).toHaveBeenCalledWith(camera);
    expect(stream.addTrack).toHaveBeenCalledWith(camera);
    expect(resultRef.current.isVideoEnabled).toBe(true);
  });

  test('denying a camera upgrade leaves audio intact and does not acquire video', async () => {
    const stream = makeStream({ videoTracks: [] });
    mediaDevices.getUserMedia.mockResolvedValue(stream);
    const { resultRef } = setup();
    await act(async () => { await resultRef.current.startLocalPreview('audio'); });
    ensureCallPermissions.mockResolvedValue({ ok: false, message: 'Camera denied' });
    await act(async () => { await resultRef.current.handleVideoToggle(); });
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(resultRef.current.localStream).toBe(stream);
    expect(resultRef.current.isVideoEnabled).toBe(false);
  });

  test('stops media returned after teardown instead of resurrecting the call', async () => {
    const stream = makeStream({ videoTracks: [] });
    let resolveMedia!: (value: typeof stream) => void;
    mediaDevices.getUserMedia.mockImplementationOnce(() => new Promise(resolve => { resolveMedia = resolve; }));
    const { resultRef } = setup();
    await act(async () => {
      const pending = resultRef.current.startLocalPreview('audio');
      await Promise.resolve();
      resultRef.current.releaseLocalMedia();
      resolveMedia(stream);
      await pending;
    });
    expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
    expect(resultRef.current.localStream).toBeNull();
  });

  test('an audio request supersedes an in-flight video acquisition', async () => {
    const video = makeStream();
    const audio = makeStream({ videoTracks: [] });
    let resolveVideo!: (value: typeof video) => void;
    mediaDevices.getUserMedia
      .mockImplementationOnce(() => new Promise(resolve => { resolveVideo = resolve; }))
      .mockResolvedValueOnce(audio);
    const { resultRef } = setup();
    await act(async () => {
      const pendingVideo = resultRef.current.startLocalPreview('video');
      await Promise.resolve();
      await resultRef.current.startLocalPreview('audio');
      resolveVideo(video);
      await pendingVideo;
    });
    expect(video.getVideoTracks()[0].stop).toHaveBeenCalledTimes(1);
    expect(resultRef.current.localStream).toBe(audio);
    expect(resultRef.current.isVideoEnabled).toBe(false);
  });

  test('camera switch cannot implicitly upgrade an audio call', async () => {
    const { resultRef } = setup();
    resultRef.current.localStreamRef.current = makeStream({ videoTracks: [] });
    await act(async () => { await resultRef.current.handleCameraSwitch(); });
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  test('starts local preview after permissions and publishes stream state', async () => {
    const stream = makeStream();
    mediaDevices.getUserMedia.mockResolvedValue(stream);
    const { params, resultRef } = setup();

    await act(async () => {
      await resultRef.current.startLocalPreview();
    });

    expect(ensureCallPermissions).toHaveBeenCalledTimes(1);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: true,
      video: { facingMode: 'user' },
    });
    expect(resultRef.current.localStream).toBe(stream);
    expect(resultRef.current.localStreamRef.current).toBe(stream);
    expect(params.setIsMuted).toHaveBeenCalledWith(true);
    expect(resultRef.current.isVideoEnabled).toBe(true);
  });

  test('reports permission denial without requesting media', async () => {
    ensureCallPermissions.mockResolvedValue({ ok: false, message: 'Missing camera permission' });
    const { params, resultRef } = setup();

    await act(async () => {
      await resultRef.current.startLocalPreview();
    });

    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(params.updateStatus).toHaveBeenCalledWith('Missing camera permission', 'error');
  });

  test('releases local media tracks and clears the published stream', async () => {
    const audioTrack = makeTrack({ id: 'audio', kind: 'audio' });
    const videoTrack = makeTrack({ id: 'video', kind: 'video' });
    const stream = makeStream({ audioTracks: [audioTrack], videoTracks: [videoTrack] });
    mediaDevices.getUserMedia.mockResolvedValue(stream);
    const { resultRef } = setup();

    await act(async () => {
      await resultRef.current.startLocalPreview();
      resultRef.current.releaseLocalMedia();
    });

    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
    expect(videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(resultRef.current.localStream).toBeNull();
    expect(resultRef.current.localStreamRef.current).toBeNull();
  });

  test('toggles the local video track and reports the new camera state', () => {
    const stream = makeStream();
    const { params, resultRef } = setup();
    resultRef.current.localStreamRef.current = stream;

    act(() => {
      resultRef.current.handleVideoToggle();
    });

    expect(mediaControls.setTrackEnabled).toHaveBeenCalledWith(stream, 'video', false);
    expect(resultRef.current.isVideoEnabled).toBe(false);
    expect(params.updateStatus).toHaveBeenCalledWith('Camera disabled');
  });

  test('switches camera in place when the current track supports it', async () => {
    const switchCamera = jest.fn();
    const videoTrack = makeTrack({ _switchCamera: switchCamera });
    const stream = makeStream({ videoTracks: [videoTrack] });
    const { params, resultRef } = setup();
    resultRef.current.localStreamRef.current = stream;

    await act(async () => {
      await resultRef.current.handleCameraSwitch();
    });

    expect(switchCamera).toHaveBeenCalledTimes(1);
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(resultRef.current.isFrontCamera).toBe(false);
    expect(params.updateStatus).toHaveBeenCalledWith('Camera switched');
  });

  test('falls back to replacing the outgoing video track when in-place switching is unavailable', async () => {
    const oldVideoTrack = makeTrack({ id: 'old-video' });
    const newVideoTrack = makeTrack({ id: 'new-video' });
    const currentStream = makeStream({ videoTracks: [oldVideoTrack] });
    const replacementStream = makeStream({ audioTracks: [], videoTracks: [newVideoTrack] });
    mediaDevices.getUserMedia.mockResolvedValue(replacementStream);
    const { replaceOutgoingVideoTrack, resultRef } = setup();
    resultRef.current.localStreamRef.current = currentStream;

    await act(async () => {
      await resultRef.current.handleCameraSwitch();
    });

    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: 'environment' },
    });
    expect(replaceOutgoingVideoTrack).toHaveBeenCalledWith(newVideoTrack);
    expect(oldVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(currentStream.removeTrack).toHaveBeenCalledWith(oldVideoTrack);
    expect(currentStream.addTrack).toHaveBeenCalledWith(newVideoTrack);
  });
});
