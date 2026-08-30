import { Platform } from 'react-native';
import { mediaDevices } from 'react-native-webrtc';
import { logError, logInfo, logWarn } from './appLogger';
import { errorMessage as describeThrowable } from './errors';

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
 * The narrow, structural shapes this module needs from the WebRTC objects it
 * handles. `react-native-webrtc` under-declares `getDisplayMedia`, stats
 * reports and screen tracks, and describing them as `any` let malformed
 * objects travel all the way into the call logic. These types plus the guards
 * below turn a shape violation into an ordinary failure at the boundary.
 */

/** The part of a `MediaStreamTrack` this module touches. */
export type ScreenTrack = {
  readonly id?: string;
  readonly kind?: string;
  stop?: () => void;
};

/** The part of a `MediaStream` a display capture must provide. */
export type ScreenStream = {
  getTracks: () => unknown;
  getVideoTracks?: () => unknown;
  getAudioTracks?: () => unknown;
};

/** The constraints `getDisplayMedia` is called with. */
type DisplayMediaConstraints = { video: true; audio?: boolean; };

/** `mediaDevices`, as far as display capture is concerned. */
type DisplayMediaDevices = {
  getDisplayMedia?: (constraints: DisplayMediaConstraints) => unknown;
};

/** Anything that can report RTP statistics; an `RTCPeerConnection` in practice. */
export type ScreenShareStatsProvider = { getStats: () => Promise<unknown>; };

/** The outbound-RTP fields the frame check reads. */
type OutboundRtpStats = {
  kind?: unknown;
  mediaType?: unknown;
  framesSent?: unknown;
  framesEncoded?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isScreenTrack(value: unknown): value is ScreenTrack {
  return isRecord(value) && typeof value.stop === 'function';
}

function isScreenStream(value: unknown): value is ScreenStream {
  return isRecord(value) && typeof value.getTracks === 'function';
}

function hasGetStats(value: unknown): value is ScreenShareStatsProvider {
  return isRecord(value) && typeof value.getStats === 'function';
}

/**
 * Read one track list off a stream, tolerating every way it can be malformed:
 * a missing accessor, a throwing one, a non-array result or entries that are
 * not tracks at all.
 */
function readTracks(
  stream: unknown,
  accessor: 'getTracks' | 'getVideoTracks' | 'getAudioTracks',
): ScreenTrack[] {
  if (!isRecord(stream)) return [];
  const read = stream[accessor];
  if (typeof read !== 'function') return [];
  let tracks: unknown;
  try {
    tracks = (read as () => unknown).call(stream);
  } catch {
    return [];
  }
  return Array.isArray(tracks) ? tracks.filter(isScreenTrack) : [];
}

/**
 * @returns the error message, when there is one.
 *
 * Adds a `name` fallback to the shared helper: `getDisplayMedia` rejects with a
 * plain object whose `message` is sometimes absent and whose DOM exception name
 * (e.g. `NotAllowedError`) is the only thing worth reporting.
 */
function errorMessage(error: unknown): string | undefined {
  const message = describeThrowable(error);
  if (message) return message;
  const name = isRecord(error) ? error.name : undefined;
  return typeof name === 'string' && name ? name : undefined;
}

/**
 * Whether `error` means the user (or the platform) refused consent rather than
 * a genuine capture failure.
 *
 * The name and the message are matched together: react-native-webrtc reports
 * a denial as a plain object whose *message* is `NotAllowedError` and whose
 * `name` is absent, which used to be classified as a failure and shown as
 * "Unable to start screen sharing: Unknown error".
 *
 * @param error
 */
function isPermissionDeniedError(error: unknown) {
  const { name, message } = isRecord(error) ? error : ({} as Record<string, unknown>);
  const signal = `${String(name || '')} ${String(message || '')}`.toLowerCase();
  return [
    'notallowederror',
    'not allowed',
    'securityerror',
    'permission',
    'denied',
    'cancel',
    'user did not grant',
  ].some(marker => signal.includes(marker));
}

/**
 * `getDisplayMedia` accepts constraints at runtime; react-native-webrtc's
 * typings declare it without parameters, so the module is re-described through
 * the narrow shape above instead of being widened to `any` at each call site.
 */
const displayMediaDevices = mediaDevices as unknown as DisplayMediaDevices | undefined;

function callDisplayMedia(constraints: DisplayMediaConstraints): Promise<unknown> {
  const getDisplayMedia = displayMediaDevices?.getDisplayMedia;
  if (typeof getDisplayMedia !== 'function') {
    return Promise.reject(new Error('Screen sharing is not supported on this device'));
  }
  return Promise.resolve(getDisplayMedia.call(displayMediaDevices, constraints));
}

/**
 * Whether the current runtime exposes a display-media capture API.
 */
export function isScreenShareSupported(): boolean {
  return typeof displayMediaDevices?.getDisplayMedia === 'function';
}

/**
 * Human-readable message for a failed `getDisplayMedia` call.
 */
export function getScreenShareErrorMessage(error: unknown): string {
  if (isPermissionDeniedError(error)) {
    return 'Screen sharing permission denied';
  }
  if (Platform.OS === 'ios') {
    return 'Screen sharing is unavailable on this device';
  }
  return `Unable to start screen sharing: ${errorMessage(error) || 'Unknown error'}`;
}

type ScreenCaptureSuccess = {
  ok: true;
  stream: ScreenStream;
  videoTrack: ScreenTrack;
  audioTrack: ScreenTrack | null;
  audioShared: boolean;
};

type ScreenCaptureFailure = {
  ok: false;
  reason: 'unsupported' | 'cancelled' | 'failed';
  message: string;
  error?: unknown;
};

type ScreenCaptureResult = ScreenCaptureSuccess | ScreenCaptureFailure;

function failedScreenCapture(error: unknown): ScreenCaptureFailure {
  const denied = isPermissionDeniedError(error);
  if (!denied) {
    logError('Screen capture failed; MediaProjection did not start', error);
  }
  return {
    ok: false,
    reason: denied ? SCREEN_SHARE_CANCELLED : 'failed',
    message: getScreenShareErrorMessage(error),
    error,
  };
}

async function requestDisplayMedia(
  withAudio: boolean,
): Promise<{ ok: true; stream: unknown; } | ScreenCaptureFailure> {
  try {
    const stream = await callDisplayMedia({ video: true, audio: Boolean(withAudio) });
    return { ok: true, stream };
  } catch (error) {
    if (!withAudio || isPermissionDeniedError(error)) return failedScreenCapture(error);
    // Some platforms reject the whole request when screen audio is asked for
    // but unavailable; retry video-only before giving up. A refused consent
    // is never retried: the MediaProjection token is consumed by the prompt,
    // so retrying only re-asks a user who has already said no.
    logWarn('Screen capture with audio failed; retrying video only', {
      message: errorMessage(error),
    });
    try {
      return { ok: true, stream: await callDisplayMedia({ video: true }) };
    } catch (retryError) {
      return failedScreenCapture(retryError);
    }
  }
}

function completeScreenCapture(stream: unknown, withAudio: boolean): ScreenCaptureResult {
  if (!isScreenStream(stream)) {
    return {
      ok: false,
      reason: 'failed',
      message: 'Screen sharing did not return a media stream',
    };
  }
  const [videoTrack] = readTracks(stream, 'getVideoTracks');
  if (!videoTrack) {
    stopScreenCapture(stream);
    return {
      ok: false,
      reason: 'failed',
      message: 'Screen sharing did not return a video track',
    };
  }
  const [audioTrack] = withAudio ? readTracks(stream, 'getAudioTracks') : [];
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

/**
 * Prompt the user for screen-capture consent and return the captured stream.
 *
 *   `withAudio` requests screen/system audio in addition to the screen video.
 */
export async function startScreenCapture(
  { withAudio = false }: { withAudio?: boolean; } = {},
): Promise<ScreenCaptureResult> {
  if (!isScreenShareSupported()) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Screen sharing is not supported on this device',
    };
  }

  const capture = await requestDisplayMedia(withAudio);
  if (!capture.ok) return capture;
  return completeScreenCapture(capture.stream, withAudio);
}

