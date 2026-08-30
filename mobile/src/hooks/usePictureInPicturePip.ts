import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { clamp } from '../callUx';
import { NO_PIP_CHROME, PIP_MARGIN, resolvePipBounds } from '../pipConstants';
import type { PipChromeInsets } from '../pipConstants';
import useReducedMotion from './useReducedMotion';

/** Spring used to settle the tile against an edge after a drag or a fling. */
const PIP_SETTLE_SPRING = { damping: 20, stiffness: 220, mass: 0.6, overshootClamping: true };

/**
 * Distance (px) the finger must travel before the drag takes over from the tap.
 * Small enough that dragging feels immediate, large enough that the tremor in a
 * tap is not mistaken for one.
 */
const PIP_DRAG_ACTIVATION_PX = 4;

/**
 * How much of the release velocity carries into the settle position, expressed
 * as seconds of projected travel.  Enough for a flick to reach the far edge
 * without the tile sailing across the screen.
 */
const PIP_FLING_PROJECTION_S = 0.12;

/**
 * Encapsulates the draggable picture-in-picture self-view: tracks the call
 * stage size, keeps the PiP clamped within bounds, and exposes a tap-to-swap /
 * drag-to-move gesture plus the animated style.
 *
 * The tile's position lives entirely in shared values, so a drag runs on the UI
 * thread and never waits on a React render.  Routing the position through
 * component state made every drag end re-render the call screen and re-run the
 * bounds effect, and the tile stopped dead wherever the finger lifted.  On
 * release it now springs to the nearest side, carrying a little of the fling
 * velocity — the behaviour every system PiP window has.
 *
 * Bounds are stored as shared values too so the UI-thread worklets inside the
 * Pan gesture can read them without crossing to the JS thread (avoids a worklet
 * call-non-worklet crash when dragging the PiP).
 *
 * @param params.onTap - Invoked when the PiP is tapped (swap streams).
 */
