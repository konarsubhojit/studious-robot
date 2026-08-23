import { logError, logInfo, logVerbose, logWarn } from './appLogger';
import { isAudioSessionActive } from './audioRouting';
import type NitroSound from 'react-native-nitro-sound';

/**
 * Playback side of `react-native-nitro-sound`, the same optional-native-module
 * pattern the recorder (`voiceRecorder.js`) uses.
 *
 * There is exactly one native player, so this module owns it as a singleton:
 * starting a second voice note stops the first one, which is also the
 * behaviour every mainstream messenger has (never two clips at once).
 *
 * The call flow owns the audio session (`startAudioSession` plus the routing
 * logic in `audioRouting`), so playback refuses to start while a call is
 * active rather than fighting it for the route.
 */

let _soundCache: typeof NitroSound | null | undefined;

function loadSoundModule(): typeof NitroSound | null {
  if (_soundCache !== undefined) return _soundCache;
  try {
    const sound = require('react-native-nitro-sound').default;
    // The default export is a lazy proxy around the Nitro HybridObject, so the
    // native module only shows up as missing once a member is touched.
    _soundCache = typeof sound?.startPlayer === 'function' ? sound : null;
  } catch (error) {
    logWarn('[AudioPlayback] native player module is not linked', { error });
    _soundCache = null;
  }
  return _soundCache ?? null;
}

/** The state every subscribed player UI renders from. */
export type AudioPlaybackState = {
  /** The source currently loaded, or `null` when nothing is playing. */
  uri: string | null;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
};

/** Why a playback request could not be honoured. */
export type AudioPlaybackReason = 'unavailable' | 'missing-uri' | 'call-active' | 'failed';

export type AudioPlaybackResult = { ok: true; } | { ok: false; reason: AudioPlaybackReason; message: string; error?: unknown; };

const IDLE_STATE: AudioPlaybackState = Object.freeze({
  uri: null,
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
});

const FAILURE_MESSAGES: Record<AudioPlaybackReason, string> = {
  unavailable: 'Audio playback is not available on this build',
  'missing-uri': 'This audio message has no file to play',
  'call-active': 'Audio playback is paused while a call is in progress',
  failed: 'Could not play this audio message',
};

let state: AudioPlaybackState = IDLE_STATE;
const listeners = new Set<(next: AudioPlaybackState) => void>();

function publish(next: Partial<AudioPlaybackState>) {
  state = { ...state, ...next };
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      logWarn('[AudioPlayback] listener threw', { error });
    }
  }
}

/** Reset the cached module and player state (tests only). */
export function _resetAudioPlayback() {
  _soundCache = undefined;
  listeners.clear();
  state = IDLE_STATE;
}

/** Whether the audio-playback native module is linked. */
export function isAudioPlaybackAvailable(): boolean {
  return Boolean(loadSoundModule());
}

/** The current player state, for a component mounting mid-playback. */
export function getAudioPlaybackState(): AudioPlaybackState {
  return state;
}

/**
 * Subscribe to player state.
 *
 * @returns an unsubscribe function.
 */
export function subscribeAudioPlayback(listener: (next: AudioPlaybackState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function failure(reason: AudioPlaybackReason, error?: unknown): AudioPlaybackResult {
  return { ok: false, reason, message: FAILURE_MESSAGES[reason], error };
}

/**
 * Stop whatever is playing, releasing the native player.
 */
export async function stopAudio(): Promise<AudioPlaybackResult> {
  const sound = loadSoundModule();
  if (!sound) return failure('unavailable');
  try {
    sound.removePlayBackListener?.();
    await sound.stopPlayer();
  } catch (error) {
    // A stop that fails because nothing was playing is not worth surfacing,
    // but it must still be visible in the logs.
    logVerbose('[AudioPlayback] stop ignored', { error });
  }
  publish({ ...IDLE_STATE });
  return { ok: true };
}

/**
 * Play `uri`, replacing anything already playing.
 *
 * @param uri the attachment's public URL (or a local file path).
 */
export async function playAudio(uri: string | null | undefined, { durationMs = 0 }: { durationMs?: number | null; } = {}): Promise<AudioPlaybackResult> {
  if (!uri || typeof uri !== 'string') {
    logWarn('[AudioPlayback] play refused: no source URI');
    return failure('missing-uri');
  }

  const sound = loadSoundModule();
  if (!sound) {
    logWarn('[AudioPlayback] play refused: native player is not linked');
    return failure('unavailable');
  }

  if (isAudioSessionActive()) {
    logWarn('[AudioPlayback] play refused: a call owns the audio session');
    return failure('call-active');
  }

  // One native player: whatever was playing must be released first, so two
  // voice notes can never overlap.
  if (state.uri && state.uri !== uri) {
    await stopAudio();
  }

  try {
    sound.addPlayBackListener?.(event => {
      const positionMs = Number(event?.currentPosition) || 0;
      const total = Number(event?.duration) || 0;
      logVerbose('[AudioPlayback] position', { positionMs, durationMs: total });
      if (total > 0 && positionMs >= total) {
        // Finished: release the player rather than leaving it parked at the
        // end, so the next play starts from a clean state.
        void stopAudio();
        return;
      }
      publish({ positionMs, durationMs: total || state.durationMs });
    });
    publish({ uri, isPlaying: true, positionMs: 0, durationMs: Number(durationMs) || 0 });
    await sound.startPlayer(uri);
    logInfo('[AudioPlayback] playing', { durationMs: Number(durationMs) || 0 });
    return { ok: true };
  } catch (error) {
    logError('[AudioPlayback] play failed', { error });
    sound.removePlayBackListener?.();
    publish({ ...IDLE_STATE });
    return failure('failed', error);
  }
}

/**
 * Pause the current playback, keeping the position.
 */
export async function pauseAudio(): Promise<AudioPlaybackResult> {
  const sound = loadSoundModule();
  if (!sound) return failure('unavailable');
  try {
    await sound.pausePlayer();
    publish({ isPlaying: false });
    return { ok: true };
  } catch (error) {
    logWarn('[AudioPlayback] pause failed', { error });
    return failure('failed', error);
  }
}

/**
 * Resume playback paused by {@link pauseAudio}.
 */
export async function resumeAudio(): Promise<AudioPlaybackResult> {
  const sound = loadSoundModule();
  if (!sound) return failure('unavailable');
  if (isAudioSessionActive()) {
    logWarn('[AudioPlayback] resume refused: a call owns the audio session');
    return failure('call-active');
  }
  try {
    await sound.resumePlayer();
    publish({ isPlaying: true });
    return { ok: true };
  } catch (error) {
    logWarn('[AudioPlayback] resume failed', { error });
    return failure('failed', error);
  }
}

/**
 * Seek the current playback to `positionMs`.
 */
export async function seekAudio(positionMs: number): Promise<AudioPlaybackResult> {
  const sound = loadSoundModule();
  if (!sound) return failure('unavailable');
  const target = Math.max(0, Math.round(Number(positionMs) || 0));
  try {
    await sound.seekToPlayer(target);
    publish({ positionMs: target });
    return { ok: true };
  } catch (error) {
    logWarn('[AudioPlayback] seek failed', { error, positionMs: target });
    return failure('failed', error);
  }
}

/**
 * `m:ss` for a duration in milliseconds, as shown either side of the scrubber.
 */
export function formatPlaybackTime(milliseconds: number | null | undefined): string {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
