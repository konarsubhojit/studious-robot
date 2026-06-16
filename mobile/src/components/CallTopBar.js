import { StyleSheet, Text, View } from 'react-native';
import { formatCallDuration } from '../callUx';
import { colors, radius, spacing } from '../theme';

/**
 * In-call top bar: call duration, an optional participant/room label, and a
 * three-bar connection-quality indicator.
 *
 * @param {object} props
 * @param {number} props.elapsedCallSeconds
 * @param {{ bars: number, label: string }} props.connectionQuality
 * @param {string} [props.participantLabel]
 */
export default function CallTopBar({ elapsedCallSeconds, connectionQuality, participantLabel }) {
  return (
    <View style={styles.topBar} accessibilityRole="header">
      <View style={styles.left}>
        <Text style={styles.timerText} accessibilityLabel={`Call duration ${formatCallDuration(elapsedCallSeconds)}`}>
          {formatCallDuration(elapsedCallSeconds)}
        </Text>
        {participantLabel ? (
          <Text style={styles.participantText} numberOfLines={1}>
            {participantLabel}
          </Text>
        ) : null}
      </View>
      <View
        style={styles.qualityContainer}
        accessibilityLabel={`Connection quality: ${connectionQuality.label}`}
      >
        <Text style={styles.qualityLabel}>{connectionQuality.label}</Text>
        <View style={styles.signalBars}>
          {[0, 1, 2].map((barIndex) => (
            <View
              key={barIndex}
              style={[
                styles.signalBar,
                styles[`signalBar${barIndex}`],
                barIndex <= connectionQuality.bars - 1 && styles.signalBarActive,
              ]}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    minHeight: 40,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.surfaceControl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
  },
  timerText: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  participantText: {
    color: colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  qualityContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  qualityLabel: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  signalBars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
  },
  signalBar: {
    width: 6,
    borderRadius: 4,
    backgroundColor: colors.borderInactiveBar,
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
