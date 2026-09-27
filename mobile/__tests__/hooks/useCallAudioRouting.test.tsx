import React from 'react';
import { NativeModules, Platform } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import useCallAudioRouting from '../../src/hooks/useCallAudioRouting';
import { AUDIO_ROUTES } from '../../src/audioRouting';
import {
  isMicrophoneMuted,
  resetSystemAudioState,
  startSystemAudio,
} from '../../src/screenAudio';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('../../src/audioRouting', () => ({
  AUDIO_ROUTES: {
    SPEAKER_PHONE: 'SPEAKER_PHONE',
    EARPIECE: 'EARPIECE',
    BLUETOOTH: 'BLUETOOTH',
    WIRED_HEADSET: 'WIRED_HEADSET',
  },
  DETACHABLE_AUDIO_ROUTES: ['BLUETOOTH', 'WIRED_HEADSET'],
  getAudioRouteLabel: jest.fn((route?: string) => ({
    SPEAKER_PHONE: 'Speaker',
    EARPIECE: 'Earpiece',
    BLUETOOTH: 'Bluetooth',
    WIRED_HEADSET: 'Wired headset',
  }[route ?? ''] ?? route ?? 'Unknown')),
  applyPreferredAudioRoute: jest.fn(),
  chooseAudioRoute: jest.fn(),
  restoreInCallAudioSession: jest.fn(),
  setAudioRoute: jest.fn(),
  startAudioSession: jest.fn(),
  stopAudioSession: jest.fn(),
  subscribeAudioDevices: jest.fn(),
}));

jest.mock('../../src/haptics', () => ({
  triggerHaptic: jest.fn(),
}));

const audioRouting = require('../../src/audioRouting');
const { triggerHaptic } = require('../../src/haptics');

function TestHook({ resultRef, params }: any) {
  resultRef.current = useCallAudioRouting(params);
  return null;
}

function makeStream(audioEnabled = true): any {
  // One stable track, so a test can assert what the hook left `enabled` at.
  const tracks = [{ kind: 'audio', enabled: audioEnabled }];
  return { getTracks: jest.fn(() => tracks) };
}

function setup(overrides: any = {}) {
  const params: any = {
    isInCall: true,
    isInCallRef: { current: true },
    isMuted: false,
    localStreamRef: { current: makeStream(true) },
    setIsMuted: jest.fn(),
    speakerEnabledByDefault: false,
    updateStatus: jest.fn(),
    ...overrides,
  };
  const resultRef: { current: any; } = { current: null };
  let instance: renderer.ReactTestRenderer;
  act(() => {
    instance = renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });
  return { resultRef, params, instance: instance! };
}

beforeEach(() => {
  jest.clearAllMocks();
  audioRouting.startAudioSession.mockReturnValue({ ok: true });
  audioRouting.stopAudioSession.mockReturnValue({ ok: true });
  audioRouting.setAudioRoute.mockReturnValue({ ok: true, selected: AUDIO_ROUTES.SPEAKER_PHONE });
  audioRouting.applyPreferredAudioRoute.mockResolvedValue({
    ok: true,
    available: [AUDIO_ROUTES.EARPIECE, AUDIO_ROUTES.SPEAKER_PHONE],
    selected: AUDIO_ROUTES.EARPIECE,
  });
  audioRouting.chooseAudioRoute.mockResolvedValue({
    ok: true,
    available: [AUDIO_ROUTES.EARPIECE, AUDIO_ROUTES.SPEAKER_PHONE],
    selected: AUDIO_ROUTES.SPEAKER_PHONE,
  });
  audioRouting.restoreInCallAudioSession.mockResolvedValue({ ok: true });
  audioRouting.subscribeAudioDevices.mockReturnValue(jest.fn());
});

