import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../../ThemeContext';
import { fontScaleCaps, radius, sizes, spacing, touchSlop, typography } from '../../theme';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ThemeColors } from '../../theme';

export type SegmentedControlOption<T extends string> = {
  value: T;
  label: string;
  /** Restated in the accessible name, e.g. "Missed, 3". */
  count?: number;
  testID?: string;
};

export type SegmentedControlProps<T extends string> = {
  options: ReadonlyArray<SegmentedControlOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Names the group for assistive technology, e.g. "Filter calls". */
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Material 3 sizes a segmented button at 40dp; `touchSlop` below grows the
 * tappable area back to the 48dp minimum without inflating the visual control.
 */
const SEGMENT_HEIGHT = sizes.control;

/**
 * Mutually exclusive filter, rendered as a radio group.
 *
 * The appearance/ICE-policy pickers in Settings each re-authored this in their
 * own stylesheet; the Calls tab's All/Missed filter is the third caller. The
 * `radiogroup`/`radio` roles (rather than buttons) are what let a screen-reader
 * user hear "2 of 2, selected" instead of an unpositioned list of buttons.
 */
export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  style,
  testID,
}: SegmentedControlProps<T>) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View
      style={[styles.group, style]}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      testID={testID}>
      {options.map(option => {
        const isSelected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityLabel={
              typeof option.count === 'number' ? `${option.label}, ${option.count}` : option.label
            }
            accessibilityState={{ selected: isSelected, checked: isSelected }}
            hitSlop={touchSlop(SEGMENT_HEIGHT)}
            testID={option.testID}
            android_ripple={{ color: isSelected ? colors.rippleOnAccent : colors.ripple }}
            style={({ pressed }) => [
              styles.segment,
              isSelected && styles.segmentSelected,
              pressed && styles.pressed,
            ]}>
            <Text
              style={[styles.label, isSelected && styles.labelSelected]}
              maxFontSizeMultiplier={fontScaleCaps.control}
              numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    group: {
      flexDirection: 'row',
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.outline,
      backgroundColor: colors.surface,
      padding: spacing.xs,
      gap: spacing.xs,
    },
    segment: {
      flex: 1,
      minHeight: SEGMENT_HEIGHT,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.sm,
    },
    segmentSelected: {
      backgroundColor: colors.accentButton,
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
