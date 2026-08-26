import { StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../../ThemeContext';
import { spacing, typography } from '../../theme';
import Icon from './Icon';
import type { ReactNode } from 'react';
import type { ThemeColors } from '../../theme';

export type SectionHeaderProps = {
  title: string;
  /** Semantic `ICONS` key drawn before the title. */
  icon?: string;
  /** Right-aligned content: a count, a link, a filter. */
  accessory?: ReactNode;
  /** `'group'` is the uppercase settings-style label; `'section'` is sentence case. */
  variant?: 'group' | 'section';
  testID?: string;
};

/**
 * Heading that introduces a group of rows.
 *
 * Carries `accessibilityRole="header"` so screen-reader users can jump between
 * groups, which the hand-rolled `<Text style={styles.sectionTitle}>` headings
 * it replaces only did on some screens.
 */
export default function SectionHeader({
  title,
  icon,
  accessory,
  variant = 'group',
  testID,
}: SectionHeaderProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.row} testID={testID}>
      {icon ? <Icon name={icon} size={14} color={colors.onSurfaceVariant} /> : null}
      <Text
        style={variant === 'group' ? styles.groupTitle : styles.sectionTitle}
        accessibilityRole="header">
        {title}
      </Text>
      {accessory ? <View style={styles.accessory}>{accessory}</View> : null}
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
      marginTop: spacing.lg,
      marginBottom: spacing.xs,
    },
    groupTitle: {
      ...typography.groupLabel,
      color: colors.onSurfaceVariant,
      flexShrink: 1,
    },
    sectionTitle: {
      ...typography.sectionTitle,
      color: colors.onSurface,
      flexShrink: 1,
    },
    accessory: {
      marginLeft: 'auto',
    },
  });
