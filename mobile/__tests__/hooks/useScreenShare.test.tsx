import React from 'react';
import { NativeModules, Platform } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import useScreenShare from '../../src/hooks/useScreenShare';
import { applyMicrophoneMute, resetSystemAudioState } from '../../src/screenAudio';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));
jest.mock('../../src/screenShare', () => ({
  SCREEN_SHARE_CANCELLED: 'cancelled',
  SCREEN_SHARE_NO_FRAMES: 'no_frames',
  isScreenShareSupported: jest.fn(() => true),
  isScreenAudioCaptureSupported: jest.fn(() => true),
  startScreenCapture: jest.fn(),
  stopScreenCapture: jest.fn(),
  logScreenShareAudioRtpStats: jest.fn(() => Promise.resolve()),
  verifyScreenShareFrames: jest.fn(() => Promise.resolve({ ok: true, frames: 1, verified: true })),
}));

const screenShare = require('../../src/screenShare');

function TestHook({ resultRef, params }: any) {
  resultRef.current = useScreenShare(params);
  return null;
}

/**
 * A media-track double; `onended` is assigned by the hook under test.
 */
function makeTrack(kind: string): any {
  return { kind, enabled: true, stop: jest.fn() };
}

function setup({
  renegotiate = jest.fn(() => Promise.resolve()),
  senderSupportsParameters = true,
  initialParameters = { encodings: [{ maxBitrate: 500_000 }] } as any,
  // An audio-only call has no video sender for the screen track to borrow.
  hasCameraSender = true,
} = {}) {
  const cameraTrack = makeTrack('video');
  const sender: any = { track: cameraTrack, replaceTrack: jest.fn(() => Promise.resolve()) };
  if (senderSupportsParameters) {
    sender.getParameters = jest.fn(() => initialParameters);
    sender.setParameters = jest.fn();
  }
  const audioSender = { replaceTrack: jest.fn(() => Promise.resolve()) };
  const addedVideoSender = { replaceTrack: jest.fn(() => Promise.resolve()) };
  const peerConnection = {
    getSenders: jest.fn(() => (hasCameraSender ? [sender] : [])),
    addTrack: jest.fn((track: any) => (track?.kind === 'audio' ? audioSender : addedVideoSender)),
    removeTrack: jest.fn(),
  };
  const microphoneTrack = makeTrack('audio');
  const localStream = {
    addTrack: jest.fn(),
    removeTrack: jest.fn(),
    getTracks: () => [microphoneTrack],
  };
  const params: any = {
    peerConnectionRef: { current: peerConnection },
    localStreamRef: { current: localStream },
    setLocalStream: jest.fn(),
    setStatus: jest.fn(),
    renegotiate,
  };

  

  const resultRef: { current: any; } = { current: null };
  act(() => {
    renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });

  return {
    resultRef,
    params,
    peerConnection,
    sender,
    audioSender,
    addedVideoSender,
    cameraTrack,
    localStream,
    microphoneTrack,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (screenShare.isScreenShareSupported as jest.Mock).mockReturnValue(true);
  (screenShare.isScreenAudioCaptureSupported as jest.Mock).mockReturnValue(true);
  (screenShare.verifyScreenShareFrames as jest.Mock).mockResolvedValue({ ok: true, frames: 1, verified: true });
});

