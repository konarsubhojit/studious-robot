import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { logInfo, logVerbose, logWarn } from '../appLogger';
import { isAudioSessionActive } from '../audioSessionState';
import useReducedMotion from '../hooks/useReducedMotion';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, spacing, touchSlop, typography } from '../theme';
import { loadVideoComponent } from '../videoPlayback';
import IconButton from './IconButton';
import { Icon } from './primitives';
import type { ThemeColors } from '../theme';

/** Zoom applied by a double tap, and the ceiling for a pinch. */
const DOUBLE_TAP_SCALE = 2.5;
const MAX_SCALE = 4;
/** Movement (dp) that turns a tap into a drag. */
const DRAG_SLOP = 8;
/** Fraction of the screen width a swipe must cover to change media item. */
const PAGE_THRESHOLD = 0.25;
/** Downward drag (dp) that dismisses the viewer. */
const DISMISS_DY = 120;
/** Spring used whenever the media snaps back to its resting transform. */
const SETTLE_SPRING = { damping: 20, stiffness: 220, mass: 0.5 };

/**
 * What a completed drag on the media surface means.
 *
 * Kept as a pure function so the decision thresholds are testable without
 * synthesising a touch stream.
 *
 * Marked as a worklet because the pan gesture's `onEnd` — which the Reanimated
 * Babel plugin compiles to run on the UI thread — calls it directly. Without
 * the directive the function does not exist in the UI runtime and the call
 * throws the moment a drag ends.
 *
 * @param gesture the completed drag, plus the current zoom and screen width.
 */
export function resolveMediaGesture({ dx = 0, dy = 0, scale = 1, width = 0 }: {
        dx?: number; dy?: number; scale?: number; width?: number;
    }): 'tap' | 'pan' | 'next' | 'previous' | 'dismiss' | 'none' {
  'worklet';
  if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return 'tap';
  // Zoomed in, the drag panned the media rather than the gallery.
  if (scale > 1) return 'pan';
  if (dy > DISMISS_DY && Math.abs(dy) > Math.abs(dx)) return 'dismiss';
  const pageDistance = width * PAGE_THRESHOLD;
  if (pageDistance > 0 && dx <= -pageDistance) return 'next';
  if (pageDistance > 0 && dx >= pageDistance) return 'previous';
  return 'none';
}

/** One item in the viewer: an image or a video attachment. */
export type MediaViewerItem = {
  key: string;
  url: string;
  mimeType?: string | null;
  name?: string | null;
  kind: 'image' | 'video';
};

type MediaViewerStyles = ReturnType<typeof createStyles>;

function MediaViewerContent({
  item,
  hasFailed,
  VideoComponent,
  callOwnsAudio,
  mediaGesture,
  animatedMediaStyle,
  styles,
  testID,
  onVideoError,
  onImageError,
}: {
  item: MediaViewerItem | null;
  hasFailed: boolean;
  VideoComponent: ReturnType<typeof loadVideoComponent>;
  callOwnsAudio: boolean;
  mediaGesture: ReturnType<typeof Gesture.Race>;
  animatedMediaStyle: object;
  styles: MediaViewerStyles;
  testID: string;
  onVideoError: (error: unknown) => void;
  onImageError: () => void;
}) {
  if (!item) {
    return (
      <Text style={styles.message} testID={`${testID}-empty`}>
        This media is no longer available
      </Text>
    );
  }
  if (hasFailed) {
    return (
      <Text style={styles.message} testID={`${testID}-error`}>
        This file could not be loaded. It may have been removed from storage.
      </Text>
    );
  }
  if (item.kind === 'video') {
    if (!VideoComponent) {
      return (
        <Text style={styles.message} testID={`${testID}-video-unavailable`}>
          Video playback isn't available on this build — download the file to watch it
        </Text>
      );
    }
    return (
      <VideoComponent
        source={{ uri: item.url }}
        style={styles.media}
        controls
        // A call owns the audio route; a video that autoplayed into it
        // would take the route away mid-call, so it waits for a tap.
        paused={callOwnsAudio}
        resizeMode="contain"
        onError={onVideoError}
        testID={`${testID}-video`}
      />
    );
  }
  return (
    <GestureDetector gesture={mediaGesture}>
      <Animated.View style={[styles.mediaWrapper, animatedMediaStyle]}>
        <Image
          source={{ uri: item.url }}
          style={styles.media}
          resizeMode="contain"
          accessibilityLabel={item.name || 'Photo'}
          onError={onImageError}
          testID={`${testID}-image`}
        />
      </Animated.View>
    </GestureDetector>
  );
}

