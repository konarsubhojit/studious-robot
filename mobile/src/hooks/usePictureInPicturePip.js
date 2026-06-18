import { useCallback, useEffect, useRef, useState } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { clamp } from '../callUx';
import { PIP_HEIGHT, PIP_MARGIN, PIP_WIDTH } from '../pipConstants';

/**
 * Encapsulates the draggable picture-in-picture self-view: tracks the call
 * stage size, keeps the PiP clamped within bounds, and exposes a tap-to-swap /
 * drag-to-move gesture plus the animated style.
 *
 * @param {object} params
 * @param {() => void} params.onTap - Invoked when the PiP is tapped (swap streams).
 * @returns {{
 *   stageSize: { width: number, height: number },
 *   handleCallStageLayout: (event: object) => void,
 *   pipGesture: object,
 *   animatedPipStyle: object,
 * }}
 */
export default function usePictureInPicturePip({ onTap }) {
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [pipPosition, setPipPosition] = useState({ x: PIP_MARGIN, y: PIP_MARGIN });
  const hasDefaultPositioned = useRef(false);

  const pipX = useSharedValue(PIP_MARGIN);
  const pipY = useSharedValue(PIP_MARGIN);
  const pipStartX = useSharedValue(PIP_MARGIN);
  const pipStartY = useSharedValue(PIP_MARGIN);

  const getPipBounds = useCallback(() => {
    const maxX = Math.max(PIP_MARGIN, stageSize.width - PIP_WIDTH - PIP_MARGIN);
    const maxY = Math.max(PIP_MARGIN, stageSize.height - PIP_HEIGHT - PIP_MARGIN);
    return { minX: PIP_MARGIN, minY: PIP_MARGIN, maxX, maxY };
  }, [stageSize.height, stageSize.width]);

  useEffect(() => {
    const bounds = getPipBounds();

    // On first valid layout, snap the PiP to the bottom-right corner so it
    // does not obscure the remote participant in portrait orientation.
    if (!hasDefaultPositioned.current && stageSize.width > 0 && stageSize.height > 0) {
      hasDefaultPositioned.current = true;
      setPipPosition({ x: bounds.maxX, y: bounds.maxY });
      return;
    }

    const clampedX = clamp(pipPosition.x, bounds.minX, bounds.maxX);
    const clampedY = clamp(pipPosition.y, bounds.minY, bounds.maxY);
    if (clampedX !== pipPosition.x || clampedY !== pipPosition.y) {
      setPipPosition({ x: clampedX, y: clampedY });
      return;
    }
    pipX.value = clampedX;
    pipY.value = clampedY;
  }, [getPipBounds, pipPosition.x, pipPosition.y, pipX, pipY, stageSize.width, stageSize.height]);

  const handleCallStageLayout = useCallback((event) => {
    const { width, height } = event.nativeEvent.layout;
    setStageSize({ width, height });
  }, []);

  const animatedPipStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pipX.value }, { translateY: pipY.value }],
  }));

  const pipBounds = getPipBounds();

  const pipGesture = Gesture.Race(
    Gesture.Tap().onEnd(() => {
      runOnJS(onTap)();
    }),
    Gesture.Pan()
      .onStart(() => {
        pipStartX.value = pipX.value;
        pipStartY.value = pipY.value;
      })
      .onUpdate((event) => {
        pipX.value = clamp(pipStartX.value + event.translationX, pipBounds.minX, pipBounds.maxX);
        pipY.value = clamp(pipStartY.value + event.translationY, pipBounds.minY, pipBounds.maxY);
      })
      .onEnd(() => {
        runOnJS(setPipPosition)({ x: pipX.value, y: pipY.value });
      }),
  );

  return { stageSize, handleCallStageLayout, pipGesture, animatedPipStyle };
}
