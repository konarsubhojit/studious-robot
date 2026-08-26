import type { IceCandidatePairSummary } from './diagnostics';
import type { CallMediaType } from './settingsStorage';

/**
 * English display strings for server-side `endReason` codes.
 *
 * Each key mirrors a value that can appear in `call.endReason` from the
 * server.  The mapped string is the default English label shown in the UI.
 * Applications that support multiple languages should use these as fallback
 * defaults and provide translated overrides keyed by the same reason code.
 *
 * Lives here rather than in `useCallFlow` so the call log's pure formatting
 * helpers can phrase an outcome without pulling in the WebRTC stack.
 */
export const CALL_END_REASON_LABELS: Record<string, string> = {
  ended: 'Call ended',
  declined: 'Call declined',
  cancelled: 'Call cancelled',
  timeout: 'Missed call',
  missed: 'Missed call',
  busy: 'Line was busy',
  unreachable: 'User unavailable',
  failed: 'Call failed',
};

/**
 * Modality assumed for a call this device has no record of.
 *
 * Video, because that is what an untagged call actually was: every call placed
 * before modality was recorded went out as video, and `startAudioCallWith`
 * still places a video call with the camera off.
 */
export const DEFAULT_CALL_MEDIA_TYPE: CallMediaType = 'video';

