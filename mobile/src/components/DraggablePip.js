import { StyleSheet } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import SafeRTCView from '../SafeRTCView';
import { PIP_HEIGHT, PIP_WIDTH } from '../pipConstants';
import { colors, radius } from '../theme';

/**
 * Draggable picture-in-picture self-view. Tap swaps streams; drag repositions
 * (gesture supplied by the usePictureInPicturePip hook).
 *
 * @param {object} props
 * @param {object} props.gesture - Composed gesture from the PiP hook.
 * @param {object} props.animatedStyle - Animated transform style.
 * @param {string|null} props.streamURL
 * @param {boolean} props.mirror
 */
export default function DraggablePip({ gesture, animatedStyle, streamURL, mirror }) {
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[styles.localPip, animatedStyle]}
        accessibilityRole="adjustable"
        accessibilityLabel="Self view. Tap to swap, drag to move."
      >
        <SafeRTCView
          fallbackLabel="Self-view unavailable"
          style={styles.localPipStream}
          streamURL={streamURL}
          objectFit="cover"
          mirror={mirror}
          zOrder={2}
        />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  localPip: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: PIP_WIDTH,
    height: PIP_HEIGHT,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: colors.pipBackground,
  },
  localPipStream: {
    flex: 1,
  },
});
