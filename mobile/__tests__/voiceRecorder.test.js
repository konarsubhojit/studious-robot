/**
 * Tests the optional-native-module (try/catch require) pattern in
 * `voiceRecorder.js`, mirroring `attachmentPicker.test.js`.
 *
 * `voiceRecorder.js` requires both `react-native-audio-recorder-player`
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

function withRecorderMock(RecorderClass, run, { statImpl = jest.fn().mockResolvedValue({ size: 4096 }) } = {}) {
  let result;
  jest.isolateModules(() => {
    if (RecorderClass) {
      jest.doMock('react-native-audio-recorder-player', () => ({ default: RecorderClass }));
    } else {
      jest.doMock('react-native-audio-recorder-player', () => {
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
    await withRecorderMock(null, async recorder => {
      expect(recorder.isVoiceRecorderAvailable()).toBe(false);
      await expect(recorder.startVoiceRecording()).resolves.toBe(false);
      await expect(recorder.stopVoiceRecording()).resolves.toBeNull();
    });
  });

  test('starts and stops a recording, capping duration at MAX_VOICE_DURATION_MS and reporting the file size', async () => {
    class FakeRecorder {
      startRecorder = jest.fn().mockResolvedValue('file:///tmp/note.m4a');
      stopRecorder = jest.fn().mockResolvedValue('file:///tmp/note.m4a');
      addRecordBackListener = jest.fn(callback => {
        // 11 minutes elapsed — over the 10-minute cap.
        callback({ currentPosition: 11 * 60 * 1000 });
      });
      removeRecordBackListener = jest.fn();
    }

    await withRecorderMock(FakeRecorder, async recorder => {
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
    class FakeRecorder {
      startRecorder = jest.fn().mockResolvedValue('file:///tmp/note.m4a');
      stopRecorder = jest.fn().mockResolvedValue('file:///tmp/note.m4a');
      addRecordBackListener = jest.fn(callback => callback({ currentPosition: 3000 }));
      removeRecordBackListener = jest.fn();
    }

    await withRecorderMock(
      FakeRecorder,
      async recorder => {
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
    class FakeRecorder {
      startRecorder = jest.fn();
      stopRecorder = jest.fn().mockResolvedValue(null);
      addRecordBackListener = jest.fn();
      removeRecordBackListener = jest.fn();
    }
    await withRecorderMock(FakeRecorder, async recorder => {
      await expect(recorder.stopVoiceRecording()).resolves.toBeNull();
    });
  });
});
