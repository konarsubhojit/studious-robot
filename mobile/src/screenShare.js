// @ts-check
import { Platform } from 'react-native';
import { mediaDevices } from 'react-native-webrtc';
import { logError, logInfo, logWarn } from './appLogger';

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

/**
 * Returned when capture started but no frame ever reached the remote peer.
 *
 * On Android this almost always means the MediaProjection foreground service
 * failed to start (see `mobile/README.md`), which produces a capture that
 * *looks* healthy locally while the remote peer only ever sees black.
 */
export const SCREEN_SHARE_NO_FRAMES = 'no_frames';

/** How long to wait for the first encoded screen frame before giving up. */
const FRAME_CHECK_TIMEOUT_MS = 3000;
/** How often to poll `getStats()` while waiting for the first frame. */
const FRAME_CHECK_INTERVAL_MS = 500;

/**
 * @param {unknown} error
 * @returns {string|undefined} the error message, when there is one.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : undefined;
}

/** @param {any} error */
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
  return `Unable to start screen sharing: ${errorMessage(error) || 'Unknown error'}`;
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
    // `getDisplayMedia` accepts constraints at runtime; react-native-webrtc's
    // typings declare it without parameters.
    stream = await /** @type {any} */ (mediaDevices).getDisplayMedia({
      video: true,
      audio: Boolean(withAudio),
    });
  } catch (error) {
    if (withAudio) {
      // Some platforms reject the whole request when screen audio is asked for
      // but unavailable; retry video-only before giving up.
      logWarn('Screen capture with audio failed; retrying video only', {
        message: errorMessage(error),
      });
      try {
        stream = await /** @type {any} */ (mediaDevices).getDisplayMedia({ video: true });
      } catch (retryError) {
        logError('Screen capture failed; MediaProjection did not start', retryError);
        return {
          ok: false,
          reason: isPermissionDeniedError(retryError) ? SCREEN_SHARE_CANCELLED : 'failed',
          message: getScreenShareErrorMessage(retryError),
          error: retryError,
        };
      }
    } else {
      if (!isPermissionDeniedError(error)) {
        logError('Screen capture failed; MediaProjection did not start', error);
      }
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
  logInfo('Screen capture started; MediaProjection service running', {
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

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {any} report
 * @param {(entry: any) => void} visit
 */
function forEachStatsEntry(report, visit) {
  if (!report) return;
  if (typeof report.forEach === 'function') {
    report.forEach(visit);
    return;
  }
  if (Array.isArray(report)) {
    report.forEach(visit);
    return;
  }
  if (typeof report === 'object') {
    Object.values(report).forEach(visit);
  }
}

/**
 * Total frames the outbound video sender has handed to the encoder/network.
 *
 * @param {unknown} report - an `RTCStatsReport` (Map), array or plain object.
 * @returns {number}
 */
function countOutboundVideoFrames(report) {
  let frames = 0;
  forEachStatsEntry(report, (/** @type {any} */ entry) => {
    if (!entry || entry.type !== 'outbound-rtp') return;
    const kind = entry.kind ?? entry.mediaType;
    if (kind && kind !== 'video') return;
    const sent = Number(entry.framesSent ?? entry.framesEncoded ?? 0);
    if (Number.isFinite(sent)) frames += sent;
  });
  return frames;
}

/**
 * Confirm the screen capture is actually producing frames for the remote peer.
 *
 * A `getDisplayMedia` stream can resolve with a live video track that never
 * emits a single frame (missing MediaProjection foreground service, failed
 * `startForeground`), which is indistinguishable from success locally. Polling
 * the outbound RTP stats is the only reliable way to tell the difference.
 *
 * @param {any} peerConnection an `RTCPeerConnection`, or anything falsy.
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<
 *   | { ok: true, frames: number | null, verified: boolean }
 *   | { ok: false, reason: 'no_frames', message: string }
 * >}
 */
export async function verifyScreenShareFrames(peerConnection, options = {}) {
  const { timeoutMs = FRAME_CHECK_TIMEOUT_MS, intervalMs = FRAME_CHECK_INTERVAL_MS } = options;

  if (typeof peerConnection?.getStats !== 'function') {
    // Nothing to measure against: never fail a share we cannot verify.
    return { ok: true, frames: null, verified: false };
  }

  const deadline = Date.now() + timeoutMs;
  let frames = 0;

  for (;;) {
    await sleep(intervalMs);
    try {
      frames = countOutboundVideoFrames(await peerConnection.getStats());
    } catch (error) {
      logWarn('Unable to read screen share stats', { message: errorMessage(error) });
      return { ok: true, frames: null, verified: false };
    }

    if (frames > 0) {
      logInfo('Screen capture is delivering frames', { frames });
      return { ok: true, frames, verified: true };
    }
    if (Date.now() >= deadline) break;
  }

  logError('Screen capture produced no frames', {
    timeoutMs,
    hint: 'MediaProjection foreground service may have failed to start',
  });
  return {
    ok: false,
    reason: SCREEN_SHARE_NO_FRAMES,
    message: 'Screen sharing produced no video; the remote side would only see a black screen',
  };
}

/**
 * Stop every track of a captured display stream. Safe to call with `null`.
 *
 * @param {any} stream a `MediaStream`, or anything falsy.
 */
export function stopScreenCapture(stream) {
  if (!stream?.getTracks) return;
  stream.getTracks().forEach((/** @type {any} */ track) => {
    try {
      track.stop();
    } catch {
      // Best-effort: a track may already be ended by the OS overlay.
    }
  });
}
