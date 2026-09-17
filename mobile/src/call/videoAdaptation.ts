export type VideoAdaptationLevel = 'standard' | 'constrained' | 'minimal';

export type VideoAdaptationState = {
  level: VideoAdaptationLevel;
  poorSamples: number;
  recoverySamples: number;
  changedAtMs: number | null;
};

export const INITIAL_VIDEO_ADAPTATION: VideoAdaptationState = {
  level: 'standard',
  poorSamples: 0,
  recoverySamples: 0,
  changedAtMs: null,
};

const COOLDOWN_MS = 21_000;
const DEGRADE_SAMPLES = 2;
const RECOVERY_SAMPLES = 3;

function targetLevel(bars: number, dataSaverEnabled: boolean): VideoAdaptationLevel {
  if (bars <= 0) return 'minimal';
  if (bars <= 1 || dataSaverEnabled) return 'constrained';
  return 'standard';
}

export function nextVideoAdaptation(
  previous: VideoAdaptationState,
  { bars, dataSaverEnabled, isScreenSharing, nowMs }: {
    bars: number;
    dataSaverEnabled: boolean;
    isScreenSharing: boolean;
    nowMs: number;
  },
): VideoAdaptationState {
  if (isScreenSharing) return previous;

  const target = targetLevel(bars, dataSaverEnabled);
  if (target === previous.level) {
    return { ...previous, poorSamples: 0, recoverySamples: 0 };
  }
  const worsening = target === 'minimal' || (target === 'constrained' && previous.level === 'standard');
  const samples = worsening ? previous.poorSamples + 1 : previous.recoverySamples + 1;
  const needed = worsening ? DEGRADE_SAMPLES : RECOVERY_SAMPLES;
  const coolingDown = previous.changedAtMs !== null && nowMs - previous.changedAtMs < COOLDOWN_MS;
  if (coolingDown || samples < needed) {
    return worsening
      ? { ...previous, poorSamples: samples, recoverySamples: 0 }
      : { ...previous, poorSamples: 0, recoverySamples: samples };
  }
  return { level: target, poorSamples: 0, recoverySamples: 0, changedAtMs: nowMs };
}
