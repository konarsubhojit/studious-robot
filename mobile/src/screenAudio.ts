import { NativeModules, Platform } from 'react-native';
import { logInfo, logWarn } from './appLogger';
import { errorMessage } from './errors';

/**
 * Sharing the device's own audio ("include system sound") during a screen
 * share, on Android.
 *
 * `getDisplayMedia` cannot deliver it: react-native-webrtc's Android module
 * builds a video-only stream, and libwebrtc offers no way to push extra PCM
 * into a call. The native counterpart of this module takes the other route —
 * it captures playback with Android's `AudioPlaybackCaptureConfiguration` and
 * mixes it straight into the microphone buffer WebRTC is already sending.
 *
 * Two consequences shape this API:
 *
 *  * **No renegotiation.** The shared audio rides the existing microphone
 *    track, so there is no extra sender, no SDP change, and a peer running any
 *    build of the app hears it.
 *  * **Mute needs routing.** Microphone and system audio share one track, so
 *    disabling that track would silence both. {@link applyMicrophoneMute}
 *    mutes at the audio device module instead, which happens before system
 *    audio is mixed in.
 *
 * Every entry point degrades to a no-op when the native module is missing (the
 * simulator, iOS, tests), so callers never have to platform-branch.
 */

/**
 * What the device can currently do with system audio.
 *
 * Deliberately not a boolean. Android playback capture is opt-out per app —
 * anything marked `ALLOW_CAPTURE_BY_NONE`, plus all DRM-protected audio, is
 * silently unrecordable — so "capture is running" and "the other side can hear
 * something" are different facts, and `silent` is the state that tells them
 * apart.
 */
export type SystemAudioState =
  /** Playback capture needs Android 10; this device is older. */
  | 'unsupported_platform'
  /** No mixing audio device module, no screen share, or capture was refused. */
  | 'unavailable'
  /** Available, not running. */
  | 'idle'
  /** Running, and audio has actually been heard. */
  | 'capturing'
  /** Running, but everything captured so far has been digital silence. */
  | 'silent';

export type SystemAudioStatus = {
  /** Whether the mixing audio device module was installed at startup. */
  installed: boolean;
  state: SystemAudioState;
  /** Why the state is not `capturing`, when the native side could say. */
  reason?: string;
  /** Whether audio is being mixed into the call right now. */
  sharing: boolean;
  /** 10 ms buffers mixed so far; a share that works climbs by ~100 a second. */
  mixedFrames: number;
  bytesCaptured: number;
  /** Buffers dropped because WebRTC fell behind; a few are harmless. */
  bufferOverflows: number;
};

type NativeStatus = {
  installed?: unknown;
  state?: unknown;
  reason?: unknown;
  sharing?: unknown;
  mixedFrames?: unknown;
  bytesCaptured?: unknown;
  bufferOverflows?: unknown;
};

type NativeScreenAudio = {
  start: () => Promise<NativeStatus>;
  stop: () => Promise<NativeStatus>;
  getStatus: () => Promise<NativeStatus>;
  setMicrophoneMuted: (muted: boolean) => Promise<boolean>;
};

const NATIVE_STATES: Record<string, SystemAudioState> = {
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  UNAVAILABLE: 'unavailable',
  IDLE: 'idle',
  CAPTURING: 'capturing',
  SILENT: 'silent',
};

function isNativeScreenAudio(value: unknown): value is NativeScreenAudio {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.start === 'function' &&
    typeof candidate.stop === 'function' &&
    typeof candidate.getStatus === 'function' &&
    typeof candidate.setMicrophoneMuted === 'function'
  );
}

/**
 * The native module, or `null` on any platform or build without it.
 *
 * Resolved once: `NativeModules` is fixed for the lifetime of the JS context.
 */
const nativeScreenAudio: NativeScreenAudio | null = (() => {
  if (Platform.OS !== 'android') return null;
  const candidate = (NativeModules as Record<string, unknown> | undefined)?.ScreenAudio;
  return isNativeScreenAudio(candidate) ? candidate : null;
})();

const UNAVAILABLE_STATUS: SystemAudioStatus = {
  installed: false,
  state: 'unavailable',
  sharing: false,
  mixedFrames: 0,
  bytesCaptured: 0,
  bufferOverflows: 0,
};

function toCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

