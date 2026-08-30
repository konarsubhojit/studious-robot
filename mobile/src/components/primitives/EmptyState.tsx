import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../../ThemeContext';
import { sizes, spacing, typography } from '../../theme';
import AppButton from '../AppButton';
import Icon from './Icon';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ThemeColors } from '../../theme';

export type EmptyStateProps = {
  /** Semantic `ICONS` key drawn above the title. */
  icon?: string;
  title: string;
  description?: string;
  /** Primary next action; an empty state without one is a dead end. */
  actionLabel?: string;
  onAction?: () => void;
  actionHint?: string;
  /**
   * Low-emphasis secondary route out, rendered as a text link rather than a
   * filled button so it never competes with a screen's primary action (a FAB,
   * or `actionLabel` above).
   */
  linkLabel?: string;
  onLinkPress?: () => void;
  linkHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Diameter of the icon medallion. */
const MEDALLION_SIZE = 72;

/**
 * "Nothing here yet" placeholder with a way out.
 *
 * Distinct from `ErrorState`: an empty state is a *correct* result (no
 * conversations yet, no missed calls), so it reads calmly and offers the action
 * that would populate the list. `ErrorState` is for a failure and offers a
 * retry. The chat list's bare "No messages yet" line was neither.
 */
export default function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  actionHint,
  linkLabel,
  onLinkPress,
  linkHint,
  style,
  testID,
}: EmptyStateProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={[styles.root, style]} testID={testID}>
      {icon ? (
        <View style={styles.medallion}>
          <Icon name={icon} size={32} color={colors.onSurfaceVariant} />
        </View>
      ) : null}
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
      {actionLabel && onAction ? (
        <AppButton
          title={actionLabel}
          onPress={onAction}
          accessibilityHint={actionHint}
          style={styles.action}
          testID={testID ? `${testID}-action` : undefined}
        />
      ) : null}
      {linkLabel && onLinkPress ? (
        <Pressable
          onPress={onLinkPress}
          accessibilityRole="button"
          accessibilityLabel={linkLabel}
          accessibilityHint={linkHint}
          style={styles.link}
          testID={testID ? `${testID}-link` : undefined}>
          <Text style={styles.linkText}>{linkLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing['3xl'],
    },
    medallion: {
      height: MEDALLION_SIZE,
      width: MEDALLION_SIZE,
      borderRadius: MEDALLION_SIZE / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceControl,
      marginBottom: spacing.xs,
    },
    title: {
      ...typography.headline,
      color: colors.onSurface,
      textAlign: 'center',
    },
    description: {
      ...typography.body,
      color: colors.onSurfaceVariant,
      textAlign: 'center',
    },
    action: {
      flex: 0,
      minWidth: sizes.minTouchTarget * 3,
      marginTop: spacing.sm,
    },
    link: {
      minHeight: sizes.minTouchTarget,
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
    },
    linkText: {
      ...typography.label,
      color: colors.accent,
      textAlign: 'center',
    },
  });
