import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatCallDuration } from '../callUx';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { overlay, radius, spacing } from '../theme';
import { ICE_TRANSPORT_POLICIES } from '../webrtcConfig';
import { ICONS, loadVectorIcons } from '../vectorIcons';
import type { ThemeColors } from '../theme';

export type CallTopBarProps = {
  elapsedCallSeconds: number;
  connectionQuality: { bars: number; label: string; };
  /** Remote participant name/id. */
  participantLabel?: string | null;
  /** Active WebRTC ICE transport policy. */
  iceTransportPolicy?: string;
  /** Shows the floating call bubble and returns to the tab shell. */
  onMinimize?: () => void;
};

/**
 * In-call top bar overlay: participant label + timer (left), connection
 * strength indicator and an optional minimize button (right).
 */
export default function CallTopBar({
  elapsedCallSeconds,
  connectionQuality,
  participantLabel = null,
  iceTransportPolicy = ICE_TRANSPORT_POLICIES.ALL,
  onMinimize,
}: CallTopBarProps) {
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
        {iceTransportPolicy === ICE_TRANSPORT_POLICIES.RELAY ? (
          <Text
            style={styles.policyBadge}
            accessibilityLabel="ICE transport policy: TURN relay forced"
            testID="call-ice-policy-badge">
            TURN relay
          </Text>
        ) : null}
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

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    topBar: {
      minHeight: 44,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      backgroundColor: overlay.scrimSoft,
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
      color: colors.onOverlay,
      fontWeight: '600',
      flexShrink: 1,
    },
    timerText: {
      color: colors.onOverlay,
      fontWeight: '700',
    },
    policyBadge: {
      color: colors.onOverlay,
      fontSize: 12,
      fontWeight: '700',
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderRadius: radius.pill,
      backgroundColor: overlay.warningTint,
      overflow: 'hidden',
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
      color: colors.onOverlay,
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
      backgroundColor: overlay.inactiveTrack,
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
