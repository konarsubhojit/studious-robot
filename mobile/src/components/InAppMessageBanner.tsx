import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Linking, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { logWarn } from '../appLogger';
import { errorMessage } from '../errors';
import {
  dismissInAppMessageNotification,
  getInAppMessageNotificationSnapshot,
  subscribeInAppMessageNotifications,
} from '../inAppMessageNotifications';
import { useThemedStyles } from '../ThemeContext';
import { fontScaleCaps, spacing, typography } from '../theme';
import IconButton from './IconButton';
import type { ThemeColors } from '../theme';

const AUTO_DISMISS_MS = 5000;
const SWIPE_DISMISS_DISTANCE = 48;

export default function InAppMessageBanner() {
  const notification = useSyncExternalStore(
    subscribeInAppMessageNotifications,
    getInAppMessageNotificationSnapshot,
    getInAppMessageNotificationSnapshot,
  );
  const styles = useThemedStyles(createStyles);
  const notificationRef = useRef(notification);
  notificationRef.current = notification;

  useEffect(() => {
    if (!notification) return undefined;
    const timeout = setTimeout(() => {
      dismissInAppMessageNotification(notification.messageId);
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timeout);
  }, [notification]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dx) > 12 || Math.abs(gesture.dy) > 12,
        onPanResponderRelease: (_, gesture) => {
          if (
            Math.abs(gesture.dx) >= SWIPE_DISMISS_DISTANCE ||
            Math.abs(gesture.dy) >= SWIPE_DISMISS_DISTANCE
          ) {
            dismissInAppMessageNotification(notificationRef.current?.messageId);
          }
        },
      }),
    [],
  );

  if (!notification) return null;

  const accessibilityLabel = `${notification.title}. ${notification.body}`;
  const dismiss = () => dismissInAppMessageNotification(notification.messageId);
  const openConversation = () => {
    dismiss();
    Promise.resolve(Linking.openURL(notification.deepLink)).catch(error => {
      logWarn('[InAppMessageBanner] open deep link failed', { message: errorMessage(error) });
    });
  };

  return (
    <View style={styles.safeArea} pointerEvents="box-none">
      <Pressable
        {...panResponder.panHandlers}
        onPress={openConversation}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint="Opens this conversation"
        accessibilityActions={[{ name: 'dismiss', label: 'Dismiss notification' }]}
        onAccessibilityAction={event => {
          if (event.nativeEvent.actionName === 'dismiss') dismiss();
        }}
        testID="in-app-message-banner"
        style={({ pressed }) => [styles.banner, pressed && styles.pressed]}>
        <View style={styles.copy}>
          <Text style={styles.title} numberOfLines={1} maxFontSizeMultiplier={fontScaleCaps.body}>
            {notification.title}
          </Text>
          <Text style={styles.body} numberOfLines={2} maxFontSizeMultiplier={fontScaleCaps.body}>
            {notification.body}
          </Text>
        </View>
        <IconButton
          icon="close"
          size={32}
          onPress={dismiss}
          accessibilityLabel="Dismiss message notification"
          testID="in-app-message-banner-dismiss"
        />
      </Pressable>
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    safeArea: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      backgroundColor: colors.background,
    },
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: 18,
      backgroundColor: colors.surfaceElevated,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      shadowColor: colors.shadow,
      shadowOpacity: 0.2,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 4,
    },
    pressed: {
      opacity: 0.9,
    },
    copy: {
      flex: 1,
      gap: spacing.xxs,
    },
    title: {
      ...typography.body,
      color: colors.textPrimary,
      fontWeight: '700',
    },
    body: {
      ...typography.caption,
      color: colors.textSecondary,
    },
  });
