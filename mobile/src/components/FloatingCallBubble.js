import { useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { formatCallDuration } from '../callUx';
import { colors, radius, spacing, typography } from '../theme';
import IconButton from './IconButton';

const BUBBLE_WIDTH = 180;
const BUBBLE_HEIGHT = 72;
const BUBBLE_MARGIN = 12;

/**
 * In-app floating call bubble: a small draggable "call in progress" pill,
 * shown when the user navigates away from the full-screen CallScreen while a
 * call stays active (e.g. taps a bottom tab, or the explicit minimize button
 * in CallTopBar).
 *
 * This is the in-app analogue of Teams/Slack's floating call bubble, and is
 * distinct from the OS-level Android Picture-in-Picture already handled by
 * `useCompactCallView` / `enterPictureInPicture`: OS PiP only ever fires when
 * the app is backgrounded, whereas this bubble only appears while the app is
 * foregrounded and the user has simply navigated to another in-app screen.
 *
 * Uses plain `PanResponder` (core React Native) rather than
 * react-native-gesture-handler/reanimated so it stays lightweight and needs no
 * extra native module or test mocking beyond what core RN testing already
 * provides.
 *
 * @param {object} props
 * @param {string|null} [props.participantLabel]
 * @param {number} [props.elapsedCallSeconds]
 * @param {boolean} [props.isMuted]
 * @param {boolean} [props.isScreenSharing]
 * @param {() => void} props.onExpand
 * @param {() => void} [props.onMuteToggle]
 * @param {() => void} [props.onEndCall]
 * @param {() => void} [props.onStopScreenShare]
 */
export default function FloatingCallBubble({
  participantLabel = null,
  elapsedCallSeconds = 0,
  isMuted = false,
  isScreenSharing = false,
  onExpand,
  onMuteToggle,
  onEndCall,
  onStopScreenShare,
}) {
  const { width, height } = useWindowDimensions();

  const maxX = Math.max(BUBBLE_MARGIN, width - BUBBLE_WIDTH - BUBBLE_MARGIN);
  const maxY = Math.max(BUBBLE_MARGIN, height - BUBBLE_HEIGHT - BUBBLE_MARGIN);

  const [position, setPosition] = useState({ x: maxX, y: maxY });
  const positionRef = useRef(position);
  const pan = useRef(new Animated.ValueXY(position)).current;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_evt, gestureState) =>
          Math.abs(gestureState.dx) > 2 || Math.abs(gestureState.dy) > 2,
        onPanResponderGrant: () => {
          pan.setOffset(positionRef.current);
          pan.setValue({ x: 0, y: 0 });
        },
        onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
          useNativeDriver: false,
        }),
        onPanResponderRelease: (_evt, gestureState) => {
          pan.flattenOffset();
          const nextX = Math.min(
            Math.max(positionRef.current.x + gestureState.dx, BUBBLE_MARGIN),
            maxX,
          );
          const nextY = Math.min(
            Math.max(positionRef.current.y + gestureState.dy, BUBBLE_MARGIN),
            maxY,
          );
          positionRef.current = { x: nextX, y: nextY };
          setPosition({ x: nextX, y: nextY });
          pan.setValue({ x: nextX, y: nextY });
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [maxX, maxY],
  );

  return (
    <Animated.View
      style={[
        styles.bubble,
        { transform: pan.getTranslateTransform() },
      ]}
      testID="floating-call-bubble"
      {...panResponder.panHandlers}
    >
      <Pressable
        onPress={onExpand}
        style={styles.body}
        accessibilityRole="button"
        accessibilityLabel="Expand call"
        testID="floating-call-bubble-expand"
      >
        <Text style={styles.glyph}>📞</Text>
        <View style={styles.textWrap}>
          <Text style={styles.label} numberOfLines={1}>
            {participantLabel || 'Call in progress'}
          </Text>
          <Text style={styles.timer}>{formatCallDuration(elapsedCallSeconds)}</Text>
        </View>
      </Pressable>

      <View style={styles.actions}>
        <IconButton
          icon={isMuted ? 'micOff' : 'micOn'}
          onPress={onMuteToggle}
          variant={isMuted ? 'active' : 'default'}
          size={32}
          accessibilityLabel={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          testID="floating-call-bubble-mute"
        />
        {isScreenSharing ? (
          <IconButton
            icon="stopShare"
            onPress={onStopScreenShare}
            variant="active"
            size={32}
            accessibilityLabel="Stop sharing your screen"
            testID="floating-call-bubble-stop-share"
          />
        ) : null}
        <IconButton
          icon="callEnd"
          onPress={onEndCall}
          variant="danger"
          size={32}
          accessibilityLabel="End call"
          testID="floating-call-bubble-end"
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: BUBBLE_WIDTH,
    height: BUBBLE_HEIGHT,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    gap: spacing.xs,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 8,
    zIndex: 999,
  },
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: spacing.xs,
  },
  glyph: {
    fontSize: 20,
  },
  textWrap: {
    flexShrink: 1,
  },
  label: {
    ...typography.hint,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  timer: {
    ...typography.hint,
    color: colors.textSecondary,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
});
