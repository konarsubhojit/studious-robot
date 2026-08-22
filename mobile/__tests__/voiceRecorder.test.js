// @ts-check
/**
 * Tests the optional-native-module (try/catch require) pattern in
 * `voiceRecorder.js`, mirroring `attachmentPicker.test.js`.
 *
 * `voiceRecorder.js` requires both `react-native-nitro-sound`
 * (lazily, optional) and `react-native-fs` (eagerly, a hard dependency), and
 * every test here reloads the module fresh via `jest.isolateModules` so each
 * test starts from a clean `_recorderCache`/`_lastPositionMs`. Both mocks are
 * registered *inside* that same isolated block (rather than one at the top
 * of the file) so the fresh module instance and its mocked dependencies are
 * always the same sandboxed copies — mixing a top-level `jest.mock` for one
 * dependency with `isolateModules` for the other let the two disagree on
 * which `react-native-fs` instance was in play, which was intermittently
 * flaky.
 */

function withRecorderMock(
  /** @type {any} */ fakeSound,
  /** @type {any} */ run,
  { statImpl = jest.fn().mockResolvedValue({ size: 4096 }) } = {},
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
    jest.doMock('react-native-fs', () => ({ stat: statImpl }));
    result = run(require('../src/voiceRecorder'));
  });
  return result;
}

describe('voiceRecorder', () => {
  test('degrades to unavailable when the native module is not linked', async () => {
    await withRecorderMock(null, async (/** @type {any} */ recorder) => {
      expect(recorder.isVoiceRecorderAvailable()).toBe(false);
      await expect(recorder.startVoiceRecording()).resolves.toBe(false);
      await expect(recorder.stopVoiceRecording()).resolves.toBeNull();
    });
  });

  test('degrades to unavailable when the Nitro HybridObject cannot be created', async () => {
    // `react-native-nitro-sound` exports a lazy proxy, so a missing native
    // module only throws once a member is read rather than at require time.
    const throwingSound = new Proxy(
      {},
      {
        get() {
          throw new Error('Failed to create Sound HybridObject');
        },
      },
    );

    await withRecorderMock(throwingSound, async (/** @type {any} */ recorder) => {
      expect(recorder.isVoiceRecorderAvailable()).toBe(false);
      await expect(recorder.startVoiceRecording()).resolves.toBe(false);
      await expect(recorder.stopVoiceRecording()).resolves.toBeNull();
    });
  });

  test('starts and stops a recording, capping duration at MAX_VOICE_DURATION_MS and reporting the file size', async () => {
    const fakeSound = {
      startRecorder: jest.fn().mockResolvedValue('file:///tmp/note.m4a'),
      stopRecorder: jest.fn().mockResolvedValue('file:///tmp/note.m4a'),
      addRecordBackListener: jest.fn(callback => {
        // 11 minutes elapsed — over the 10-minute cap.
        callback({ currentPosition: 11 * 60 * 1000 });
      }),
      removeRecordBackListener: jest.fn(),
    };

    await withRecorderMock(fakeSound, async (/** @type {any} */ recorder) => {
      await expect(recorder.startVoiceRecording()).resolves.toBe(true);
      const result = await recorder.stopVoiceRecording();
      expect(result).toEqual({
        uri: 'file:///tmp/note.m4a',
        mimeType: 'audio/aac',
        durationMs: 10 * 60 * 1000,
        sizeBytes: 4096,
      });
    });
  });

  test('reports sizeBytes as 0 when the recorded file cannot be statted', async () => {
    const fakeSound = {
      startRecorder: jest.fn().mockResolvedValue('file:///tmp/note.m4a'),
      stopRecorder: jest.fn().mockResolvedValue('file:///tmp/note.m4a'),
      addRecordBackListener: jest.fn(callback => callback({ currentPosition: 3000 })),
      removeRecordBackListener: jest.fn(),
    };

    await withRecorderMock(
      fakeSound,
      async (/** @type {any} */ recorder) => {
        await recorder.startVoiceRecording();
        const result = await recorder.stopVoiceRecording();
        expect(result).toEqual({
          uri: 'file:///tmp/note.m4a',
          mimeType: 'audio/aac',
          durationMs: 3000,
          sizeBytes: 0,
        });
      },
      { statImpl: jest.fn().mockRejectedValue(new Error('ENOENT')) },
    );
  });

  test('returns null from stopVoiceRecording when the recorder produced no file', async () => {
    const fakeSound = {
      startRecorder: jest.fn(),
      stopRecorder: jest.fn().mockResolvedValue(null),
      addRecordBackListener: jest.fn(),
      removeRecordBackListener: jest.fn(),
    };
    await withRecorderMock(fakeSound, async (/** @type {any} */ recorder) => {
      await expect(recorder.stopVoiceRecording()).resolves.toBeNull();
    });
  });
});