export function clamp(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

/**
 * @returns `mm:ss`, or `hh:mm:ss` past an hour.
 */
export function formatCallDuration(totalSeconds: number | null | undefined): string {
  const safeSeconds = Math.floor(Math.max(0, totalSeconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(
      seconds,
    ).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Format the seconds left in the ring window for display.
 *
 * The ring window is two minutes, so a raw second count ("117s") reads as
 * noise; anything from a minute up is shown as `m:ss`.
 */
export function formatRingCountdown(totalSeconds: number): string {
  const safeSeconds = Math.floor(Math.max(0, totalSeconds || 0));
  if (safeSeconds < 60) return `${safeSeconds}s`;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * @returns up to two uppercase initials, `?` when unknown.
 */
export function deriveInitials(id: string | null | undefined): string {
  if (!id) return '?';
  const parts = id
    .trim()
    .split(/[\s\-_]+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return id.slice(0, 2).toUpperCase();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Grade the live connection from the latest WebRTC stats sample.
 */
export function getConnectionQuality({ rttMs, packetLossRatio, bitrateKbps }: { rttMs?: number; packetLossRatio?: number; bitrateKbps?: number; }): { bars: number; label: string; } {
  if (
    !isFiniteNumber(rttMs) &&
    !isFiniteNumber(packetLossRatio) &&
    !isFiniteNumber(bitrateKbps)
  ) {
    return { bars: 0, label: 'No link' };
  }

  if (
    (isFiniteNumber(packetLossRatio) && packetLossRatio > 0.12) ||
    (isFiniteNumber(rttMs) && rttMs > 600) ||
    (isFiniteNumber(bitrateKbps) && bitrateKbps < 120)
  ) {
    return { bars: 0, label: 'Poor' };
  }

  if (
    (isFiniteNumber(packetLossRatio) && packetLossRatio > 0.07) ||
    (isFiniteNumber(rttMs) && rttMs > 350) ||
    (isFiniteNumber(bitrateKbps) && bitrateKbps < 250)
  ) {
    return { bars: 1, label: 'Weak' };
  }

  if (
    (isFiniteNumber(packetLossRatio) && packetLossRatio > 0.03) ||
    (isFiniteNumber(rttMs) && rttMs > 220) ||
    (isFiniteNumber(bitrateKbps) && bitrateKbps < 500)
  ) {
    return { bars: 2, label: 'Fair' };
  }

  return { bars: 3, label: 'Strong' };
}

/**
 * Which side of a candidate pair is relaying the media.
 *
 * Split out of the summary below so the four-way outcome reads as a table
 * rather than as nested ternaries.
 */
function resolveRelaySide(
  localRelay: boolean,
  remoteRelay: boolean,
): IceCandidatePairSummary['relaySide'] {
  if (localRelay && remoteRelay) return 'both';
  if (localRelay) return 'local';
  if (remoteRelay) return 'remote';
  return undefined;
}

/** The first of `values` that is a string, or `'unknown'`. */
function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return 'unknown';
}

/**
 * Describe the candidate pair WebRTC settled on, for diagnostics and TURN
 * usage reporting.
 *
 * A relay on *either* side means the media traverses TURN: judging the pair by
 * the local candidate alone reported a srflx→relay pair as a direct call.
 * Which side relays is recorded too, since that is the side paying the relay
 * bandwidth.
 *
 * `lookup` resolves a stats id to its report entry; pass a function that
 * returns `undefined` when the stats report cannot be indexed.
 *
 * @param candidatePair the succeeded `candidate-pair` stat
 * @param lookup resolves the pair's local/remote candidate ids
 */
export function summarizeCandidatePair(
  candidatePair: any,
  lookup: (id: unknown) => any,
): IceCandidatePairSummary {
  const localCandidate = lookup(candidatePair?.localCandidateId);
  const remoteCandidate = lookup(candidatePair?.remoteCandidateId);
  const local = firstString(localCandidate?.candidateType);
  const remote = firstString(remoteCandidate?.candidateType);
  const protocol = firstString(
    localCandidate?.protocol,
    remoteCandidate?.protocol,
    candidatePair?.protocol,
  );
  const relayProtocol =
    typeof localCandidate?.relayProtocol === 'string' ? localCandidate.relayProtocol : undefined;
  const localRelay = local === 'relay';
  const remoteRelay = remote === 'relay';
  const relaySide = resolveRelaySide(localRelay, remoteRelay);

  return {
    local,
    remote,
    protocol,
    ...(relayProtocol ? { relayProtocol } : {}),
    usingTurn: localRelay || remoteRelay,
    ...(relaySide ? { relaySide } : {}),
  };
}

/** The parts of a WebRTC stats report the call UI actually consumes. */
export type CallStatsSample = {
  /** Round-trip time (ms) of the succeeded candidate pair, when reported. */
  rttMs?: number;
  totalPacketsLost: number;
  totalPacketsReceived: number;
  totalBytesReceived: number;
  /** The succeeded candidate pair, preferring a nominated/selected one. */
  candidatePair: any | null;
};

/**
 * Reduce a WebRTC stats report to the handful of numbers the call UI grades.
 *
 * Only inbound video is counted: audio is far more resilient, so folding it in
 * flatters a call whose video has already fallen apart.
 *
 * @param report the result of `RTCPeerConnection.getStats()`
 */
export function collectCallStats(report: { forEach: (fn: (stat: any) => void) => void; }): CallStatsSample {
  const sample: CallStatsSample = {
    totalPacketsLost: 0,
    totalPacketsReceived: 0,
    totalBytesReceived: 0,
    candidatePair: null,
  };

  report.forEach((stat: any) => {
    if (!stat || typeof stat !== 'object') return;

    if (
      stat.type === 'candidate-pair' &&
      stat.state === 'succeeded' &&
      // A nominated or selected pair supersedes any earlier succeeded one.
      (!sample.candidatePair || stat.nominated || stat.selected)
    ) {
      sample.candidatePair = stat;
      if (typeof stat.currentRoundTripTime === 'number') {
        sample.rttMs = stat.currentRoundTripTime * 1000;
      }
    }

    if (
      stat.type === 'inbound-rtp' &&
      !stat.isRemote &&
      (stat.kind === 'video' || stat.mediaType === 'video')
    ) {
      sample.totalPacketsLost += Number(stat.packetsLost || 0);
      sample.totalPacketsReceived += Number(stat.packetsReceived || 0);
      sample.totalBytesReceived += Number(stat.bytesReceived || 0);
    }
  });

  return sample;
}
