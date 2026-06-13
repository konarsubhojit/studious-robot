import { logError, logInfo } from './appLogger';

// Scene brightness is normalized to the [0, 1] range, where 0 is very dark and 1
// is very bright. These thresholds split that range into low / normal / bright.
export const LIGHTING_THRESHOLDS = {
  low: 0.25,
  bright: 0.75,
};

// Recommended camera controls per lighting condition. Phone cameras usually have
// a fixed aperture, so `aperture` (f-number) is only honored on the few devices
// that expose a variable aperture; the other controls (exposure compensation,
// brightness, frame rate) are what improve perceived lighting everywhere else.
// All values are supplied as best-effort `advanced` constraints so unsupported
// controls are ignored rather than causing applyConstraints to fail.
export const LIGHTING_PROFILES = {
  low: {
    frameRate: { ideal: 24, max: 30 },
    aperture: 1.5,
    exposureCompensation: 1.5,
    brightness: 0.7,
  },
  normal: {
    frameRate: { ideal: 30 },
    aperture: 1.8,
    exposureCompensation: 0,
    brightness: 0.5,
  },
  bright: {
    frameRate: { ideal: 30 },
    aperture: 2.4,
    exposureCompensation: -0.5,
    brightness: 0.4,
  },
};

export function clampUnitInterval(value) {
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

export function normalizeToUnitRange(value, range) {
  if (typeof value !== 'number' || Number.isNaN(value) || !range) {
    return null;
  }

  const { min, max } = range;
  if (typeof min !== 'number' || typeof max !== 'number' || max <= min) {
    return null;
  }

  return clampUnitInterval((value - min) / (max - min));
}

export function classifyLighting(brightness) {
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
export function estimateSceneBrightness(settings, capabilities) {
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
  if (
    typeof settings.exposureCompensation === 'number' &&
    capabilities.exposureCompensation
  ) {
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

export function getLightingAdjustedConstraints(brightness) {
  const condition = classifyLighting(brightness);
  const profile = LIGHTING_PROFILES[condition];

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
        { aperture: profile.aperture },
      ],
    },
  };
}

// Read the current camera state, estimate scene brightness and apply lighting-
// adjusted constraints to the given video track. Safe to call repeatedly; it is a
// no-op when the track or required APIs are unavailable.
export async function applyLightingAdjustment(track) {
  if (!track || typeof track.applyConstraints !== 'function') {
    return { applied: false, condition: 'unknown' };
  }

  let settings = null;
  let capabilities = null;
  try {
    if (typeof track.getSettings === 'function') {
      settings = track.getSettings();
    }
    if (typeof track.getCapabilities === 'function') {
      capabilities = track.getCapabilities();
    }
  } catch (error) {
    logError('Failed to read camera state for lighting adjustment', error);
    return { applied: false, condition: 'unknown' };
  }

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
