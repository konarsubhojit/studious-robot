/**
 * Tests the optional-native-module (try/catch require) pattern in
 * `voiceRecorder.js`, mirroring `attachmentPicker.test.js`.
 */

jest.mock('react-native-fs', () => ({
  stat: jest.fn().mockResolvedValue({ size: 4096 }),
}));

const RNFS = require('react-native-fs');

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
  beforeEach(() => {
    RNFS.stat.mockClear();
    RNFS.stat.mockResolvedValue({ size: 4096 });
  });

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
    RNFS.stat.mockRejectedValueOnce(new Error('ENOENT'));
    class FakeRecorder {
      startRecorder = jest.fn().mockResolvedValue('file:///tmp/note.m4a');
      stopRecorder = jest.fn().mockResolvedValue('file:///tmp/note.m4a');
      addRecordBackListener = jest.fn(callback => callback({ currentPosition: 3000 }));
      removeRecordBackListener = jest.fn();
    }

    await withRecorderMock(FakeRecorder, async recorder => {
      await recorder.startVoiceRecording();
      const result = await recorder.stopVoiceRecording();
      expect(result).toEqual({
        uri: 'file:///tmp/note.m4a',
        mimeType: 'audio/aac',
        durationMs: 3000,
        sizeBytes: 0,
      });
    });
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
