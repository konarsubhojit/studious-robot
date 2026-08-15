import { Platform } from 'react-native';
import { mediaDevices } from 'react-native-webrtc';
import { logInfo, logWarn } from './appLogger';

/**
 * Screen-sharing capture helpers built on top of `getDisplayMedia`.
 *
 * Screen audio ("share system sound", like the MS Teams *Include computer
 * sound* option) is always **optional and best-effort**: several platforms and
 * OS versions only hand back a video track.  When that happens the share still
 * starts, and the caller is told that audio could not be included so it can
 * surface a non-fatal warning instead of failing the whole action.
 *
 * @remarks Group calls (out of scope today): `isScreenSharing` /
 * `isRemoteScreenSharing` are single booleans because only one-to-one calls
 * exist. Supporting more than two participants would need per-participant
 * maps instead, plus a "N people viewing" count derived from the same
 * `call.media-state` relay mechanism (see `useCallFlow.js`).
 */

/** Returned when the user dismisses the OS screen-capture consent dialog. */
export const SCREEN_SHARE_CANCELLED = 'cancelled';

function isPermissionDeniedError(error) {
  const name = error?.name;
  const message = String(error?.message || '').toLowerCase();
  return (
    name === 'NotAllowedError' ||
    name === 'SecurityError' ||
    message.includes('permission') ||
    message.includes('denied') ||
    message.includes('cancel') ||
    message.includes('user did not grant')
  );
}

/**
 * Whether the current runtime exposes a display-media capture API.
 *
 * @returns {boolean}
 */
export function isScreenShareSupported() {
  return typeof mediaDevices?.getDisplayMedia === 'function';
}

/**
 * Human-readable message for a failed `getDisplayMedia` call.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function getScreenShareErrorMessage(error) {
  if (isPermissionDeniedError(error)) {
    return 'Screen sharing permission denied';
  }
  if (Platform.OS === 'ios') {
    return 'Screen sharing is unavailable on this device';
  }
  return `Unable to start screen sharing: ${error?.message || 'Unknown error'}`;
}

/**
 * Prompt the user for screen-capture consent and return the captured stream.
 *
 * @param {{ withAudio?: boolean }} [options]
 *   `withAudio` requests screen/system audio in addition to the screen video.
 * @returns {Promise<
 *   | { ok: true, stream: object, videoTrack: object, audioTrack: object | null, audioShared: boolean }
 *   | { ok: false, reason: 'unsupported' | 'cancelled' | 'failed', message: string, error?: unknown }
 * >}
 */
export async function startScreenCapture({ withAudio = false } = {}) {
  if (!isScreenShareSupported()) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Screen sharing is not supported on this device',
    };
  }

  let stream;
  try {
    stream = await mediaDevices.getDisplayMedia({ video: true, audio: Boolean(withAudio) });
  } catch (error) {
    if (withAudio) {
      // Some platforms reject the whole request when screen audio is asked for
      // but unavailable; retry video-only before giving up.
      logWarn('Screen capture with audio failed; retrying video only', {
        message: error?.message,
      });
      try {
        stream = await mediaDevices.getDisplayMedia({ video: true });
      } catch (retryError) {
        return {
          ok: false,
          reason: isPermissionDeniedError(retryError) ? SCREEN_SHARE_CANCELLED : 'failed',
          message: getScreenShareErrorMessage(retryError),
          error: retryError,
        };
      }
    } else {
      return {
        ok: false,
        reason: isPermissionDeniedError(error) ? SCREEN_SHARE_CANCELLED : 'failed',
        message: getScreenShareErrorMessage(error),
        error,
      };
    }
  }

  const [videoTrack] = stream?.getVideoTracks?.() ?? [];
  if (!videoTrack) {
    stopScreenCapture(stream);
    return {
      ok: false,
      reason: 'failed',
      message: 'Screen sharing did not return a video track',
    };
  }

  const [audioTrack] = withAudio ? stream.getAudioTracks?.() ?? [] : [];
  logInfo('Screen capture started', {
    requestedAudio: Boolean(withAudio),
    audioShared: Boolean(audioTrack),
  });

  return {
    ok: true,
    stream,
    videoTrack,
    audioTrack: audioTrack ?? null,
    audioShared: Boolean(audioTrack),
  };
}

/**
 * Stop every track of a captured display stream. Safe to call with `null`.
 *
 * @param {object | null | undefined} stream
 */
export function stopScreenCapture(stream) {
  if (!stream?.getTracks) return;
  stream.getTracks().forEach(track => {
    try {
      track.stop();
    } catch {
      // Best-effort: a track may already be ended by the OS overlay.
    }
  });
}
