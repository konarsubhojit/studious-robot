// @ts-check
/**
 * Constrain `value` to the inclusive `[min, max]` range.
 *
 * Runs as a Reanimated worklet on the UI thread as well as on the JS thread.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

/**
 * Format an elapsed call duration as `mm:ss` (or `hh:mm:ss` past an hour).
 *
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatCallDuration(totalSeconds) {
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
 *
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatRingCountdown(totalSeconds) {
  const safeSeconds = Math.floor(Math.max(0, totalSeconds || 0));
  if (safeSeconds < 60) return `${safeSeconds}s`;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Derive up to two avatar initials from a user id or display name.
 *
 * @param {string|null|undefined} id
 * @returns {string}
 */
export function deriveInitials(id) {
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

/**
 * @param {unknown} value
 * @returns {value is number} `true` for a finite numeric sample.
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Grade the live connection from WebRTC stats into signal bars plus a label.
 *
 * Missing/non-finite samples are ignored, so a partially reported stats object
 * still yields the best grade its known metrics support.
 *
 * @param {{ rttMs?: number, packetLossRatio?: number, bitrateKbps?: number }} stats
 * @returns {{ bars: 0|1|2|3, label: string }}
 */
export function getConnectionQuality({ rttMs, packetLossRatio, bitrateKbps }) {
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
