import {
  PIP_HEIGHT,
  PIP_MARGIN,
  PIP_WIDTH,
  resolvePipBounds,
} from '../src/pipConstants';

describe('resolvePipBounds', () => {
  const stage = { width: 400, height: 800 };

  it('insets the tile from the stage edges when no chrome is measured', () => {
    expect(resolvePipBounds(stage)).toEqual({
      minX: PIP_MARGIN,
      minY: PIP_MARGIN,
      maxX: stage.width - PIP_WIDTH - PIP_MARGIN,
      maxY: stage.height - PIP_HEIGHT - PIP_MARGIN,
    });
  });

  it('keeps the tile clear of the top bar and the control deck', () => {
    const bounds = resolvePipBounds(stage, { top: 120, bottom: 180 });

    expect(bounds.minY).toBe(PIP_MARGIN + 120);
    expect(bounds.maxY).toBe(stage.height - PIP_HEIGHT - PIP_MARGIN - 180);
  });

  it('never inverts the vertical range on a stage too short for the chrome', () => {
    const bounds = resolvePipBounds(stage, { top: 400, bottom: 400 });

    expect(bounds.maxY).toBe(bounds.minY);
    expect(bounds.maxY).toBeGreaterThanOrEqual(PIP_MARGIN);
  });

  it('ignores negative chrome heights', () => {
    expect(resolvePipBounds(stage, { top: -50, bottom: -50 })).toEqual(
      resolvePipBounds(stage),
    );
  });

  it('collapses to the margin before the stage has been laid out', () => {
    expect(resolvePipBounds({ width: 0, height: 0 })).toEqual({
      minX: PIP_MARGIN,
      minY: PIP_MARGIN,
      maxX: PIP_MARGIN,
      maxY: PIP_MARGIN,
    });
  });
});
