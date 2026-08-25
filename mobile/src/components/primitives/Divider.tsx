import { StyleSheet, View } from 'react-native';
import { useThemedStyles } from '../../ThemeContext';
import { spacing } from '../../theme';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ThemeColors } from '../../theme';

export type DividerProps = {
  /** Indents the rule to start under a row's text, not under its avatar. */
  inset?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Hairline rule between rows of a group.
 *
 * A divider carries no information a screen reader can use — grouping is
 * conveyed by the `SectionHeader` above it — so it is hidden from the
 * accessibility tree rather than announced as an empty element.
 */
export default function Divider({ inset = 0, style, testID }: DividerProps) {
  const styles = useThemedStyles(createStyles);

  return (
    <View
      style={[styles.divider, inset > 0 && { marginLeft: inset }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no"
      testID={testID}
    />
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.outlineVariant,
      marginVertical: spacing.xs,
    },
  });
