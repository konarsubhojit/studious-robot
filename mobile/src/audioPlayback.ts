import { logError, logInfo, logVerbose, logWarn } from './appLogger';
import { isAudioSessionActive } from './audioSessionState';
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

/**
 * The speeds the control cycles through, in order. `1` (normal speed) is the
 * default every session starts at.
 */
export const PLAYBACK_RATES: readonly number[] = [1, 1.5, 2];

/** The state every subscribed player UI renders from. */
export type AudioPlaybackState = {
  /** The source currently loaded, or `null` when nothing is playing. */
  uri: string | null;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  /**
   * The active playback speed, one of {@link PLAYBACK_RATES}. Lives here
   * rather than in a bubble's component state so every mounted player agrees
   * on the current speed, and so it persists across notes within a session
   * instead of resetting to 1x each time.
   */
  playbackRate: number;
};

/** Why a playback request could not be honoured. */
export type AudioPlaybackReason = 'unavailable' | 'missing-uri' | 'call-active' | 'failed';

export type AudioPlaybackResult =
  | { ok: true }
  | {
      ok: false;
      reason: AudioPlaybackReason;
      message: string;
      error?: unknown;
    };

const IDLE_STATE: AudioPlaybackState = Object.freeze({
  uri: null,
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  playbackRate: PLAYBACK_RATES[0],
});

/**
 * Reset playback to idle while keeping the session's chosen speed, so
 * stopping one note (or a failed start) doesn't reset the next note back to
 * 1x.
 */
function idleState(): AudioPlaybackState {
  return { ...IDLE_STATE, playbackRate: state.playbackRate };
}

const FAILURE_MESSAGES: Record<AudioPlaybackReason, string> = {
  unavailable: 'Audio playback is not available on this build',
  'missing-uri': 'This audio message has no file to play',
  'call-active': 'Audio playback is paused while a call is in progress',
  failed: 'Could not play this audio message',
};

let state: AudioPlaybackState = IDLE_STATE;
const listeners = new Set<(next: AudioPlaybackState) => void>();
const completionListeners = new Set<(uri: string) => void>();
/**
 * The source whose end-of-clip release is already under way, so the burst of
 * position events a native player can emit past the end only completes once.
 */
let completingUri: string | null = null;

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

function notifyCompletion(uri: string) {
  for (const listener of completionListeners) {
    try {
      listener(uri);
    } catch (error) {
      logWarn('[AudioPlayback] completion listener threw', { error });
    }
  }
}

/** Reset the cached module and player state (tests only). */
export function _resetAudioPlayback() {
  _soundCache = undefined;
  listeners.clear();
  completionListeners.clear();
  completingUri = null;
  state = IDLE_STATE;
}

/** Whether the audio-playback native module is linked. */
export function isAudioPlaybackAvailable(): boolean {
  return Boolean(loadSoundModule());
}

/**
 * Whether the linked native player exposes a rate API. The speed control
 * degrades to hidden (rather than present-but-inert) when it doesn't.
 */
export function isPlaybackRateSupported(): boolean {
  const sound = loadSoundModule();
  return typeof sound?.setPlaybackSpeed === 'function';
}

/**
 * Cycle to the next speed in {@link PLAYBACK_RATES}, applying it immediately
 * to whatever is loaded and remembering it for the next note played.
 */
export function cyclePlaybackRate(): AudioPlaybackResult {
  if (!isPlaybackRateSupported()) return failure('unavailable');
  const currentIndex = PLAYBACK_RATES.indexOf(state.playbackRate);
  const nextRate = PLAYBACK_RATES[(currentIndex + 1) % PLAYBACK_RATES.length] ?? PLAYBACK_RATES[0];
  publish({ playbackRate: nextRate });

  const sound = loadSoundModule();
  if (sound && state.uri) {
    sound.setPlaybackSpeed(nextRate).catch(error => {
      logWarn('[AudioPlayback] setPlaybackSpeed failed', { error });
    });
  }
  return { ok: true };
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

/**
 * Subscribe to clips reaching their end on their own, as opposed to being
 * stopped, paused or replaced. The conversation layer uses this to chain
 * voice notes; this module stays a single-clip player that knows nothing
 * about what a clip belongs to.
 *
 * @returns an unsubscribe function.
 */
export function subscribeAudioPlaybackCompletion(listener: (uri: string) => void): () => void {
  completionListeners.add(listener);
  return () => {
    completionListeners.delete(listener);
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
  publish(idleState());
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
    completingUri = null;
    sound.addPlayBackListener?.(event => {
      const positionMs = Number(event?.currentPosition) || 0;
      const total = Number(event?.duration) || 0;
      logVerbose('[AudioPlayback] position', { positionMs, durationMs: total });
      if (total > 0 && positionMs >= total) {
        // Finished: release the player rather than leaving it parked at the
        // end, so the next play starts from a clean state. Subscribers are
        // told which source ended once the player is idle again, so a
        // listener may start the next clip straight away.
        const finishedUri = state.uri;
        if (!finishedUri || completingUri === finishedUri) return;
        completingUri = finishedUri;
        void stopAudio().then(() => notifyCompletion(finishedUri));
        return;
      }
      publish({ positionMs, durationMs: total || state.durationMs });
    });
    publish({ uri, isPlaying: true, positionMs: 0, durationMs: Number(durationMs) || 0 });
    await sound.startPlayer(uri);
    // Carry the session's chosen speed onto this note rather than resetting
    // to 1x each time a new clip starts.
    if (state.playbackRate !== PLAYBACK_RATES[0] && typeof sound.setPlaybackSpeed === 'function') {
      await sound.setPlaybackSpeed(state.playbackRate);
    }
    logInfo('[AudioPlayback] playing', { durationMs: Number(durationMs) || 0, playbackRate: state.playbackRate });
    return { ok: true };
  } catch (error) {
    logError('[AudioPlayback] play failed', { error });
    sound.removePlayBackListener?.();
    publish(idleState());
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
