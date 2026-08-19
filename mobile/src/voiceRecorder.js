import RNFS from 'react-native-fs';
import { MAX_VOICE_DURATION_MS } from '../../shared';

/**
 * Lazy-loaded wrapper around `react-native-audio-recorder-player`, following
 * the same optional-native-module pattern as `vectorIcons.js` /
 * `attachmentPicker.js`.
 */

let _recorderCache;

/** @returns {typeof import('react-native-audio-recorder-player').default | null} */
function loadRecorderModule() {
  if (_recorderCache !== undefined) return _recorderCache;
  try {
    _recorderCache = require('react-native-audio-recorder-player').default;
  } catch {
    _recorderCache = null;
  }
  return _recorderCache;
}

/** Reset the cached module and any in-progress recorder instance (tests only). */
export function _resetVoiceRecorderCache() {
  _recorderCache = undefined;
  _recorderInstance = null;
  _lastPositionMs = 0;
}

let _recorderInstance = null;
/** Elapsed recording time (ms), updated by the record-back listener while recording. */
let _lastPositionMs = 0;

function getRecorderInstance() {
  const RecorderModule = loadRecorderModule();
  if (!RecorderModule) return null;
  if (!_recorderInstance) _recorderInstance = new RecorderModule();
  return _recorderInstance;
}

/** Whether the voice-recorder native module is linked. */
export function isVoiceRecorderAvailable() {
  return Boolean(loadRecorderModule());
}

/**
 * Start recording a voice note to a temporary file.
 *
 * @returns {Promise<boolean>} `true` once recording has started, `false` when
 *   the native module isn't linked.
 */
export async function startVoiceRecording() {
  const recorder = getRecorderInstance();
  if (!recorder) return false;
  _lastPositionMs = 0;
  recorder.addRecordBackListener?.(event => {
    _lastPositionMs = Number(event?.currentPosition) || _lastPositionMs;
  });
  await recorder.startRecorder();
  return true;
}

/**
 * Stop the in-progress recording.
 *
 * @returns {Promise<{ uri: string, mimeType: string, durationMs: number, sizeBytes: number } | null>}
 *   `null` when nothing was recording (module not linked, or never started).
 */
export async function stopVoiceRecording() {
  const recorder = getRecorderInstance();
  if (!recorder) return null;
  const uri = await recorder.stopRecorder();
  const durationMs = Math.min(_lastPositionMs, MAX_VOICE_DURATION_MS);
  recorder.removeRecordBackListener?.();
  if (!uri) return null;
  const sizeBytes = await statSizeBytes(uri);
  return { uri, mimeType: 'audio/aac', durationMs, sizeBytes };
}

/**
 * Read a local file's size, so the upload pipeline's size validation (and
 * the presign request, which needs an exact `Content-Length`) has something
 * to work with — the recorder itself reports elapsed time, not bytes.
 *
 * @returns {Promise<number>} `0` when the file cannot be statted.
 */
async function statSizeBytes(uri) {
  try {
    const { size } = await RNFS.stat(uri);
    return Number(size) || 0;
  } catch {
    return 0;
  }
}
