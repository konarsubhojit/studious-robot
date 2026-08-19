/**
 * Tests the optional-native-module (try/catch require) pattern in
 * `voiceRecorder.js`, mirroring `attachmentPicker.test.js`.
 */

function withRecorderMock(RecorderClass, run) {
  let result;
  jest.isolateModules(() => {
    if (RecorderClass) {
      jest.doMock('react-native-audio-recorder-player', () => ({ default: RecorderClass }), {
        virtual: true,
      });
    } else {
      jest.doMock(
        'react-native-audio-recorder-player',
        () => {
          throw new Error('Native module is not linked');
        },
        { virtual: true },
      );
    }
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

  test('starts and stops a recording, capping duration at MAX_VOICE_DURATION_MS', async () => {
    class FakeRecorder {
      startRecorder = jest.fn().mockResolvedValue('file:///tmp/note.m4a');
      stopRecorder = jest.fn().mockResolvedValue('file:///tmp/note.m4a');
      removeRecordBackListener = jest.fn();
      // 11 minutes recorded — over the 10-minute cap.
      mmssss = '11:00:00';
    }

    await withRecorderMock(FakeRecorder, async recorder => {
      await expect(recorder.startVoiceRecording()).resolves.toBe(true);
      const result = await recorder.stopVoiceRecording();
      expect(result).toEqual({
        uri: 'file:///tmp/note.m4a',
        mimeType: 'audio/aac',
        durationMs: 10 * 60 * 1000,
      });
    });
  });

  test('returns null from stopVoiceRecording when the recorder produced no file', async () => {
    class FakeRecorder {
      startRecorder = jest.fn();
      stopRecorder = jest.fn().mockResolvedValue(null);
      removeRecordBackListener = jest.fn();
      mmssss = '00:03:00';
    }
    await withRecorderMock(FakeRecorder, async recorder => {
      await expect(recorder.stopVoiceRecording()).resolves.toBeNull();
    });
  });
});
