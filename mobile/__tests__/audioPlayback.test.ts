/**
 * Tests the shared, single-instance chat audio player.
 *
 * Follows `voiceRecorder.test.ts`: the optional native module
 * (`react-native-nitro-sound`) is mocked inside `jest.isolateModules`, so each
 * test starts from a clean module cache and player state.
 */

function withPlayerMock(
  fakeSound: any,
  run: any,
  { isAudioSessionActive = jest.fn().mockReturnValue(false) } = {},
) {
  let result;
  jest.isolateModules(() => {
    if (fakeSound) {
      jest.doMock('react-native-nitro-sound', () => ({ default: fakeSound }));
    } else {
      jest.doMock('react-native-nitro-sound', () => {
        throw new Error('Native module is not linked');
      });
    }
    jest.doMock('../src/audioRouting', () => ({ isAudioSessionActive }));
    result = run(require('../src/audioPlayback'));
  });
  return result;
}

function makeSound(overrides = {}) {
  return {
    startPlayer: jest.fn().mockResolvedValue('ok'),
    pausePlayer: jest.fn().mockResolvedValue('ok'),
    resumePlayer: jest.fn().mockResolvedValue('ok'),
    stopPlayer: jest.fn().mockResolvedValue('ok'),
    seekToPlayer: jest.fn().mockResolvedValue('ok'),
    addPlayBackListener: jest.fn(),
    removePlayBackListener: jest.fn(),
    ...overrides,
  };
}

describe('audioPlayback', () => {
  test('degrades to unavailable when the native module is not linked', async () => {
    await withPlayerMock(null, async (player: any) => {
      expect(player.isAudioPlaybackAvailable()).toBe(false);
      await expect(player.playAudio('https://media.test/a.m4a')).resolves.toMatchObject({
        ok: false,
        reason: 'unavailable',
      });
    });
  });

  test('plays a source and reports playing state to subscribers', async () => {
    const sound = makeSound();
    await withPlayerMock(sound, async (player: any) => {
      const states: any[] = [];
      player.subscribeAudioPlayback((next: any) => states.push(next));

      await expect(
        player.playAudio('https://media.test/a.m4a', { durationMs: 4000 }),
      ).resolves.toEqual({ ok: true });

      expect(sound.startPlayer).toHaveBeenCalledWith('https://media.test/a.m4a');
      expect(player.getAudioPlaybackState()).toMatchObject({
        uri: 'https://media.test/a.m4a',
        isPlaying: true,
        durationMs: 4000,
      });
      expect(states.length).toBeGreaterThan(0);
    });
  });

  test('pause and resume flip the playing flag without releasing the player', async () => {
    const sound = makeSound();
    await withPlayerMock(sound, async (player: any) => {
      await player.playAudio('https://media.test/a.m4a');
      await player.pauseAudio();
      expect(player.getAudioPlaybackState().isPlaying).toBe(false);
      expect(sound.stopPlayer).not.toHaveBeenCalled();

      await player.resumeAudio();
      expect(player.getAudioPlaybackState().isPlaying).toBe(true);
    });
  });

  test('playing a second clip stops the first one (only one clip at a time)', async () => {
    const sound = makeSound();
    await withPlayerMock(sound, async (player: any) => {
      await player.playAudio('https://media.test/first.m4a');
      await player.playAudio('https://media.test/second.m4a');

      expect(sound.stopPlayer).toHaveBeenCalledTimes(1);
      expect(sound.startPlayer).toHaveBeenLastCalledWith('https://media.test/second.m4a');
      expect(player.getAudioPlaybackState().uri).toBe('https://media.test/second.m4a');
    });
  });

  test('refuses to play while a call owns the audio session', async () => {
    const sound = makeSound();
    await withPlayerMock(
      sound,
      async (player: any) => {
        await expect(player.playAudio('https://media.test/a.m4a')).resolves.toMatchObject({
          ok: false,
          reason: 'call-active',
        });
        expect(sound.startPlayer).not.toHaveBeenCalled();
      },
      { isAudioSessionActive: jest.fn().mockReturnValue(true) },
    );
  });

  test('a failed start releases the player and reports the reason', async () => {
    const sound = makeSound({ startPlayer: jest.fn().mockRejectedValue(new Error('no such file')) });
    await withPlayerMock(sound, async (player: any) => {
      await expect(player.playAudio('https://media.test/gone.m4a')).resolves.toMatchObject({
        ok: false,
        reason: 'failed',
      });
      expect(sound.removePlayBackListener).toHaveBeenCalled();
      expect(player.getAudioPlaybackState()).toMatchObject({ uri: null, isPlaying: false });
    });
  });

  test('reaching the end of a clip releases the player', async () => {
    const sound = makeSound();
    await withPlayerMock(sound, async (player: any) => {
      await player.playAudio('https://media.test/a.m4a');
      const emit = sound.addPlayBackListener.mock.calls[0][0];

      emit({ currentPosition: 1000, duration: 4000 });
      expect(player.getAudioPlaybackState()).toMatchObject({ positionMs: 1000, isPlaying: true });

      emit({ currentPosition: 4000, duration: 4000 });
      await Promise.resolve();
      expect(player.getAudioPlaybackState()).toMatchObject({ uri: null, isPlaying: false });
    });
  });

  test('seeking moves the reported position', async () => {
    const sound = makeSound();
    await withPlayerMock(sound, async (player: any) => {
      await player.playAudio('https://media.test/a.m4a', { durationMs: 8000 });
      await player.seekAudio(2500.6);

      expect(sound.seekToPlayer).toHaveBeenCalledWith(2501);
      expect(player.getAudioPlaybackState().positionMs).toBe(2501);
    });
  });

  test('formats elapsed/total times as m:ss', () => {
    withPlayerMock(makeSound(), (player: any) => {
      expect(player.formatPlaybackTime(0)).toBe('0:00');
      expect(player.formatPlaybackTime(65_000)).toBe('1:05');
      expect(player.formatPlaybackTime(null)).toBe('0:00');
    });
  });
});
