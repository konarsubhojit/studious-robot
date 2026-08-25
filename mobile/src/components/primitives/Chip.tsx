import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../../ThemeContext';
import { fontScaleCaps, radius, spacing, touchSlop, typography } from '../../theme';
import Icon from './Icon';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ThemeColors } from '../../theme';

export type ChipProps = {
  label: string;
  /** Semantic `ICONS` key drawn before the label. */
  icon?: string;
  selected?: boolean;
  onPress?: () => void;
  /** `'reaction'` renders the compact, emoji-bearing variant. */
  variant?: 'filter' | 'reaction';
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Height that keeps a chip tappable without inflating the design. */
const CHIP_HEIGHT = 32;

/**
 * Small pill: a reaction count, an attachment type, a quick filter.
 *
 * Reaction chips in the conversation and the attach sheet's type pills were two
 * separate implementations of the same shape. A chip that toggles reports
 * `checked` so its state is announced, rather than relying on the fill colour.
 */
export default function Chip({
  label,
  icon,
  selected = false,
  onPress,
  variant = 'filter',
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: ChipProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const body = (
    <>
      {icon ? (
        <Icon
          name={icon}
          size={14}
          color={selected ? colors.textOnAccent : colors.onSurfaceVariant}
        />
      ) : null}
      <Text
        style={[styles.label, selected && styles.labelSelected]}
        maxFontSizeMultiplier={fontScaleCaps.control}
        numberOfLines={1}>
        {label}
      </Text>
    </>
  );

  const chipStyle = [
    styles.chip,
    variant === 'reaction' && styles.chipReaction,
    selected && styles.chipSelected,
    style,
  ];

  if (!onPress) {
    return (
      <View style={chipStyle} testID={testID}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected, checked: selected }}
      hitSlop={touchSlop(CHIP_HEIGHT)}
      style={({ pressed }) => [...chipStyle, pressed && styles.pressed]}
      testID={testID}>
      {body}
    </Pressable>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    chip: {
      minHeight: CHIP_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.outline,
      backgroundColor: colors.surface,
    },
    chipReaction: {
      minHeight: 26,
      paddingHorizontal: spacing.sm,
    },
    chipSelected: {
      backgroundColor: colors.accentButton,
      borderColor: colors.accentButton,
    },
    label: {
      ...typography.label,
      color: colors.onSurfaceVariant,
    },
    labelSelected: {
      color: colors.textOnAccent,
      fontWeight: '700',
    },
    pressed: {
      opacity: 0.78,
    },
  });
