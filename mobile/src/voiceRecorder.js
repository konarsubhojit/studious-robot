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
}

let _recorderInstance = null;

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
  await recorder.startRecorder();
  return true;
}

/**
 * Stop the in-progress recording.
 *
 * @returns {Promise<{ uri: string, mimeType: string, durationMs: number } | null>}
 *   `null` when nothing was recording (module not linked, or never started).
 */
export async function stopVoiceRecording() {
  const recorder = getRecorderInstance();
  if (!recorder) return null;
  const uri = await recorder.stopRecorder();
  const durationMs = Math.min(recorder.mmssss ? parseDuration(recorder.mmssss) : 0, MAX_VOICE_DURATION_MS);
  recorder.removeRecordBackListener?.();
  if (!uri) return null;
  return { uri, mimeType: 'audio/aac', durationMs };
}

/** Parse a recorder library's `mm:ss:SS` (or similar) timestamp into ms — best effort only. */
function parseDuration(value) {
  const parts = String(value).split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) {
    const [minutes, seconds, hundredths] = parts;
    return minutes * 60_000 + seconds * 1000 + hundredths * 10;
  }
  return 0;
}
