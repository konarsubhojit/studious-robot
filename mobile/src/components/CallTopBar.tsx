import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatCallDuration } from '../callUx';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, spacing } from '../theme';
import { ICONS, loadVectorIcons } from '../vectorIcons';

/**
 * In-call top bar overlay: participant label + timer (left), connection
 * strength indicator and an optional minimize button (right).
 *
 * @param {object} props
 * @param {number} props.elapsedCallSeconds
 * @param {{ bars: number, label: string }} props.connectionQuality
 * @param {string|null} [props.participantLabel] - Remote participant name/id.
 * @param {() => void} [props.onMinimize] - Shows the floating call bubble and returns to the tab shell.
 */
export default function CallTopBar({
  elapsedCallSeconds,
  connectionQuality,
  participantLabel = null,
  onMinimize,
}: { elapsedCallSeconds: number; connectionQuality: { bars: number; label: string; }; participantLabel?: string | null; onMinimize?: () => void; }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const MCIcon = loadVectorIcons();
  const minimizeIconDef = ICONS.minimize;

  return (
    <View style={styles.topBar} accessibilityRole="header">
      <View style={styles.leftGroup}>
        {participantLabel ? (
          <Text style={styles.participantLabel} numberOfLines={1}>
            {participantLabel}
          </Text>
        ) : null}
        <Text
          style={styles.timerText}
          accessibilityLabel={`Call duration ${formatCallDuration(elapsedCallSeconds)}`}>
          {formatCallDuration(elapsedCallSeconds)}
        </Text>
      </View>
      <View style={styles.rightGroup}>
        <View
          style={styles.qualityContainer}
          accessibilityLabel={`Connection quality: ${connectionQuality.label}`}>
          <View style={styles.signalBars}>
            {[0, 1, 2].map(barIndex => (
              <View
                key={barIndex}
                style={[
                  styles.signalBar,
                  [styles.signalBar0, styles.signalBar1, styles.signalBar2][barIndex],
                  barIndex <= connectionQuality.bars - 1 && styles.signalBarActive,
                ]}
              />
            ))}
          </View>
        </View>
        {onMinimize ? (
          <Pressable
            onPress={onMinimize}
            accessibilityRole="button"
            accessibilityLabel="Minimize call"
            testID="call-minimize"
            style={styles.minimizeButton}>
            {minimizeIconDef && MCIcon ? (
              <MCIcon name={minimizeIconDef.icon} size={18} color={colors.textPrimary} />
            ) : (
              <Text style={styles.minimizeIconText}>{minimizeIconDef?.emoji ?? '⌄'}</Text>
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** @param {import('../theme').ThemeColors} colors */
const createStyles = (colors: import('../theme').ThemeColors) =>
  StyleSheet.create({
    topBar: {
      minHeight: 44,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    leftGroup: {
      flexShrink: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    rightGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    participantLabel: {
      color: '#fff',
      fontWeight: '600',
      flexShrink: 1,
    },
    timerText: {
      color: '#fff',
      fontWeight: '700',
    },
    qualityContainer: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    minimizeButton: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    minimizeIconText: {
      color: colors.textPrimary,
      fontSize: 16,
    },
    signalBars: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 3,
    },
    signalBar: {
      width: 6,
      borderRadius: 4,
      backgroundColor: 'rgba(255, 255, 255, 0.35)',
    },
    signalBar0: {
      height: 8,
    },
    signalBar1: {
      height: 12,
    },
    signalBar2: {
      height: 16,
    },
    signalBarActive: {
      backgroundColor: colors.success,
    },
  });