function MediaViewerPager({
  index,
  count,
  goTo,
  styles,
  colors,
  testID,
}: {
  index: number;
  count: number;
  goTo: (index: number) => void;
  styles: MediaViewerStyles;
  colors: ReturnType<typeof useTheme>['colors'];
  testID: string;
}) {
  if (count <= 1) return null;
  return (
    <View style={styles.footer}>
      <Pressable
        onPress={() => goTo(index - 1)}
        disabled={index === 0}
        accessibilityRole="button"
        accessibilityLabel="Previous media"
        accessibilityState={{ disabled: index === 0 }}
        hitSlop={touchSlop(24)}
        style={[styles.pageButton, index === 0 && styles.pageButtonDisabled]}
        testID={`${testID}-previous`}>
        <Icon name="back" size={22} color={colors.onOverlay} />
      </Pressable>
      <Text style={styles.counter} testID={`${testID}-counter`}>
        {`${index + 1} / ${count}`}
      </Text>
      <Pressable
        onPress={() => goTo(index + 1)}
        disabled={index === count - 1}
        accessibilityRole="button"
        accessibilityLabel="Next media"
        accessibilityState={{ disabled: index === count - 1 }}
        hitSlop={touchSlop(24)}
        style={[styles.pageButton, index === count - 1 && styles.pageButtonDisabled]}
        testID={`${testID}-next`}>
        <Icon name="forward" size={22} color={colors.onOverlay} />
      </Pressable>
    </View>
  );
}

/**
 * Fullscreen viewer for the images and videos of a conversation.
 *
 * Gestures run on react-native-gesture-handler + react-native-reanimated, so
 * dragging, pinching and the double-tap zoom are all resolved on the UI thread
 * and stay smooth while a large image is still decoding.  Pinch and pan are
 * composed as simultaneous gestures, with the double tap racing them, which
 * replaces the hand-rolled two-touch distance maths and tap-timestamp
 * bookkeeping the `PanResponder` version needed.
 *
 * @param props
 */
