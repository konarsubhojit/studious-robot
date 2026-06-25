export function clamp(value, min, max) {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

export function formatCallDuration(totalSeconds) {
  const safeSeconds = Math.floor(Math.max(0, totalSeconds || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function deriveInitials(id) {
  if (!id) return '?';
  const parts = id.trim().split(/[\s\-_]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return id.slice(0, 2).toUpperCase();
}

export function getConnectionQuality({ rttMs, packetLossRatio, bitrateKbps }) {
  if (!Number.isFinite(rttMs) && !Number.isFinite(packetLossRatio) && !Number.isFinite(bitrateKbps)) {
    return { bars: 0, label: 'No link' };
  }

  if (
    (Number.isFinite(packetLossRatio) && packetLossRatio > 0.12) ||
    (Number.isFinite(rttMs) && rttMs > 600) ||
    (Number.isFinite(bitrateKbps) && bitrateKbps < 120)
  ) {
    return { bars: 0, label: 'Poor' };
  }

  if (
    (Number.isFinite(packetLossRatio) && packetLossRatio > 0.07) ||
    (Number.isFinite(rttMs) && rttMs > 350) ||
    (Number.isFinite(bitrateKbps) && bitrateKbps < 250)
  ) {
    return { bars: 1, label: 'Weak' };
  }

  if (
    (Number.isFinite(packetLossRatio) && packetLossRatio > 0.03) ||
    (Number.isFinite(rttMs) && rttMs > 220) ||
    (Number.isFinite(bitrateKbps) && bitrateKbps < 500)
  ) {
    return { bars: 2, label: 'Fair' };
  }

  return { bars: 3, label: 'Strong' };
}
