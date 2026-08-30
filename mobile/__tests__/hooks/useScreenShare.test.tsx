import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useScreenShare from '../../src/hooks/useScreenShare';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));
jest.mock('../../src/screenShare', () => ({
  SCREEN_SHARE_CANCELLED: 'cancelled',
  SCREEN_SHARE_NO_FRAMES: 'no_frames',
  isScreenShareSupported: jest.fn(() => true),
  startScreenCapture: jest.fn(),
  stopScreenCapture: jest.fn(),
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

function setup({ renegotiate = jest.fn(() => Promise.resolve()) } = {}) {
  const cameraTrack = makeTrack('video');
  const sender = { track: cameraTrack, replaceTrack: jest.fn(() => Promise.resolve()) };
  const audioSender = { replaceTrack: jest.fn(() => Promise.resolve()) };
  const peerConnection = {
    getSenders: jest.fn(() => [sender]),
    addTrack: jest.fn(() => audioSender),
    removeTrack: jest.fn(),
  };
  const localStream = { addTrack: jest.fn(), removeTrack: jest.fn() };
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

  return { resultRef, params, peerConnection, sender, audioSender, cameraTrack, localStream };
}

beforeEach(() => {
  jest.clearAllMocks();
  (screenShare.isScreenShareSupported as jest.Mock).mockReturnValue(true);
  (screenShare.verifyScreenShareFrames as jest.Mock).mockResolvedValue({ ok: true, frames: 1, verified: true });
});

describe('useScreenShare', () => {
  test('starts video-only sharing by replacing the camera track and renegotiating', async () => {
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

    expect(screenShare.startScreenCapture).toHaveBeenCalledWith({ withAudio: false });
    expect(sender.replaceTrack).toHaveBeenCalledWith(screenVideoTrack);
    expect(cameraTrack.enabled).toBe(false);
    expect(localStream.removeTrack).toHaveBeenCalledWith(cameraTrack);
    expect(localStream.addTrack).toHaveBeenCalledWith(screenVideoTrack);
    expect(renegotiate).toHaveBeenCalledTimes(1);
    expect(resultRef.current.isScreenSharing).toBe(true);
    expect(resultRef.current.isScreenAudioShared).toBe(false);
    expect(params.setStatus).toHaveBeenCalledWith('Sharing screen', 'success');
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

    act(() => {
      resultRef.current.handleScreenAudioToggle();
    });
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

    act(() => {
      resultRef.current.handleScreenAudioToggle();
    });
    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });

    expect(params.setStatus).toHaveBeenCalledWith(
      'Sharing screen (screen audio unavailable on this device)',
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

    act(() => {
      resultRef.current.handleScreenAudioToggle();
    });
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

    expect(resultRef.current.isScreenAudioEnabled).toBe(false);
    expect(params.setStatus).toHaveBeenCalledWith(
      'Stop sharing to change the screen audio setting',
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