export default function usePictureInPicturePip({ onTap }: { onTap: () => void; }): {
    stageSize: { width: number; height: number; };
    handleCallStageLayout: (event: object) => void;
    handleTopChromeLayout: (event: object) => void;
    handleBottomChromeLayout: (event: object) => void;
    pipGesture: ReturnType<typeof Gesture.Race>;
    animatedPipStyle: object;
} {
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  // The chrome drawn over the stage. Measured rather than assumed: the top
  // group grows by a whole banner the moment a call starts recovering.
  const [chromeInsets, setChromeInsets] = useState((NO_PIP_CHROME as PipChromeInsets));
  const hasDefaultPositioned = useRef(false);

  const pipX = useSharedValue(PIP_MARGIN);
  const pipY = useSharedValue(PIP_MARGIN);
  const pipStartX = useSharedValue(PIP_MARGIN);
  const pipStartY = useSharedValue(PIP_MARGIN);
  const reduceMotion = useReducedMotion();
  // Read from a shared value rather than a captured closure: the gesture is
  // memoised on `onTap` alone, so a preference that changed after mount would
  // otherwise never reach the worklet.
  const reduceMotionShared = useSharedValue(false);
  useEffect(() => {
    reduceMotionShared.value = reduceMotion;
  }, [reduceMotion, reduceMotionShared]);

  // Shared values for drag bounds so they are readable from UI-thread worklets.
  const pipMaxX = useSharedValue(PIP_MARGIN);
  const pipMaxY = useSharedValue(PIP_MARGIN);
  const pipMinY = useSharedValue(PIP_MARGIN);

  useEffect(() => {
    const { minX, maxX, minY, maxY } = resolvePipBounds(stageSize, chromeInsets);

    pipMaxX.value = maxX;
    pipMaxY.value = maxY;
    pipMinY.value = minY;

    // On first valid layout, snap the PiP to the bottom-right *of the safe
    // region* so it does not obscure the remote participant in portrait
    // orientation — and does not start life under the control deck.
    if (!hasDefaultPositioned.current && stageSize.width > 0 && stageSize.height > 0) {
      hasDefaultPositioned.current = true;
      pipX.value = maxX;
      pipY.value = maxY;
      return;
    }

    // A rotation, a stage resize, or chrome that just grew by a reconnect
    // banner can leave the tile outside the new bounds; ease it back in rather
    // than teleporting it.
    const clampedX = clamp(pipX.value, minX, maxX);
    const clampedY = clamp(pipY.value, minY, maxY);
    // Reduced motion still moves the tile back inside the bounds — leaving it
    // off-screen would be a bug, not a calmer animation — it just arrives in
    // one step.
    if (clampedX !== pipX.value) {
      pipX.value = reduceMotion ? clampedX : withSpring(clampedX, PIP_SETTLE_SPRING);
    }
    if (clampedY !== pipY.value) {
      pipY.value = reduceMotion ? clampedY : withSpring(clampedY, PIP_SETTLE_SPRING);
    }
  }, [
    stageSize,
    chromeInsets,
    pipX,
    pipY,
    pipMaxX,
    pipMaxY,
    pipMinY,
    reduceMotion,
  ]);

  const handleCallStageLayout = useCallback((event: any) => {
    const { width, height } = event.nativeEvent.layout;
    setStageSize(current =>
      current.width === width && current.height === height ? current : { width, height },
    );
    // The stage is gone, so the chrome that was over it is too: keeping its
    // heights would hand the next call the previous one's safe region.
    if (width === 0 || height === 0) setChromeInsets(NO_PIP_CHROME);
  }, []);

  /**
   * Record a measured chrome height.
   *
   * The chrome auto-hides after a few idle seconds, which unmounts it and
   * reports no layout at all. The tile deliberately keeps the bounds it had:
   * the chrome comes back on the next tap, and a tile that drifted under the
   * top bar in between would be unreachable exactly when a banner appears.
   */
  const measureChrome = useCallback((edge: 'top' | 'bottom', height: number) => {
    setChromeInsets(current =>
      current[edge] === height ? current : { ...current, [edge]: height },
    );
  }, []);

  const handleTopChromeLayout = useCallback(
    (event: any) => measureChrome('top', event.nativeEvent.layout.height),
    [measureChrome],
  );

  const handleBottomChromeLayout = useCallback(
    (event: any) => measureChrome('bottom', event.nativeEvent.layout.height),
    [measureChrome],
  );

  const animatedPipStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pipX.value }, { translateY: pipY.value }],
  }));

  // Memoised so GestureDetector does not remount the native handler on every
  // render.  Bounds are read from shared values, not from a captured closure,
  // so they stay current without needing gesture recreation.
  const pipGesture = useMemo(
    () =>
      Gesture.Race(
        Gesture.Tap().onEnd(() => {
          runOnJS(onTap)();
        }),
        Gesture.Pan()
          .minDistance(PIP_DRAG_ACTIVATION_PX)
          .onStart(() => {
            pipStartX.value = pipX.value;
            pipStartY.value = pipY.value;
          })
          .onUpdate(event => {
            pipX.value = clamp(pipStartX.value + event.translationX, PIP_MARGIN, pipMaxX.value);
            pipY.value = clamp(
              pipStartY.value + event.translationY,
              pipMinY.value,
              pipMaxY.value,
            );
          })
          .onEnd(event => {
            // Project the fling, then park flush against whichever side the
            // tile ended up closest to.
            const projectedX = pipX.value + (event.velocityX ?? 0) * PIP_FLING_PROJECTION_S;
            const projectedY = pipY.value + (event.velocityY ?? 0) * PIP_FLING_PROJECTION_S;
            const restingX =
              projectedX > (PIP_MARGIN + pipMaxX.value) / 2 ? pipMaxX.value : PIP_MARGIN;

            const restingY = clamp(projectedY, pipMinY.value, pipMaxY.value);
            if (reduceMotionShared.value) {
              // The tile still parks against the nearest edge; only the glide
              // to it is dropped.
              pipX.value = restingX;
              pipY.value = restingY;
              return;
            }
            pipX.value = withSpring(restingX, PIP_SETTLE_SPRING);
            pipY.value = withSpring(restingY, PIP_SETTLE_SPRING);
          }),
      ),
    // Shared-value references are stable; only onTap needs to trigger recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onTap],
  );

  return {
    stageSize,
    handleCallStageLayout,
    handleTopChromeLayout,
    handleBottomChromeLayout,
    pipGesture,
    animatedPipStyle,
  };
}