/** @param ms */
function sleep(ms: number) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function forEachStatsEntry(report: unknown, visit: (entry: unknown) => void) {
  if (!isRecord(report)) return;
  const forEach = report.forEach;
  if (typeof forEach === 'function') {
    (forEach as (callback: (entry: unknown) => void) => void).call(report, visit);
    return;
  }
  if (Array.isArray(report)) {
    report.forEach(visit);
    return;
  }
  Object.values(report).forEach(visit);
}

/** Whether `entry` is an outbound-RTP stats object describing video. */
function isOutboundVideoStats(entry: unknown): entry is OutboundRtpStats {
  if (!isRecord(entry) || entry.type !== 'outbound-rtp') return false;
  const kind = entry.kind ?? entry.mediaType;
  return !kind || kind === 'video';
}

/**
 * Total frames the outbound video sender has handed to the encoder/network.
 *
 * @param report - an `RTCStatsReport` (Map), array or plain object.
 */
function countOutboundVideoFrames(report: unknown): number {
  let frames = 0;
  forEachStatsEntry(report, entry => {
    if (!isOutboundVideoStats(entry)) return;
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
 * @param peerConnection an `RTCPeerConnection`, or anything without `getStats`.
 */
export async function verifyScreenShareFrames(peerConnection: unknown, options: { timeoutMs?: number; intervalMs?: number; } = {}): Promise<{ ok: true; frames: number | null; verified: boolean; } |
{ ok: false; reason: 'no_frames'; message: string; }> {
  const { timeoutMs = FRAME_CHECK_TIMEOUT_MS, intervalMs = FRAME_CHECK_INTERVAL_MS } = options;

  if (!hasGetStats(peerConnection)) {
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
 * @param stream a `MediaStream`, or anything falsy.
 */
export function stopScreenCapture(stream: unknown) {
  readTracks(stream, 'getTracks').forEach(track => {
    try {
      track.stop?.();
    } catch {
      // Best-effort: a track may already be ended by the OS overlay.
    }
  });
}
