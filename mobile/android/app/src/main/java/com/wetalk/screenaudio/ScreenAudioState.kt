package com.wetalk.screenaudio

/**
 * What the runtime can currently do with system ("screen") audio.
 *
 * Deliberately not a boolean. Android playback capture is opt-out per source
 * app — anything that sets `ALLOW_CAPTURE_BY_NONE`, and all DRM-protected
 * audio, is silently unrecordable — so "we are capturing" and "the far end can
 * hear something" are different facts and the UI has to be able to tell them
 * apart.
 */
enum class ScreenAudioState {
  /** Playback capture needs Android 10 (API 29); this device is older. */
  UNSUPPORTED_PLATFORM,

  /** The seam is not in place: no custom audio device module, or no projection. */
  UNAVAILABLE,

  /** Supported, nothing running. */
  IDLE,

  /** Capturing, and audio has actually been heard. */
  CAPTURING,

  /** Capturing, but everything captured so far has been digital silence. */
  SILENT,
}
