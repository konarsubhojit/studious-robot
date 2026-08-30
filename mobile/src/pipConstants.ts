/** Picture-in-picture self-view dimensions, shared by the PiP hook and view. */
export const PIP_WIDTH = 90;
export const PIP_HEIGHT = 160;
export const PIP_MARGIN = 12;

/** Heights of the call chrome drawn *over* the stage, as last measured. */
export type PipChromeInsets = {
  /** Top bar plus any reconnect/status banner below it. */
  top: number;
  /** The control deck. */
  bottom: number;
};

export type PipBounds = { minX: number; maxX: number; minY: number; maxY: number; };

/** No chrome measured yet, i.e. the whole stage is available. */
export const NO_PIP_CHROME: PipChromeInsets = Object.freeze({ top: 0, bottom: 0 });

/**
 * The region of the stage the self-view may occupy.
 *
 * The tile used to be clamped to the raw stage with a 12px margin and no
 * knowledge of the overlay, which renders above it: dragging the tile upwards
 * slid it under the top bar, and its default corner was exactly where the
 * control deck sits. Worst of all, the top chrome *grows* when a reconnect
 * banner or an error appears — so the tile disappeared under precisely the
 * message it was hiding.
 *
 * Bounds never invert: on a stage too short for the chrome and the tile, the
 * range collapses to a single reachable position rather than a negative one.
 */
export function resolvePipBounds(
  stageSize: { width: number; height: number; },
  chrome: PipChromeInsets = NO_PIP_CHROME,
): PipBounds {
  const minX = PIP_MARGIN;
  const minY = PIP_MARGIN + Math.max(0, chrome.top);
  const maxX = Math.max(minX, stageSize.width - PIP_WIDTH - PIP_MARGIN);
  const maxY = Math.max(
    minY,
    stageSize.height - PIP_HEIGHT - PIP_MARGIN - Math.max(0, chrome.bottom),
  );
  return { minX, maxX, minY, maxY };
}
