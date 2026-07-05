import { StyleSheet, Text, View } from 'react-native';
import { formatCallDuration } from '../callUx';
import { colors, radius, spacing } from '../theme';

/**
 * In-call top bar overlay: timer (left) and connection-strength indicator (right).
 *
 * @param {object} props
 * @param {number} props.elapsedCallSeconds
 * @param {{ bars: number, label: string }} props.connectionQuality
 */
export default function CallTopBar({ elapsedCallSeconds, connectionQuality }) {
  return (
    <View style={styles.topBar} accessibilityRole="header">
      <Text style={styles.timerText} accessibilityLabel={`Call duration ${formatCallDuration(elapsedCallSeconds)}`}>
        {formatCallDuration(elapsedCallSeconds)}
      </Text>
      <View
        style={styles.qualityContainer}
        accessibilityLabel={`Connection quality: ${connectionQuality.label}`}
      >
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
    minHeight: 44,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  timerText: {
    color: '#fff',
    fontWeight: '700',
  },
  qualityContainer: {
    flexDirection: 'row',
    alignItems: 'center',
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