function toStatus(native: NativeStatus | null | undefined): SystemAudioStatus {
  if (typeof native !== 'object' || native === null) return UNAVAILABLE_STATUS;
  const state = typeof native.state === 'string' ? NATIVE_STATES[native.state] : undefined;
  const reason = typeof native.reason === 'string' && native.reason ? native.reason : undefined;
  return {
    installed: native.installed === true,
    state: state ?? 'unavailable',
    reason,
    sharing: native.sharing === true,
    mixedFrames: toCount(native.mixedFrames),
    bytesCaptured: toCount(native.bytesCaptured),
    bufferOverflows: toCount(native.bufferOverflows),
  };
}

/** Whether capture is running, so mute has to be routed natively. */
let sharing = false;

/**
 * The microphone mute the user asked for, mirrored so it can be re-applied
 * whichever way is correct when sharing starts or stops.
 */
let microphoneMuted = false;

/**
 * Whether this build can mix system audio into a call at all.
 *
 * Answers the *capability* question only — up front and without a capture,
 * unlike the `getDisplayMedia` path it replaces. Whether a given share
 * produces sound is a separate question, answered by {@link startSystemAudio}.
 */
export function isSystemAudioSupported(): boolean {
  return nativeScreenAudio !== null;
}

/** Whether system audio is being mixed into the call right now. */
export function isSystemAudioSharing(): boolean {
  return sharing;
}

/** The microphone mute state, which survives sharing starting and stopping. */
export function isMicrophoneMuted(): boolean {
  return microphoneMuted;
}

/** Test seam: forget the mute mirror and the sharing flag. */
export function resetSystemAudioState(): void {
  sharing = false;
  microphoneMuted = false;
}

/**
 * Start mixing the device's playback into the call.
 *
 * Requires a screen share to already be running: the capture borrows its
 * `MediaProjection`, because Android permits only one at a time and asking for
 * a second would stop the first.
 *
 * Never throws — a share that cannot carry audio still has to carry video.
 */
export async function startSystemAudio(): Promise<SystemAudioStatus> {
  if (!nativeScreenAudio) return UNAVAILABLE_STATUS;
  try {
    const status = toStatus(await nativeScreenAudio.start());
    sharing = status.sharing;
    if (sharing) {
      // The mute now has to be carried by the audio device module; the caller
      // re-enables the track it was previously applied to.
      await nativeScreenAudio.setMicrophoneMuted(microphoneMuted);
    }
    logInfo('System audio sharing start attempted', {
      state: status.state,
      sharing: status.sharing,
      reason: status.reason ?? null,
    });
    return status;
  } catch (error) {
    sharing = false;
    logWarn('System audio sharing failed to start', { message: errorMessage(error) });
    return UNAVAILABLE_STATUS;
  }
}

/** Stop mixing system audio. Safe to call when nothing is running. */
export async function stopSystemAudio(): Promise<void> {
  if (!nativeScreenAudio || !sharing) {
    sharing = false;
    return;
  }
  sharing = false;
  try {
    // Hand the mute back to the track the caller is about to restore.
    await nativeScreenAudio.setMicrophoneMuted(false);
    await nativeScreenAudio.stop();
    logInfo('System audio sharing stopped');
  } catch (error) {
    logWarn('System audio sharing failed to stop cleanly', { message: errorMessage(error) });
  }
}

/**
 * Read the live capture counters, for diagnosing a share that started but
 * produced no sound.
 */
export async function getSystemAudioStatus(): Promise<SystemAudioStatus> {
  if (!nativeScreenAudio) return UNAVAILABLE_STATUS;
  try {
    return { ...toStatus(await nativeScreenAudio.getStatus()), sharing };
  } catch (error) {
    logWarn('Unable to read system audio status', { message: errorMessage(error) });
    return UNAVAILABLE_STATUS;
  }
}

/**
 * Record the requested microphone mute and apply it natively while system
 * audio is being shared.
 *
 * @returns whether the mute was handled natively. `false` means the caller
 *   must fall back to disabling the local audio track, which is correct when
 *   nothing is being mixed into it.
 */
export function applyMicrophoneMute(muted: boolean): boolean {
  microphoneMuted = muted;
  if (!nativeScreenAudio || !sharing) return false;
  nativeScreenAudio.setMicrophoneMuted(muted).catch(error => {
    logWarn('Unable to mute the microphone natively', { message: errorMessage(error) });
  });
  return true;
}