describe('useScreenShare', () => {
  test('requests screen audio by default when starting a share', async () => {
    const screenVideoTrack = makeTrack('video');
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: screenVideoTrack,
      audioTrack: null,
      audioShared: false,
    });
    const renegotiate = jest.fn(() => Promise.resolve());
    const { resultRef, params, sender, cameraTrack, localStream } = setup({ renegotiate });

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(screenShare.startScreenCapture).toHaveBeenCalledWith({ withAudio: true });
    expect(sender.replaceTrack).toHaveBeenCalledWith(screenVideoTrack);
    expect(cameraTrack.enabled).toBe(false);
    expect(localStream.removeTrack).toHaveBeenCalledWith(cameraTrack);
    expect(localStream.addTrack).toHaveBeenCalledWith(screenVideoTrack);
    expect(renegotiate).toHaveBeenCalledTimes(1);
    expect(resultRef.current.isScreenSharing).toBe(true);
    expect(resultRef.current.isScreenAudioShared).toBe(false);
    expect(params.setStatus).toHaveBeenCalledWith(
      'Screen sharing started without system audio: audio capture unsupported.',
      'warning',
    );
  });

  test('adds a screen audio sender and renegotiates when screen audio is enabled', async () => {
    const screenVideoTrack = makeTrack('video');
    const screenAudioTrack = makeTrack('audio');
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: screenVideoTrack,
      audioTrack: screenAudioTrack,
      audioShared: true,
    });
    const renegotiate = jest.fn(() => Promise.resolve());
    const { resultRef, params, peerConnection } = setup({ renegotiate });

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(screenShare.startScreenCapture).toHaveBeenCalledWith({ withAudio: true });
    expect(peerConnection.addTrack).toHaveBeenCalledWith(screenAudioTrack, { id: 'screen' });
    expect(renegotiate).toHaveBeenCalledTimes(1);
    expect(resultRef.current.isScreenAudioShared).toBe(true);
    expect(params.setStatus).toHaveBeenCalledWith('Sharing screen with audio', 'success');
  });

  test('warns when screen audio was requested but not provided by the platform', async () => {
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: makeTrack('video'),
      audioTrack: null,
      audioShared: false,
    });
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(params.setStatus).toHaveBeenCalledWith(
      'Screen sharing started without system audio: audio capture unsupported.',
      'warning',
    );
  });

  test('restores the camera track and releases the capture when sharing stops', async () => {
    const screenVideoTrack = makeTrack('video');
    const screenStream = { id: 'screen' };
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: screenStream,
      videoTrack: screenVideoTrack,
      audioTrack: null,
      audioShared: false,
    });
    const renegotiate = jest.fn(() => Promise.resolve());
    const { resultRef, sender, cameraTrack, localStream } = setup({ renegotiate });

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });
    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(sender.replaceTrack).toHaveBeenLastCalledWith(cameraTrack);
    expect(cameraTrack.enabled).toBe(true);
    expect(localStream.removeTrack).toHaveBeenCalledWith(screenVideoTrack);
    expect(screenShare.stopScreenCapture).toHaveBeenCalledWith(screenStream);
    expect(resultRef.current.isScreenSharing).toBe(false);
    expect(renegotiate).toHaveBeenCalledTimes(2);
  });

  test('applies screen-tuned encoder parameters and a detail content hint on start', async () => {
    const screenVideoTrack = makeTrack('video');
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: screenVideoTrack,
      audioTrack: null,
      audioShared: false,
    });
    const { resultRef, sender } = setup();

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(screenVideoTrack.contentHint).toBe('detail');
    expect(sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        degradationPreference: 'maintain-resolution',
        encodings: [
          expect.objectContaining({
            maxBitrate: 2_500_000,
            scaleResolutionDownBy: 1,
          }),
        ],
      }),
    );
  });

  test('restores the previous encoder parameters when sharing stops', async () => {
    const screenVideoTrack = makeTrack('video');
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: screenVideoTrack,
      audioTrack: null,
      audioShared: false,
    });
    const initialParameters = { encodings: [{ maxBitrate: 500_000 }] };
    const { resultRef, sender } = setup({ initialParameters });

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });
    (sender.setParameters as jest.Mock).mockClear();
    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(sender.setParameters).toHaveBeenCalledWith(initialParameters);
  });

  test('does not throw when the sender cannot report or accept encoder parameters', async () => {
    const screenVideoTrack = makeTrack('video');
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: screenVideoTrack,
      audioTrack: null,
      audioShared: false,
    });
    const { resultRef } = setup({ senderSupportsParameters: false });

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });
    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(resultRef.current.isScreenSharing).toBe(false);
  });

  test('removes the screen audio sender and renegotiates on stop', async () => {
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: makeTrack('video'),
      audioTrack: makeTrack('audio'),
      audioShared: true,
    });
    const renegotiate = jest.fn(() => Promise.resolve());
    const { resultRef, peerConnection, audioSender } = setup({ renegotiate });

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });
    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(audioSender.replaceTrack).toHaveBeenCalledWith(null);
    expect(peerConnection.removeTrack).toHaveBeenCalledWith(audioSender);
    expect(renegotiate).toHaveBeenCalledTimes(2);
  });

  test('removes the video sender it added for an audio-only call on stop', async () => {
    const screenVideoTrack = makeTrack('video');
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: screenVideoTrack,
      audioTrack: null,
      audioShared: false,
    });
    const { resultRef, peerConnection, addedVideoSender } = setup({ hasCameraSender: false });

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(peerConnection.addTrack).toHaveBeenCalledWith(screenVideoTrack, { id: 'screen' });

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    // Left in place, the sender would freeze the last captured frame on the
    // remote side for the rest of the call.
    expect(addedVideoSender.replaceTrack).toHaveBeenCalledWith(null);
    expect(peerConnection.removeTrack).toHaveBeenCalledWith(addedVideoSender);
  });

  test('reports a cancelled capture without changing sharing state', async () => {
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: false,
      reason: 'cancelled',
      message: 'Screen sharing permission denied',
    });
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(resultRef.current.isScreenSharing).toBe(false);
    expect(params.setStatus).toHaveBeenCalledWith('Screen sharing cancelled');
  });

  test('surfaces capture failures as errors', async () => {
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: false,
      reason: 'unsupported',
      message: 'Screen sharing is not supported on this device',
    });
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(params.setStatus).toHaveBeenCalledWith(
      'Screen sharing is not supported on this device',
      'error',
    );
  });

  test('puts the camera back on the sender when the share fails to start', async () => {
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: makeTrack('video'),
      audioTrack: makeTrack('audio'),
      audioShared: true,
    });
    const { resultRef, params, sender, cameraTrack, peerConnection } = setup();
    // The screen track is already on the sender by the time the audio sender
    // fails to attach.
    peerConnection.addTrack.mockImplementationOnce(() => {
      throw new Error('peer connection is closed');
    });

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    // Without the restore the sender would stay pinned to the stopped screen
    // track and the remote peer would see its last frame for the whole call.
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(cameraTrack);
    expect(cameraTrack.enabled).toBe(true);
    expect(resultRef.current.isScreenSharing).toBe(false);
    expect(params.setStatus).toHaveBeenCalledWith('Unable to start screen sharing', 'error');
  });

  test('requires an active peer connection', async () => {
    const { resultRef, params } = setup();
    params.peerConnectionRef.current = null;

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(screenShare.startScreenCapture).not.toHaveBeenCalled();
    expect(params.setStatus).toHaveBeenCalledWith('Screen sharing needs an active call', 'error');
  });

  test('keeps the screen audio preference stable while sharing', async () => {
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: makeTrack('video'),
      audioTrack: null,
      audioShared: false,
    });
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });
    act(() => {
      resultRef.current.handleScreenAudioToggle();
    });

    expect(resultRef.current.isScreenAudioEnabled).toBe(true);
    expect(params.setStatus).toHaveBeenCalledWith(
      'Stop sharing to change the screen audio setting',
    );
  });

  test('stops offering screen audio once a capture proves it unavailable', async () => {
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: makeTrack('video'),
      audioTrack: null,
      audioShared: false,
      audioFallbackReason: 'unsupported',
    });
    // Mirrors the module: audio is worth requesting until a capture has shown
    // this runtime never hands one back.
    (screenShare.isScreenAudioCaptureSupported as jest.Mock).mockImplementation(
      () => (screenShare.startScreenCapture as jest.Mock).mock.calls.length === 0,
    );
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(screenShare.startScreenCapture).toHaveBeenCalledWith({ withAudio: true });
    expect(resultRef.current.isScreenAudioSupported).toBe(false);
    expect(resultRef.current.isScreenAudioEnabled).toBe(false);
    // The fallback is reported once, not once per phase of the start.
    expect(
      params.setStatus.mock.calls.filter(([message]: any[]) =>
        String(message).includes('without system audio')).length,
    ).toBe(1);
  });

  test('refuses the screen audio toggle on a device that cannot capture it', async () => {
    (screenShare.isScreenAudioCaptureSupported as jest.Mock).mockReturnValue(false);
    const { resultRef, params } = setup();

    act(() => {
      resultRef.current.handleScreenAudioToggle();
    });

    expect(resultRef.current.isScreenAudioEnabled).toBe(false);
    expect(params.setStatus).toHaveBeenCalledWith(
      'This device cannot capture system audio',
      'warning',
    );
  });

  test('stops sharing when the OS ends the capture', async () => {
    const screenVideoTrack = makeTrack('video');
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: screenVideoTrack,
      audioTrack: null,
      audioShared: false,
    });
    const { resultRef } = setup();

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });
    await act(async () => {
      screenVideoTrack.onended();
    });

    expect(resultRef.current.isScreenSharing).toBe(false);
  });

  test('keeps sharing and reports unverified delivery when no frames are confirmed yet', async () => {
    const screenVideoTrack = makeTrack('video');
    const stream = { id: 'screen' };
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream,
      videoTrack: screenVideoTrack,
      audioTrack: null,
      audioShared: false,
    });
    (screenShare.verifyScreenShareFrames as jest.Mock).mockResolvedValue({
      ok: false,
      reason: 'no_frames',
      message: 'Screen sharing produced no video',
    });

    const { resultRef, params, sender, cameraTrack } = setup();

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(resultRef.current.isScreenSharing).toBe(true);
    expect(resultRef.current.screenShareDelivery).toBe('unverified');
    expect(screenShare.stopScreenCapture).not.toHaveBeenCalledWith(stream);
    expect(sender.replaceTrack).not.toHaveBeenLastCalledWith(cameraTrack);
    expect(params.setStatus).toHaveBeenLastCalledWith(
      'Screen sharing started, but the remote view is not confirmed yet. Open the app you want to share or minimise WeTalk once.',
      'warning',
    );
  });
});

