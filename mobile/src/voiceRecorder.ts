import RNFS from 'react-native-fs';
import { MAX_VOICE_DURATION_MS, WAVEFORM_SAMPLE_COUNT } from '../../shared';
import type NitroSound from 'react-native-nitro-sound';

/**
 * Metering readings are dB values, roughly `-160` (silence) to `0` (loudest
 * the device can represent); this is the floor amplitude below which a
 * sample is treated as silence when normalising to `0..1`.
 */
const METERING_FLOOR_DB = -60;

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
  _meteringSamplesDb = [];
}

/** Elapsed recording time (ms), updated by the record-back listener while recording. */
let _lastPositionMs = 0;

/** Raw metering readings (dB) collected while recording, in chronological order. */
let _meteringSamplesDb: number[] = [];

/** Whether the voice-recorder native module is linked. */
export function isVoiceRecorderAvailable() {
  return Boolean(loadRecorderModule());
}

/**
 * Start recording a voice note to a temporary file.
 *
 * @returns `true` once recording has started, `false` when the native module
 *   isn't linked.
 */
export async function startVoiceRecording(): Promise<boolean> {
  const recorder = loadRecorderModule();
  if (!recorder) return false;
  _lastPositionMs = 0;
  _meteringSamplesDb = [];
  recorder.addRecordBackListener?.(event => {
    _lastPositionMs = Number(event?.currentPosition) || _lastPositionMs;
    if (Number.isFinite(event?.currentMetering)) {
      _meteringSamplesDb.push(Number(event.currentMetering));
    }
  });
  // `meteringEnabled` asks the native recorder to report `currentMetering`
  // on the record-back listener, which is what the waveform is built from;
  // recording still works without it, just without amplitude data.
  await recorder.startRecorder(undefined, undefined, true);
  return true;
}

/**
 * Normalise raw dB metering samples to `WAVEFORM_SAMPLE_COUNT` amplitudes in
 * `0..1`, so the player can render a fixed-width waveform regardless of how
 * long the note is or how densely the native module reported readings.
 *
 * @returns `undefined` when no metering samples were captured (module
 *   doesn't support it, or the recording was too short to get any).
 */
function buildWaveform(samplesDb: number[]): number[] | undefined {
  if (!samplesDb.length) return undefined;
  const normalized = samplesDb.map(db => {
    const clamped = Math.min(0, Math.max(METERING_FLOOR_DB, db));
    return (clamped - METERING_FLOOR_DB) / -METERING_FLOOR_DB;
  });
  const bars: number[] = [];
  for (let index = 0; index < WAVEFORM_SAMPLE_COUNT; index += 1) {
    const start = Math.floor((index * normalized.length) / WAVEFORM_SAMPLE_COUNT);
    const end = Math.max(
      start + 1,
      Math.floor(((index + 1) * normalized.length) / WAVEFORM_SAMPLE_COUNT),
    );
    const bucket = normalized.slice(start, end);
    const average = bucket.reduce((sum, value) => sum + value, 0) / bucket.length;
    bars.push(Number(average.toFixed(3)));
  }
  return bars;
}

/**
 * Stop the in-progress recording.
 *
 *   `null` when nothing was recording (module not linked, or never started).
 */
export async function stopVoiceRecording(): Promise<{
    uri: string; mimeType: string; durationMs: number; sizeBytes: number; waveform?: number[];
} | null> {
  const recorder = loadRecorderModule();
  if (!recorder) return null;
  const uri = await recorder.stopRecorder();
  const durationMs = Math.min(_lastPositionMs, MAX_VOICE_DURATION_MS);
  const waveform = buildWaveform(_meteringSamplesDb);
  recorder.removeRecordBackListener?.();
  if (!uri) return null;
  const sizeBytes = await statSizeBytes(uri);
  return { uri, mimeType: 'audio/aac', durationMs, sizeBytes, ...(waveform ? { waveform } : {}) };
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
