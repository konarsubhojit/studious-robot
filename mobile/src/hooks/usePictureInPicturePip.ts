import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { clamp } from '../callUx';
import { PIP_HEIGHT, PIP_MARGIN, PIP_WIDTH } from '../pipConstants';

/**
 * Encapsulates the draggable picture-in-picture self-view: tracks the call
 * stage size, keeps the PiP clamped within bounds, and exposes a tap-to-swap /
 * drag-to-move gesture plus the animated style.
 *
 * Bounds are stored as shared values so the UI-thread worklets inside the Pan
 * gesture can read them without crossing to the JS thread (avoids a worklet
 * call-non-worklet crash when dragging the PiP).
 *
 * @param {object} params
 * @param {() => void} params.onTap - Invoked when the PiP is tapped (swap streams).
 * @returns {{
 *   stageSize: { width: number, height: number },
 *   handleCallStageLayout: (event: object) => void,
 *   pipGesture: ReturnType<typeof Gesture.Race>,
 *   animatedPipStyle: object,
 * }}
 */
export default function usePictureInPicturePip({ onTap }: { onTap: () => void; }): {
    stageSize: { width: number; height: number; };
    handleCallStageLayout: (event: object) => void;
    pipGesture: ReturnType<typeof Gesture.Race>;
    animatedPipStyle: object;
} {
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [pipPosition, setPipPosition] = useState({ x: PIP_MARGIN, y: PIP_MARGIN });
  const hasDefaultPositioned = useRef(false);

  const pipX = useSharedValue(PIP_MARGIN);
  const pipY = useSharedValue(PIP_MARGIN);
  const pipStartX = useSharedValue(PIP_MARGIN);
  const pipStartY = useSharedValue(PIP_MARGIN);
  // Shared values for drag bounds so they are readable from UI-thread worklets.
  const pipMaxX = useSharedValue(PIP_MARGIN);
  const pipMaxY = useSharedValue(PIP_MARGIN);

  useEffect(() => {
    const maxX = Math.max(PIP_MARGIN, stageSize.width - PIP_WIDTH - PIP_MARGIN);
    const maxY = Math.max(PIP_MARGIN, stageSize.height - PIP_HEIGHT - PIP_MARGIN);

    pipMaxX.value = maxX;
    pipMaxY.value = maxY;

    // On first valid layout, snap the PiP to the bottom-right corner so it
    // does not obscure the remote participant in portrait orientation.
    if (!hasDefaultPositioned.current && stageSize.width > 0 && stageSize.height > 0) {
      hasDefaultPositioned.current = true;
      pipX.value = maxX;
      pipY.value = maxY;
      setPipPosition({ x: maxX, y: maxY });
      return;
    }

    const clampedX = clamp(pipPosition.x, PIP_MARGIN, maxX);
    const clampedY = clamp(pipPosition.y, PIP_MARGIN, maxY);
    if (clampedX !== pipPosition.x || clampedY !== pipPosition.y) {
      setPipPosition({ x: clampedX, y: clampedY });
      return;
    }
    pipX.value = clampedX;
    pipY.value = clampedY;
  }, [
    stageSize.width,
    stageSize.height,
    pipPosition.x,
    pipPosition.y,
    pipX,
    pipY,
    pipMaxX,
    pipMaxY,
  ]);

  const handleCallStageLayout = useCallback((/** @type {any} */ event: any) => {
    const { width, height } = event.nativeEvent.layout;
    setStageSize({ width, height });
  }, []);

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
          .onStart(() => {
            pipStartX.value = pipX.value;
            pipStartY.value = pipY.value;
          })
          .onUpdate(event => {
            pipX.value = clamp(pipStartX.value + event.translationX, PIP_MARGIN, pipMaxX.value);
            pipY.value = clamp(pipStartY.value + event.translationY, PIP_MARGIN, pipMaxY.value);
          })
          .onEnd(() => {
            runOnJS(setPipPosition)({ x: pipX.value, y: pipY.value });
          }),
      ),
    // Shared-value references are stable; only onTap needs to trigger recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onTap],
  );

  return { stageSize, handleCallStageLayout, pipGesture, animatedPipStyle };
}