describe('useScreenShare frame delivery', () => {
  /** Start a share whose frame verification resolves to `frameCheck`. */
  async function share(frameCheck: any) {
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: makeTrack('video'),
      audioTrack: null,
      audioShared: false,
    });
    (screenShare.verifyScreenShareFrames as jest.Mock).mockResolvedValue(frameCheck);

    const harness = setup();
    await act(async () => {
      await harness.resultRef.current.handleScreenShareToggle();
    });
    return harness;
  }

  test('is idle before anything is shared', () => {
    const { resultRef } = setup();
    expect(resultRef.current.screenShareDelivery).toBe('idle');
  });

  test('settles on confirmed once outbound frames are counted', async () => {
    const { resultRef } = await share({ ok: true, frames: 12, verified: true });
    expect(resultRef.current.screenShareDelivery).toBe('confirmed');
  });

  test('stays unverified when the stats could not be read', async () => {
    // Not a failure — the share runs — but the peer's view is unknown, so the
    // UI must not promise they can see anything.
    const { resultRef } = await share({ ok: true, frames: null, verified: false });
    expect(resultRef.current.screenShareDelivery).toBe('unverified');
  });

  test('returns to idle when the share stops', async () => {
    const { resultRef } = await share({ ok: true, frames: 3, verified: true });

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(resultRef.current.screenShareDelivery).toBe('idle');
  });

  test('a share that never delivered a frame is shown as unverified (not failed)', async () => {
    const { resultRef } = await share({
      ok: false,
      reason: 'no_frames',
      message: 'Screen sharing produced no video',
    });
    expect(resultRef.current.screenShareDelivery).toBe('unverified');
  });
});

