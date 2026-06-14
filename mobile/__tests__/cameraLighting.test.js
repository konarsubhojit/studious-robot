import {
  applyLightingAdjustment,
  classifyLighting,
  estimateSceneBrightness,
  getLightingAdjustedConstraints,
  normalizeToUnitRange,
} from '../src/cameraLighting';

describe('cameraLighting', () => {
  test('classifyLighting buckets brightness into low/normal/bright', () => {
    expect(classifyLighting(0.1)).toBe('low');
    expect(classifyLighting(0.5)).toBe('normal');
    expect(classifyLighting(0.9)).toBe('bright');
  });

  test('classifyLighting returns unknown for invalid input', () => {
    expect(classifyLighting(undefined)).toBe('unknown');
    expect(classifyLighting(NaN)).toBe('unknown');
  });

  test('normalizeToUnitRange maps a value into [0, 1]', () => {
    expect(normalizeToUnitRange(5, { min: 0, max: 10 })).toBe(0.5);
    expect(normalizeToUnitRange(-5, { min: 0, max: 10 })).toBe(0);
    expect(normalizeToUnitRange(50, { min: 0, max: 10 })).toBe(1);
    expect(normalizeToUnitRange(5, { min: 10, max: 10 })).toBeNull();
    expect(normalizeToUnitRange(5, null)).toBeNull();
  });

  test('estimateSceneBrightness uses brightness setting when available', () => {
    const brightness = estimateSceneBrightness(
      { brightness: 2 },
      { brightness: { min: 0, max: 10 } },
    );
    expect(brightness).toBe(0.2);
  });

  test('estimateSceneBrightness falls back to inverted exposure compensation', () => {
    const brightness = estimateSceneBrightness(
      { exposureCompensation: 3 },
      { exposureCompensation: { min: 0, max: 4 } },
    );
    // High exposure compensation implies a dark scene -> low brightness.
    expect(brightness).toBe(0.25);
  });

  test('estimateSceneBrightness returns null without usable data', () => {
    expect(estimateSceneBrightness(null, null)).toBeNull();
    expect(estimateSceneBrightness({}, {})).toBeNull();
  });

  test('getLightingAdjustedConstraints lowers frame rate in low light', () => {
    const { condition, constraints } = getLightingAdjustedConstraints(0.1);
    expect(condition).toBe('low');
    expect(constraints.frameRate).toEqual({ ideal: 24, max: 30 });
    expect(constraints.advanced).toContainEqual({ exposureCompensation: 1.5 });
    expect(constraints.advanced).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ aperture: expect.anything() })]),
    );
  });

  test('getLightingAdjustedConstraints adjusts exposure in bright light', () => {
    const { condition, constraints } = getLightingAdjustedConstraints(0.95);
    expect(condition).toBe('bright');
    expect(constraints.advanced).toContainEqual({ exposureCompensation: -0.5 });
  });

  test('getLightingAdjustedConstraints returns no constraints when lighting is unknown', () => {
    const { condition, constraints } = getLightingAdjustedConstraints(undefined);
    expect(condition).toBe('unknown');
    expect(constraints).toBeNull();
  });

  test('applyLightingAdjustment applies constraints derived from track state', async () => {
    const applyConstraints = jest.fn().mockResolvedValue(undefined);
    const track = {
      applyConstraints,
      getSettings: () => ({ brightness: 1 }),
      getCapabilities: () => ({ brightness: { min: 0, max: 10 } }),
    };

    const result = await applyLightingAdjustment(track);

    expect(result.applied).toBe(true);
    expect(result.condition).toBe('low');
    expect(applyConstraints).toHaveBeenCalledTimes(1);
    expect(applyConstraints.mock.calls[0][0].advanced).toContainEqual({ exposureCompensation: 1.5 });
  });

  test('applyLightingAdjustment is a no-op when brightness cannot be estimated', async () => {
    const applyConstraints = jest.fn().mockResolvedValue(undefined);
    const track = {
      applyConstraints,
      getSettings: () => ({}),
      getCapabilities: () => ({}),
    };

    const result = await applyLightingAdjustment(track);

    expect(result.applied).toBe(false);
    expect(applyConstraints).not.toHaveBeenCalled();
  });

  test('applyLightingAdjustment swallows applyConstraints errors', async () => {
    const track = {
      applyConstraints: jest.fn().mockRejectedValue(new Error('not supported')),
      getSettings: () => ({ brightness: 9 }),
      getCapabilities: () => ({ brightness: { min: 0, max: 10 } }),
    };

    const result = await applyLightingAdjustment(track);

    expect(result.applied).toBe(false);
    expect(result.condition).toBe('bright');
  });

  test('applyLightingAdjustment swallows getCapabilities not-implemented errors', async () => {
    const applyConstraints = jest.fn().mockResolvedValue(undefined);
    const track = {
      applyConstraints,
      getSettings: () => ({ brightness: 5 }),
      getCapabilities: () => {
        throw new Error('Not implemented.');
      },
    };

    const result = await applyLightingAdjustment(track);

    expect(result.applied).toBe(false);
    expect(result.condition).toBe('unknown');
    expect(applyConstraints).not.toHaveBeenCalled();
  });

  test('applyLightingAdjustment returns no-op for an invalid track', async () => {
    const result = await applyLightingAdjustment(null);
    expect(result.applied).toBe(false);
  });
});