export default function MediaViewer({ items = [], initialIndex = 0, visible = false, onClose, onDownload, testID = 'media-viewer' }: {
        items?: MediaViewerItem[];
        initialIndex?: number;
        visible?: boolean;
        onClose?: () => void;
        onDownload?: (item: MediaViewerItem) => void;
        testID?: string;
    }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(initialIndex);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  const reduceMotion = useReducedMotion();
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  // The transform the active gesture started from, so a pinch or a pan
  // continues from where the previous one left the media.
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startScale = useSharedValue(1);

  useEffect(() => {
    if (!visible) return;
    setIndex(current => {
      const next = Math.min(Math.max(0, initialIndex), Math.max(0, items.length - 1));
      return current === next ? current : next;
    });
  }, [initialIndex, items.length, visible]);

  const item = items[index] ?? null;

  // Reduced motion still moves the media to where the gesture says it belongs
  // — zoom, bounce-back and re-centring all still happen — but arrives there
  // in one step instead of springing.
  const settle = useCallback(
    (toValue: number) => {
      'worklet';
      return reduceMotion ? toValue : withSpring(toValue, SETTLE_SPRING);
    },
    [reduceMotion],
  );

  const resetTransform = useCallback(() => {
    translateX.value = 0;
    translateY.value = 0;
    scale.value = 1;
  }, [scale, translateX, translateY]);

  const goTo = useCallback(
    (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= items.length) {
        // Bounce back rather than leaving the item half-swiped off-screen.
        translateX.value = settle(0);
        return;
      }
      logVerbose('[Media] viewer moved to item', { index: nextIndex });
      resetTransform();
      setIndex(nextIndex);
      setFailedKey(null);
    },
    [items.length, resetTransform, settle, translateX],
  );

  const handleClose = useCallback(() => {
    resetTransform();
    onClose?.();
  }, [onClose, resetTransform]);

  const toggleZoom = useCallback(() => {
    const next = scale.value > 1 ? 1 : DOUBLE_TAP_SCALE;
    scale.value = settle(next);
    if (next === 1) {
      translateX.value = settle(0);
      translateY.value = settle(0);
    }
  }, [scale, settle, translateX, translateY]);

  // A pinch and a drag can run together; a double tap races them so the zoom
  // toggle is not swallowed by the pan's slop.
  const mediaGesture = useMemo(() => {
    const pinchGesture = Gesture.Pinch()
      .onStart(() => {
        startScale.value = scale.value;
      })
      .onUpdate(event => {
        scale.value = Math.min(MAX_SCALE, Math.max(1, startScale.value * event.scale));
      })
      .onEnd(() => {
        if (scale.value <= 1) {
          // Fully zoomed out, so any pan offset would strand the media off-centre.
          translateX.value = settle(0);
          translateY.value = settle(0);
        }
      });

    const panGesture = Gesture.Pan()
      .minDistance(DRAG_SLOP)
      .onStart(() => {
        startX.value = translateX.value;
        startY.value = translateY.value;
      })
      .onUpdate(event => {
        translateX.value = startX.value + event.translationX;
        translateY.value = startY.value + event.translationY;
      })
      .onEnd(event => {
        const outcome = resolveMediaGesture({
          dx: event.translationX,
          dy: event.translationY,
          scale: scale.value,
          width,
        });

        // Zoomed in, the drag panned the media, so the new offset stands.
        if (outcome === 'pan') return;

        if (outcome === 'dismiss') {
          runOnJS(handleClose)();
          return;
        }
        if (outcome === 'next') {
          runOnJS(goTo)(index + 1);
          return;
        }
        if (outcome === 'previous') {
          runOnJS(goTo)(index - 1);
          return;
        }
        // Too small to mean anything: put the media back where it started.
        translateX.value = settle(startX.value);
        translateY.value = settle(startY.value);
      });

    const doubleTapGesture = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd(() => {
        runOnJS(toggleZoom)();
      });

    return Gesture.Race(doubleTapGesture, Gesture.Simultaneous(pinchGesture, panGesture));
  }, [
    goTo,
    handleClose,
    index,
    scale,
    settle,
    startScale,
    startX,
    startY,
    toggleZoom,
    translateX,
    translateY,
    width,
  ]);

  const animatedMediaStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  useEffect(() => {
    if (visible && item) {
      logInfo('[Media] viewer opened', {
        kind: item.kind,
        mimeType: item.mimeType,
        callActive: isAudioSessionActive(),
      });
    }
  }, [item, visible]);

  if (!visible) return null;

  const VideoComponent = item?.kind === 'video' ? loadVideoComponent() : null;
  const callOwnsAudio = isAudioSessionActive();
  const hasFailed = Boolean(item && failedKey === item.key);

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="fade"
      onRequestClose={handleClose}
      testID={testID}>
      <View style={styles.container}>
        <View style={styles.header}>
          <IconButton
            icon="dismiss"
            size={40}
            onPress={handleClose}
            accessibilityLabel="Close media viewer"
            testID={`${testID}-close`}
          />
          <Text style={styles.title} numberOfLines={1}>
            {item?.name || (item?.kind === 'video' ? 'Video' : 'Photo')}
          </Text>
          {onDownload && item ? (
            <IconButton
              icon="attachmentDownload"
              size={40}
              onPress={() => onDownload(item)}
              accessibilityLabel="Download this media"
              testID={`${testID}-download`}
            />
          ) : (
            <View style={styles.headerSpacer} />
          )}
        </View>

        <MediaViewerContent
          item={item}
          hasFailed={hasFailed}
          VideoComponent={VideoComponent}
          callOwnsAudio={callOwnsAudio}
          mediaGesture={mediaGesture}
          animatedMediaStyle={animatedMediaStyle}
          styles={styles}
          testID={testID}
          onVideoError={(error: unknown) => {
            logWarn('[Media] video playback failed', { error, mimeType: item?.mimeType });
            if (item) setFailedKey(item.key);
          }}
          onImageError={() => {
            logWarn('[Media] image could not be loaded', { mimeType: item?.mimeType });
            if (item) setFailedKey(item.key);
          }}
        />
        <MediaViewerPager
          index={index}
          count={items.length}
          goTo={goTo}
          styles={styles}
          colors={colors}
          testID={testID}
        />
      </View>
    </Modal>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.stageDark,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: spacing.sm,
      gap: spacing.sm,
    },
    headerSpacer: {
      width: 40,
    },
    title: {
      ...typography.label,
      flex: 1,
      color: colors.onOverlay,
      textAlign: 'center',
    },
    mediaWrapper: {
      flex: 1,
    },
    media: {
      flex: 1,
      width: '100%',
    },
    message: {
      ...typography.body,
      color: colors.onOverlay,
      textAlign: 'center',
      padding: spacing.lg,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: spacing.md,
    },
    pageButton: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.sm,
      backgroundColor: colors.surfaceControl,
    },
    pageButtonDisabled: {
      opacity: 0.4,
    },
    counter: {
      ...typography.hint,
      color: colors.onOverlay,
    },
  });