describe('useScreenShare in-flight state', () => {
  test('reports the toggle as in flight until the capture settles', async () => {
    let releaseCapture: (value: any) => void = () => {};
    (screenShare.startScreenCapture as jest.Mock).mockReturnValue(
      new Promise(resolve => {
        releaseCapture = resolve;
      }),
    );
    const { resultRef } = setup({ renegotiate: jest.fn(() => Promise.resolve()) });

    expect(resultRef.current.isTogglingScreenShare).toBe(false);

    let toggled: Promise<void>;
    act(() => {
      toggled = resultRef.current.handleScreenShareToggle();
    });
    expect(resultRef.current.isTogglingScreenShare).toBe(true);

    await act(async () => {
      releaseCapture({
        ok: true,
        stream: { id: 'screen' },
        videoTrack: makeTrack('video'),
        audioTrack: null,
        audioShared: false,
      });
      await toggled;
    });

    expect(resultRef.current.isTogglingScreenShare).toBe(false);
    expect(resultRef.current.isScreenSharing).toBe(true);
  });
});

describe('useScreenShare with the native system-audio mixer', () => {
  const originalPlatform = Platform.OS;

  function installMixer(overrides: Record<string, unknown> = {}) {
    const native = {
      start: jest.fn().mockResolvedValue({
        installed: true,
        state: 'CAPTURING',
        sharing: true,
        mixedFrames: 100,
      }),
      stop: jest.fn().mockResolvedValue({ installed: true, state: 'IDLE', sharing: false }),
      getStatus: jest.fn().mockResolvedValue({ installed: true, state: 'CAPTURING' }),
      setMicrophoneMuted: jest.fn().mockResolvedValue(true),
      ...overrides,
    };
    (NativeModules as Record<string, unknown>).ScreenAudio = native;
    return native;
  }

  function captureWithoutAudioTrack() {
    (screenShare.startScreenCapture as jest.Mock).mockResolvedValue({
      ok: true,
      stream: { id: 'screen' },
      videoTrack: makeTrack('video'),
      audioTrack: null,
      audioShared: false,
    });
  }

  beforeEach(() => {
    Platform.OS = 'android';
    resetSystemAudioState();
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    delete (NativeModules as Record<string, unknown>).ScreenAudio;
  });

  test('mixes system audio instead of asking getDisplayMedia for a track', async () => {
    const native = installMixer();
    captureWithoutAudioTrack();
    const { resultRef, params, peerConnection } = setup();

    await act(async () => {
      await resultRef.current.startScreenShare();
    });

    // Asking for an audio track the platform never returns would teach the app
    // that screen audio is impossible and disable the option for the session.
    expect(screenShare.startScreenCapture).toHaveBeenCalledWith({ withAudio: false });
    expect(native.start).toHaveBeenCalled();
    expect(resultRef.current.isScreenAudioShared).toBe(true);
    // The mix rides the existing microphone track, so no extra sender exists.
    expect(peerConnection.addTrack).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'audio' }),
      expect.anything(),
    );
    expect(params.setStatus).toHaveBeenLastCalledWith('Sharing screen with audio', 'success');
  });

  test('offers screen audio even after a capture returned no audio track', async () => {
    installMixer();
    (screenShare.isScreenAudioCaptureSupported as jest.Mock).mockReturnValue(false);
    captureWithoutAudioTrack();
    const { resultRef } = setup();

    await act(async () => {
      await resultRef.current.startScreenShare();
    });

    expect(resultRef.current.isScreenAudioSupported).toBe(true);
  });

  test('warns with the reason when the mixer cannot start', async () => {
    installMixer({
      start: jest.fn().mockResolvedValue({
        installed: true,
        state: 'UNAVAILABLE',
        sharing: false,
        reason: 'No screen share is running',
      }),
    });
    captureWithoutAudioTrack();
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.startScreenShare();
    });

    expect(resultRef.current.isScreenAudioShared).toBe(false);
    expect(params.setStatus).toHaveBeenLastCalledWith(
      'Screen sharing started without system audio: No screen share is running.',
      'warning',
    );
  });

  test('does not promise audio while the capture is hearing only silence', async () => {
    installMixer({
      start: jest
        .fn()
        .mockResolvedValue({ installed: true, state: 'SILENT', sharing: true, mixedFrames: 0 }),
    });
    captureWithoutAudioTrack();
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.startScreenShare();
    });

    expect(params.setStatus).toHaveBeenLastCalledWith(
      'Sharing screen. No system audio captured yet — some apps block audio capture.',
      'warning',
    );
  });

  test('re-enables a muted microphone track so the mix is not silenced with it', async () => {
    const native = installMixer();
    captureWithoutAudioTrack();
    const { resultRef, microphoneTrack } = setup();
    // Muting before the share disabled the track; the mix travels on it.
    applyMicrophoneMute(true);
    microphoneTrack.enabled = false;

    await act(async () => {
      await resultRef.current.startScreenShare();
    });

    expect(microphoneTrack.enabled).toBe(true);
    expect(native.setMicrophoneMuted).toHaveBeenCalledWith(true);
  });

  test('hands the mute back to the track when the share stops', async () => {
    const native = installMixer();
    captureWithoutAudioTrack();
    const { resultRef, microphoneTrack } = setup();
    applyMicrophoneMute(true);

    await act(async () => {
      await resultRef.current.startScreenShare();
    });
    expect(microphoneTrack.enabled).toBe(true);

    await act(async () => {
      await resultRef.current.stopScreenShare();
    });

    expect(native.stop).toHaveBeenCalled();
    expect(microphoneTrack.enabled).toBe(false);
  });

  test('stops the mix when the share fails to attach', async () => {
    const native = installMixer();
    captureWithoutAudioTrack();
    const { resultRef, peerConnection } = setup();
    peerConnection.removeTrack.mockImplementation(() => undefined);
    (screenShare.verifyScreenShareFrames as jest.Mock).mockRejectedValue(new Error('attach failed'));

    await act(async () => {
      await resultRef.current.startScreenShare();
    });

    expect(native.stop).toHaveBeenCalled();
    expect(resultRef.current.isScreenAudioShared).toBe(false);
  });
});
