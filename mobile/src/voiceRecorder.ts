import RNFS from 'react-native-fs';
import { MAX_VOICE_DURATION_MS } from '../../shared';
import type NitroSound from 'react-native-nitro-sound';

/**
 * Lazy-loaded wrapper around `react-native-nitro-sound` (the maintained
 * successor to the deprecated `react-native-audio-recorder-player`), following
 * the same optional-native-module pattern as `vectorIcons.js` /
 * `attachmentPicker.js`.
 */

let _recorderCache: typeof NitroSound | null | undefined;


function loadRecorderModule(): typeof NitroSound | null {
  if (_recorderCache !== undefined) return _recorderCache;
  try {
    const sound = require('react-native-nitro-sound').default;
    // The default export is a lazy proxy around the Nitro HybridObject, so the
    // native module only shows up as missing once a member is touched.
    _recorderCache = typeof sound?.startRecorder === 'function' ? sound : null;
  } catch {
    _recorderCache = null;
  }
  return _recorderCache ?? null;
}

/** Reset the cached module and any in-progress recorder state (tests only). */
export function _resetVoiceRecorderCache() {
  _recorderCache = undefined;
  _lastPositionMs = 0;
}

/** Elapsed recording time (ms), updated by the record-back listener while recording. */
let _lastPositionMs = 0;

/** Whether the voice-recorder native module is linked. */
export function isVoiceRecorderAvailable() {
  return Boolean(loadRecorderModule());
}

/**
 * Start recording a voice note to a temporary file.
 *
 * @returns `true` once recording has started, `false` when
 *   the native module isn't linked.
 */
export async function startVoiceRecording(): Promise<boolean> {
  const recorder = loadRecorderModule();
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
 *   `null` when nothing was recording (module not linked, or never started).
 */
export async function stopVoiceRecording(): Promise<{ uri: string; mimeType: string; durationMs: number; sizeBytes: number; } | null> {
  const recorder = loadRecorderModule();
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
 * @returns `0` when the file cannot be statted.
 */
async function statSizeBytes(uri: string): Promise<number> {
  try {
    const { size } = await RNFS.stat(uri);
    return Number(size) || 0;
  } catch {
    return 0;
  }
}
