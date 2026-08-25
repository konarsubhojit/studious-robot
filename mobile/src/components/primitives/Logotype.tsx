import { StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../../ThemeContext';
import { radius, spacing, typography } from '../../theme';
import type { ThemeColors } from '../../theme';

export type LogotypeProps = {
  /** Overall height of the mark, in dp. The wordmark scales with it. */
  size?: number;
  /** Hides the wordmark, leaving just the glyph (for a compact header). */
  markOnly?: boolean;
  testID?: string;
};

/** Default mark height. */
const DEFAULT_SIZE = 64;

/**
 * The WeTalk app mark: a drawn speech-bubble glyph plus the wordmark.
 *
 * Registration and the splash previously showed a 📞 emoji in a circle. An
 * emoji is not a logo — it renders as a different picture on every OS version,
 * ignores the palette, and told the user this was a dialler rather than a
 * personal communicator. The mark is drawn from palette tokens instead, so it
 * inverts correctly between the light and dark schemes.
 *
 * One accessible element ("WeTalk"): the glyph and the wordmark are one thing.
 */
export default function Logotype({ size = DEFAULT_SIZE, markOnly = false, testID }: LogotypeProps) {
  const styles = useThemedStyles(createStyles);
  const tailSize = Math.round(size * 0.22);

  return (
    <View
      style={styles.root}
      accessibilityRole="image"
      accessibilityLabel="WeTalk"
      testID={testID ?? 'app-logotype'}>
      <View
        style={[
          styles.bubble,
          { height: size, width: size, borderRadius: Math.round(size * 0.32) },
        ]}>
        {/* Two stacked strokes read as lines of a message inside the bubble. */}
        <View
          style={[
            styles.stroke,
            { width: Math.round(size * 0.46), height: Math.max(2, Math.round(size * 0.07)) },
          ]}
        />
        <View
          style={[
            styles.stroke,
            { width: Math.round(size * 0.3), height: Math.max(2, Math.round(size * 0.07)) },
          ]}
        />
        {/* The bubble's tail, rotated into the bottom-left corner. */}
        <View
          style={[
            styles.tail,
            {
              height: tailSize,
              width: tailSize,
              bottom: -Math.round(tailSize * 0.35),
              left: Math.round(size * 0.18),
            },
          ]}
        />
      </View>
      {markOnly ? null : <Text style={styles.wordmark}>WeTalk</Text>}
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: {
      alignItems: 'center',
      gap: spacing.md,
    },
    bubble: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs + 1,
      backgroundColor: colors.accentButton,
      borderRadius: radius.lg,
    },
    stroke: {
      borderRadius: radius.pill,
      backgroundColor: colors.textOnAccent,
    },
    tail: {
      position: 'absolute',
      backgroundColor: colors.accentButton,
      borderBottomLeftRadius: radius.sm,
      transform: [{ rotate: '45deg' }],
    },
    wordmark: {
      ...typography.display,
      color: colors.onSurface,
      letterSpacing: 0.5,
    },
  });
