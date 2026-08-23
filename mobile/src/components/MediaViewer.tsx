import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { logInfo, logVerbose, logWarn } from '../appLogger';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, touchSlop, typography } from '../theme';
import { loadVideoComponent } from '../videoPlayback';
import IconButton from './IconButton';
import type { ThemeColors } from '../theme';

/** Zoom applied by a double tap, and the ceiling for a pinch. */
const DOUBLE_TAP_SCALE = 2.5;
const MAX_SCALE = 4;
/** Two taps closer together than this (ms) count as a double tap. */
const DOUBLE_TAP_MS = 280;
/** Movement (dp) that turns a tap into a drag. */
const DRAG_SLOP = 8;
/** Fraction of the screen width a swipe must cover to change media item. */
const PAGE_THRESHOLD = 0.25;
/** Downward drag (dp) that dismisses the viewer. */
const DISMISS_DY = 120;

/**
 * What a completed drag on the media surface means.
 *
 * Kept as a pure function so the decision thresholds are testable without
 * synthesising `PanResponder` touch histories.
 *
 * @param gesture the completed drag, plus the current zoom and screen width.
 */
export function resolveMediaGesture({ dx = 0, dy = 0, scale = 1, width = 0 }: {
        dx?: number; dy?: number; scale?: number; width?: number;
    }): 'tap' | 'pan' | 'next' | 'previous' | 'dismiss' | 'none' {
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

/**
 * Fullscreen viewer for the images and videos of a conversation.
 *
 * Gestures are built on the core `PanResponder`/`Animated` APIs — the same
 * reasoning as `SwipeableRow`: no extra gesture dependency, and the behaviour
 * stays drivable from tests.
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
  const styles = useThemedStyles(createStyles);
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const scaleRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const pinchStartRef = useRef(0);
  const lastTapRef = useRef(0);

  useEffect(() => {
    if (!visible) return;
    setIndex(current => {
      const next = Math.min(Math.max(0, initialIndex), Math.max(0, items.length - 1));
      return current === next ? current : next;
    });
  }, [initialIndex, items.length, visible]);

  const item = items[index] ?? null;

  const resetTransform = useCallback(() => {
    scaleRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setScale(1);
    translateX.setValue(0);
    translateY.setValue(0);
  }, [translateX, translateY]);

  const goTo = useCallback(
    (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= items.length) {
        // Bounce back rather than leaving the item half-swiped off-screen.
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
        return;
      }
      logVerbose('[Media] viewer moved to item', { index: nextIndex });
      resetTransform();
      setIndex(nextIndex);
      setFailedKey(null);
    },
    [items.length, resetTransform, translateX],
  );

  const handleClose = useCallback(() => {
    resetTransform();
    onClose?.();
  }, [onClose, resetTransform]);

  const toggleZoom = useCallback(() => {
    const next = scaleRef.current > 1 ? 1 : DOUBLE_TAP_SCALE;
    scaleRef.current = next;
    setScale(next);
    if (next === 1) {
      panRef.current = { x: 0, y: 0 };
      translateX.setValue(0);
      translateY.setValue(0);
    }
  }, [translateX, translateY]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (event, gesture) =>
          event.nativeEvent.touches?.length === 2 ||
          Math.abs(gesture.dx) > DRAG_SLOP ||
          Math.abs(gesture.dy) > DRAG_SLOP,
        onPanResponderGrant: () => {
          pinchStartRef.current = 0;
        },
        onPanResponderMove: (event, gesture) => {
          const touches = event.nativeEvent.touches ?? [];
          if (touches.length === 2) {
            const [first, second] = touches;
            const distance = Math.hypot(
              (first.pageX ?? 0) - (second.pageX ?? 0),
              (first.pageY ?? 0) - (second.pageY ?? 0),
            );
            if (!pinchStartRef.current) {
              pinchStartRef.current = distance || 1;
              return;
            }
            const next = Math.min(
              MAX_SCALE,
              Math.max(1, (scaleRef.current * distance) / pinchStartRef.current),
            );
            setScale(next);
            return;
          }
          translateX.setValue(panRef.current.x + gesture.dx);
          translateY.setValue(panRef.current.y + gesture.dy);
        },
        onPanResponderRelease: (event, gesture) => {
          if (pinchStartRef.current) {
            // A pinch just ended: keep the scale it settled at.
            scaleRef.current = Math.min(MAX_SCALE, Math.max(1, scale));
            pinchStartRef.current = 0;
            return;
          }

          const outcome = resolveMediaGesture({
            dx: gesture.dx,
            dy: gesture.dy,
            scale: scaleRef.current,
            width,
          });

          if (outcome === 'tap') {
            const now = Date.now();
            if (now - lastTapRef.current < DOUBLE_TAP_MS) {
              lastTapRef.current = 0;
              toggleZoom();
            } else {
              lastTapRef.current = now;
            }
            translateX.setValue(panRef.current.x);
            translateY.setValue(panRef.current.y);
            return;
          }

          if (outcome === 'pan') {
            panRef.current = {
              x: panRef.current.x + gesture.dx,
              y: panRef.current.y + gesture.dy,
            };
            return;
          }

          if (outcome === 'dismiss') {
            handleClose();
            return;
          }

          if (outcome === 'next') {
            goTo(index + 1);
            return;
          }
          if (outcome === 'previous') {
            goTo(index - 1);
            return;
          }
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
        },
        onPanResponderTerminate: () => {
          translateX.setValue(panRef.current.x);
          translateY.setValue(panRef.current.y);
        },
      }),
    [goTo, handleClose, index, scale, toggleZoom, translateX, translateY, width],
  );

  useEffect(() => {
    if (visible && item) {
      logInfo('[Media] viewer opened', { kind: item.kind, mimeType: item.mimeType });
    }
  }, [item, visible]);

  if (!visible) return null;

  const VideoComponent = item?.kind === 'video' ? loadVideoComponent() : null;
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

        {!item ? (
          <Text style={styles.message} testID={`${testID}-empty`}>
            This media is no longer available
          </Text>
        ) : hasFailed ? (
          <Text style={styles.message} testID={`${testID}-error`}>
            This file could not be loaded. It may have been removed from storage.
          </Text>
        ) : item.kind === 'video' ? (
          VideoComponent ? (
            <VideoComponent
              source={{ uri: item.url }}
              style={styles.media}
              controls
              paused={false}
              resizeMode="contain"
              onError={(error: unknown) => {
                logWarn('[Media] video playback failed', { error, mimeType: item.mimeType });
                setFailedKey(item.key);
              }}
              testID={`${testID}-video`}
            />
          ) : (
            <Text style={styles.message} testID={`${testID}-video-unavailable`}>
              Video playback isn't available on this build — download the file to watch it
            </Text>
          )
        ) : (
          <Animated.View
            style={[
              styles.mediaWrapper,
              { transform: [{ translateX }, { translateY }, { scale }] },
            ]}
            {...panResponder.panHandlers}>
            <Image
              source={{ uri: item.url }}
              style={styles.media}
              resizeMode="contain"
              accessibilityLabel={item.name || 'Photo'}
              onError={() => {
                logWarn('[Media] image could not be loaded', { mimeType: item.mimeType });
                setFailedKey(item.key);
              }}
              testID={`${testID}-image`}
            />
          </Animated.View>
        )}

        {items.length > 1 ? (
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
              <Text style={styles.pageButtonText}>‹</Text>
            </Pressable>
            <Text style={styles.counter} testID={`${testID}-counter`}>
              {`${index + 1} / ${items.length}`}
            </Text>
            <Pressable
              onPress={() => goTo(index + 1)}
              disabled={index === items.length - 1}
              accessibilityRole="button"
              accessibilityLabel="Next media"
              accessibilityState={{ disabled: index === items.length - 1 }}
              hitSlop={touchSlop(24)}
              style={[styles.pageButton, index === items.length - 1 && styles.pageButtonDisabled]}
              testID={`${testID}-next`}>
              <Text style={styles.pageButtonText}>›</Text>
            </Pressable>
          </View>
        ) : null}
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
    pageButtonText: {
      ...typography.title,
      color: colors.textPrimary,
    },
    counter: {
      ...typography.hint,
      color: colors.onOverlay,
    },
  });