describe('useCallAudioRouting', () => {
  test('starts and stops the in-call audio session with the call', () => {
    const unsubscribe = jest.fn();
    audioRouting.subscribeAudioDevices.mockReturnValue(unsubscribe);
    const { instance } = setup();

    expect(audioRouting.startAudioSession).toHaveBeenCalledTimes(1);
    expect(audioRouting.subscribeAudioDevices).toHaveBeenCalledTimes(1);

    act(() => {
      instance.unmount();
    });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(audioRouting.stopAudioSession).toHaveBeenCalledTimes(1);
  });

  test('chooses a manual audio route and publishes the discovered devices', async () => {
    const { resultRef, params } = setup({ isInCall: false, isInCallRef: { current: false } });

    await act(async () => {
      await resultRef.current.chooseAudioOutput(AUDIO_ROUTES.SPEAKER_PHONE);
    });

    expect(audioRouting.chooseAudioRoute).toHaveBeenCalledWith(AUDIO_ROUTES.SPEAKER_PHONE);
    expect(resultRef.current.audioDevices).toEqual({
      available: [AUDIO_ROUTES.EARPIECE, AUDIO_ROUTES.SPEAKER_PHONE],
      selected: AUDIO_ROUTES.SPEAKER_PHONE,
    });
    expect(resultRef.current.isSpeakerEnabled).toBe(true);
    expect(params.updateStatus).toHaveBeenCalledWith('Audio: Speaker');
  });

  test('restores the selected audio route after unmuting during a call', async () => {
    const stream = makeStream(false);
    const overrides: any = {
      isMuted: true,
      localStreamRef: { current: stream },
    };
    const { resultRef, params } = setup(overrides);
    await act(async () => {
      await resultRef.current.chooseAudioOutput(AUDIO_ROUTES.BLUETOOTH);
    });

    act(() => {
      resultRef.current.handleMuteToggle();
    });
    await act(async () => {});

    expect(triggerHaptic).toHaveBeenCalledWith('tap');
    expect(params.setIsMuted).toHaveBeenCalledWith(false);
    expect(audioRouting.restoreInCallAudioSession).toHaveBeenCalledWith(AUDIO_ROUTES.SPEAKER_PHONE);
  });

  test('upgrades the automatic earpiece route when speaker is enabled by default', async () => {
    setup({ speakerEnabledByDefault: true });
    await act(async () => {});

    expect(audioRouting.applyPreferredAudioRoute).toHaveBeenCalledWith([]);
    expect(audioRouting.chooseAudioRoute).toHaveBeenCalledWith(AUDIO_ROUTES.SPEAKER_PHONE);
  });

  test('announces a detached manual headset and resumes automatic routing', async () => {
    let deviceListener: any;
    audioRouting.subscribeAudioDevices.mockImplementation((listener: any) => {
      deviceListener = listener;
      return jest.fn();
    });
    const { resultRef, params } = setup();
    await act(async () => {
      await resultRef.current.chooseAudioOutput(AUDIO_ROUTES.WIRED_HEADSET);
    });
    audioRouting.applyPreferredAudioRoute.mockClear();

    act(() => {
      deviceListener({
        available: [AUDIO_ROUTES.EARPIECE, AUDIO_ROUTES.SPEAKER_PHONE],
        selected: AUDIO_ROUTES.EARPIECE,
      });
    });
    await act(async () => {});

    expect(params.updateStatus).toHaveBeenCalledWith(
      'Wired headset disconnected — switching audio output',
    );
    expect(audioRouting.applyPreferredAudioRoute).toHaveBeenCalledWith([
      AUDIO_ROUTES.EARPIECE,
      AUDIO_ROUTES.SPEAKER_PHONE,
    ]);
  });
});

describe('useCallAudioRouting while system audio is shared', () => {
  const originalPlatform = Platform.OS;
  let native: Record<string, jest.Mock>;

  beforeEach(async () => {
    Platform.OS = 'android';
    resetSystemAudioState();
    native = {
      start: jest.fn().mockResolvedValue({ installed: true, state: 'CAPTURING', sharing: true }),
      stop: jest.fn().mockResolvedValue({ installed: true, state: 'IDLE', sharing: false }),
      getStatus: jest.fn().mockResolvedValue({ installed: true, state: 'CAPTURING' }),
      setMicrophoneMuted: jest.fn().mockResolvedValue(true),
    };
    (NativeModules as Record<string, unknown>).ScreenAudio = native;
    await startSystemAudio();
    jest.clearAllMocks();
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
    delete (NativeModules as Record<string, unknown>).ScreenAudio;
    resetSystemAudioState();
  });

  test('mutes at the audio device module and leaves the shared audio audible', async () => {
    const stream = makeStream(true);
    const { resultRef, params } = setup({ localStreamRef: { current: stream } });

    act(() => {
      resultRef.current.handleMuteToggle();
    });
    await act(async () => {});

    expect(native.setMicrophoneMuted).toHaveBeenCalledWith(true);
    // Disabling the track would take the mixed system audio down with it.
    expect(stream.getTracks()[0].enabled).toBe(true);
    expect(params.setIsMuted).toHaveBeenCalledWith(true);
  });

  test('still mutes when there is no local stream to disable', async () => {
    const { resultRef, params } = setup({ localStreamRef: { current: null } });

    act(() => {
      resultRef.current.handleMuteToggle();
    });
    await act(async () => {});

    expect(native.setMicrophoneMuted).toHaveBeenCalledWith(true);
    expect(params.updateStatus).not.toHaveBeenCalledWith(
      'Start preview to control audio',
      'error',
    );
  });
});

describe('useCallAudioRouting mute bookkeeping', () => {
  beforeEach(() => {
    resetSystemAudioState();
  });

  afterEach(() => {
    resetSystemAudioState();
  });

  test('remembers a mute that was applied to the local track', () => {
    const { resultRef } = setup({ isMuted: false });

    act(() => {
      resultRef.current.handleMuteToggle();
    });

    expect(isMicrophoneMuted()).toBe(true);
  });

  test('does not remember a mute it could not apply', () => {
    // Muted, and the mirror agrees, having been applied to the track.
    const first = setup({ isMuted: false });
    act(() => {
      first.resultRef.current.handleMuteToggle();
    });
    expect(isMicrophoneMuted()).toBe(true);

    // Now there is nothing to unmute, so the toggle fails and `isMuted` keeps
    // saying muted. The mirror must keep saying so too: it is replayed onto
    // the audio device module when system audio starts, so recording this
    // would silently unmute a microphone the UI shows as muted.
    const second = setup({ isMuted: true, localStreamRef: { current: null } });
    act(() => {
      second.resultRef.current.handleMuteToggle();
    });

    expect(second.params.updateStatus).toHaveBeenCalledWith(
      'Start preview to control audio',
      'error',
    );
    expect(second.params.setIsMuted).not.toHaveBeenCalled();
    expect(isMicrophoneMuted()).toBe(true);
  });
});
