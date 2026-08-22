// @ts-check
import { useCallback, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing } from '../theme';
import CallControls from './CallControls';

/**
 * Approximate panel height used for initial positioning and clamping before
 * the first layout measurement.  Based on: top-padding + drag-handle (4 + 8) +
 * two button rows at 44 px each + 8 px gap + bottom-padding = ~120 px.
 */
const PANEL_HEIGHT_ESTIMATE = 120;

/** Horizontal margin kept between the panel edges and the screen edges. */
const PANEL_SIDE_MARGIN = spacing.md;

/** Minimum gap left between the panel bottom edge and the screen bottom. */
const PANEL_BOTTOM_GAP = spacing.lg * 2;

/**
 * A draggable floating controls menu that overlays the call screen.
 *
 * The panel starts near the bottom of the screen so it does not obscure the
 * video feed by default.  Users can drag it to any position; it snaps back
 * within safe visible bounds so it never disappears off-screen.
 *
 * All in-call actions (mute, camera, audio output, camera swap, leave) are
 * forwarded to the inner {@link CallControls} component unchanged.
 *
 * @param {Parameters<typeof CallControls>[0]} props - Same props as
 *   {@link CallControls}.
 */
export default function DraggableCallControls({
  isMuted,
  isVideoEnabled,
  hasLocalStream,
  audioDevices,
  isSpeakerEnabled,
  onMuteToggle,
  onVideoToggle,
  onChooseAudioOutput,
  onCameraSwitch,
  onLeave,
}) {
  const styles = useThemedStyles(createStyles);

  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  // Measure the actual panel height after first layout so the clamp bounds
  // stay accurate when the font size or content size changes.
  const [panelHeight, setPanelHeight] = useState(PANEL_HEIGHT_ESTIMATE);
  const handlePanelLayout = useCallback(
    /** @param {import('react-native').LayoutChangeEvent} event */
    event => {
      const { height } = event.nativeEvent.layout;
      if (height > 0 && height !== panelHeight) {
        setPanelHeight(height);
      }
    },
    [panelHeight],
  );

  // Panel occupies the full width between side margins.
  const panelWidth = screenWidth - 2 * PANEL_SIDE_MARGIN;

  // Allowable translation range keeps the entire panel on-screen.
  // panelWidth = screenWidth - 2*PANEL_SIDE_MARGIN, so the right bound is
  // screenWidth - panelWidth = 2*PANEL_SIDE_MARGIN (panel touches the right edge).
  const maxX = Math.max(0, screenWidth - panelWidth);
  const maxY = Math.max(0, screenHeight - panelHeight - PANEL_SIDE_MARGIN);

  // Default position: aligned with the left margin, vertically
  // near the bottom so the video area above is fully visible.
  const defaultX = PANEL_SIDE_MARGIN;
  const defaultY = Math.max(0, screenHeight - panelHeight - PANEL_BOTTOM_GAP);

  const panX = useSharedValue(defaultX);
  const panY = useSharedValue(defaultY);
  const startX = useSharedValue(defaultX);
  const startY = useSharedValue(defaultY);

  const gesture = Gesture.Pan()
    .onStart(() => {
      startX.value = panX.value;
      startY.value = panY.value;
    })
    .onUpdate(event => {
      'worklet';
      const nextX = startX.value + event.translationX;
      const nextY = startY.value + event.translationY;
      panX.value = Math.min(Math.max(nextX, 0), maxX);
      panY.value = Math.min(Math.max(nextY, 0), maxY);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: panX.value }, { translateY: panY.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        onLayout={handlePanelLayout}
        style={[styles.panel, { width: panelWidth }, animatedStyle]}
        accessibilityLabel="Call controls. Drag to reposition."
        testID="draggable-call-controls">
        <View
          style={styles.dragHandle}
          accessibilityElementsHidden={true}
          importantForAccessibility="no"
        />
        <CallControls
          isMuted={isMuted}
          isVideoEnabled={isVideoEnabled}
          hasLocalStream={hasLocalStream}
          audioDevices={audioDevices}
          isSpeakerEnabled={isSpeakerEnabled}
          onMuteToggle={onMuteToggle}
          onVideoToggle={onVideoToggle}
          onChooseAudioOutput={onChooseAudioOutput}
          onCameraSwitch={onCameraSwitch}
          onLeave={onLeave}
        />
      </Animated.View>
    </GestureDetector>
  );
}

/** @param {import('../theme').ThemeColors} colors */
const createStyles = colors =>
  StyleSheet.create({
    panel: {
      position: 'absolute',
      top: 0,
      left: 0,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.35,
      shadowRadius: 8,
      elevation: 8,
    },
    dragHandle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      alignSelf: 'center',
      marginBottom: spacing.sm,
    },
  });
