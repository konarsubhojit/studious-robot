/**
 * Whether a call currently owns the device audio session.
 *
 * Kept in its own dependency-free module so chat media playback can ask the
 * question without importing the call-side audio stack (and its native
 * modules) — the call flow sets the flag from `audioRouting`, playback only
 * reads it.
 */

let audioSessionActive = false;

/** Record that a call has taken (or released) the audio session. */
export function setAudioSessionActive(active: boolean): void {
  audioSessionActive = Boolean(active);
}

/** Whether a call owns the audio focus right now. */
export function isAudioSessionActive(): boolean {
  return audioSessionActive;
}
