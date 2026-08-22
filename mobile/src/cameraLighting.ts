// @ts-check
import { logDebug, logError, logInfo } from './appLogger';

// Some platforms (notably react-native-webrtc on Android) do not implement every
// MediaStreamTrack introspection API and throw an "Not implemented." error when
// called. Such errors are an expected capability gap rather than a real failure,
// so we detect them to avoid logging them at error level.
/** @param {any} error */
function isNotImplementedError(error: any) {
  return Boolean(error) && /not implemented/i.test(error.message || '');
}

// Safely invoke an optional MediaStreamTrack reader (getSettings/getCapabilities).
// Returns null when the reader is missing or throws. "Not implemented." errors are
// logged at debug level because they are an expected platform limitation; any other
// error is logged at error level.
/**
 * @param {any} track
 * @param {'getSettings'|'getCapabilities'} method
 * @returns {any}
 */
function readTrackState(track: any, method: 'getSettings' | 'getCapabilities'): any {
  if (!track || typeof track[method] !== 'function') {
    return null;
  }

  try {
    return track[method]();
  } catch (error) {
    if (isNotImplementedError(error)) {
      logDebug(`Camera ${method} is not implemented on this platform`, error);
    } else {
      logError('Failed to read camera state for lighting adjustment', error);
    }
    return null;
  }
}

// Scene brightness is normalized to the [0, 1] range, where 0 is very dark and 1
// is very bright. These thresholds split that range into low / normal / bright.
export const LIGHTING_THRESHOLDS = {
  low: 0.25,
  bright: 0.75,
};

// Recommended camera controls per lighting condition.
// All values are supplied as best-effort `advanced` constraints so unsupported
// controls are ignored rather than causing applyConstraints to fail.
export const LIGHTING_PROFILES = {
  low: {
    frameRate: { ideal: 24, max: 30 },
    exposureCompensation: 1.5,
    brightness: 0.7,
  },
  normal: {
    frameRate: { ideal: 30 },
    exposureCompensation: 0,
    brightness: 0.5,
  },
  bright: {
    frameRate: { ideal: 30 },
    exposureCompensation: -0.5,
    brightness: 0.4,
  },
};

/**
 * @param {unknown} value
 * @returns {number | null} `value` clamped to [0, 1], or `null` when it is not a number.
 */
export function clampUnitInterval(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * @param {number | null | undefined} value
 * @param {{ min?: number, max?: number } | null | undefined} range
 * @returns {number | null}
 */
export function normalizeToUnitRange(value: number | null | undefined, range: { min?: number; max?: number; } | null | undefined): number | null {
  if (typeof value !== 'number' || Number.isNaN(value) || !range) {
    return null;
  }

  const { min, max } = range;
  if (typeof min !== 'number' || typeof max !== 'number' || max <= min) {
    return null;
  }

  return clampUnitInterval((value - min) / (max - min));
}

/**
 * @param {number | null | undefined} brightness normalized to [0, 1].
 * @returns {'unknown'|'low'|'normal'|'bright'}
 */
export function classifyLighting(brightness: number | null | undefined): 'unknown' | 'low' | 'normal' | 'bright' {
  const normalized = clampUnitInterval(brightness);
  if (normalized === null) {
    return 'unknown';
  }
  if (normalized <= LIGHTING_THRESHOLDS.low) {
    return 'low';
  }
  if (normalized >= LIGHTING_THRESHOLDS.bright) {
    return 'bright';
  }
  return 'normal';
}

// Estimate normalized scene brightness from a video track's current settings and
// reported capability ranges. Returns null when there is not enough information,
// in which case callers should leave the camera untouched.
/**
 * @param {{ brightness?: number, exposureCompensation?: number } | null | undefined} settings
 * @param {{
 *   brightness?: { min?: number, max?: number },
 *   exposureCompensation?: { min?: number, max?: number },
 * } | null | undefined} capabilities
 * @returns {number | null}
 */
export function estimateSceneBrightness(settings: { brightness?: number; exposureCompensation?: number; } | null | undefined, capabilities: {
        brightness?: { min?: number; max?: number; };
        exposureCompensation?: { min?: number; max?: number; };
    } | null | undefined): number | null {
  if (!settings || !capabilities) {
    return null;
  }

  if (typeof settings.brightness === 'number' && capabilities.brightness) {
    const normalized = normalizeToUnitRange(settings.brightness, capabilities.brightness);
    if (normalized !== null) {
      return normalized;
    }
  }

  // Fall back to exposure compensation: the camera dials it up to brighten a dark
  // scene, so a high compensation implies low ambient brightness (hence 1 - x).
  if (typeof settings.exposureCompensation === 'number' && capabilities.exposureCompensation) {
    const normalized = normalizeToUnitRange(
      settings.exposureCompensation,
      capabilities.exposureCompensation,
    );
    if (normalized !== null) {
      return clampUnitInterval(1 - normalized);
    }
  }

  return null;
}

export type LightingConstraints = { frameRate: { ideal: number; max?: number; }; advanced: Array<Record<string, unknown>>; };

/**
 * @param {number | null | undefined} brightness normalized to [0, 1].
 * @returns {{ condition: string, constraints: LightingConstraints | null }}
 */
export function getLightingAdjustedConstraints(brightness: number | null | undefined): { condition: string; constraints: LightingConstraints | null; } {
  const condition = classifyLighting(brightness);
  const profile =
    /** @type {Record<string, { frameRate: { ideal: number, max?: number }, exposureCompensation: number, brightness: number } | undefined>} */ (
      LIGHTING_PROFILES
    )[condition];

  if (!profile) {
    return { condition, constraints: null };
  }

  return {
    condition,
    constraints: {
      frameRate: profile.frameRate,
      advanced: [
        { exposureMode: 'continuous' },
        { exposureCompensation: profile.exposureCompensation },
        { brightness: profile.brightness },
      ],
    },
  };
}

// Read the current camera state, estimate scene brightness and apply lighting-
// adjusted constraints to the given video track. Safe to call repeatedly; it is a
// no-op when the track or required APIs are unavailable.
/**
 * @param {{ applyConstraints?: (constraints: object) => Promise<void> } | null | undefined} track
 * @returns {Promise<{ applied: boolean, condition: string, brightness?: number | null }>}
 */
export async function applyLightingAdjustment(track: { applyConstraints?: (constraints: object) => Promise<void>; } | null | undefined): Promise<{ applied: boolean; condition: string; brightness?: number | null; }> {
  if (!track || typeof track.applyConstraints !== 'function') {
    return { applied: false, condition: 'unknown' };
  }

  const settings = readTrackState(track, 'getSettings');
  const capabilities = readTrackState(track, 'getCapabilities');

  const brightness = estimateSceneBrightness(settings, capabilities);
  const { condition, constraints } = getLightingAdjustedConstraints(brightness);

  if (!constraints) {
    return { applied: false, condition };
  }

  try {
    await track.applyConstraints(constraints);
    logInfo('Camera lighting adjusted', { condition, brightness });
    return { applied: true, condition, brightness };
  } catch (error) {
    logError('Failed to apply lighting-adjusted camera constraints', error);
    return { applied: false, condition };
  }
}
