import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatCallDuration } from '../callUx';
import {
  describeCallSecurityBadge,
  describeCallSecurityGuidance,
  formatSasWords,
} from '../call/sas';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { fontScaleCaps, overlay, radius, spacing } from '../theme';
import { ICE_TRANSPORT_POLICIES } from '../webrtcConfig';
import { ICONS, loadVectorIcons } from '../vectorIcons';
import type { CallSecurityState } from '../call/sas';
import type { ThemeColors } from '../theme';

export type CallTopBarProps = {
  elapsedCallSeconds: number;
  connectionQuality: { bars: number; label: string; };
  /** Remote participant name/id. */
  participantLabel?: string | null;
  /** Active WebRTC ICE transport policy. */
  iceTransportPolicy?: string;
  /** Verification state of the call's DTLS keys; omitted outside a call. */
  callSecurity?: CallSecurityState | null;
  /** Records that the user compared the code aloud and it matched. */
  onConfirmCallSecurity?: () => void;
  /** Shows the floating call bubble and returns to the tab shell. */
  onMinimize?: () => void;
};

/**
 * The panel the verification badge opens: the four words, what they mean, and
 * — when there is something to confirm — the confirmation itself.
 *
 * A call whose fingerprints could not be read shows no words and offers no
 * confirmation: there is nothing to compare, and a button that recorded a
 * verification anyway would be a lie the app then repeats on the peer's
 * profile.
 */
function CallSecurityPanel({
  callSecurity,
  onConfirm,
  styles,
}: {
  callSecurity: CallSecurityState;
  onConfirm?: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  const words = callSecurity.words;
  const canConfirm = Boolean(words && onConfirm && callSecurity.status !== 'verified');
  return (
    <View style={styles.securityPanel} testID="call-security-panel">
      {words ? (
        <Text
          style={styles.securityWords}
          maxFontSizeMultiplier={fontScaleCaps.control}
          accessibilityLabel={`Call verification code: ${words.join(', ')}`}
          testID="call-security-words">
          {formatSasWords(words)}
        </Text>
      ) : null}
      <Text style={styles.securityGuidance} testID="call-security-guidance">
        {describeCallSecurityGuidance(callSecurity.status)}
      </Text>
      {canConfirm ? (
        <Pressable
          onPress={onConfirm}
          accessibilityRole="button"
          accessibilityLabel="Confirm the verification code matches"
          accessibilityHint="Remembers this person's call encryption keys as verified"
          testID="call-security-confirm"
          style={styles.securityConfirm}>
          <Text style={styles.securityConfirmText} maxFontSizeMultiplier={fontScaleCaps.control}>
            The words match
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * In-call top bar overlay: participant label + timer (left), connection
 * strength indicator and an optional minimize button (right).
 */
export default function CallTopBar({
  elapsedCallSeconds,
  connectionQuality,
  participantLabel = null,
  iceTransportPolicy = ICE_TRANSPORT_POLICIES.ALL,
  callSecurity = null,
  onConfirmCallSecurity,
  onMinimize,
}: CallTopBarProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const MCIcon = loadVectorIcons();
  const minimizeIconDef = ICONS.minimize;

  const [isSecurityPanelOpen, setIsSecurityPanelOpen] = useState(false);
  const toggleSecurityPanel = useCallback(() => {
    setIsSecurityPanelOpen(open => !open);
  }, []);
  const handleConfirmCallSecurity = useCallback(() => {
    onConfirmCallSecurity?.();
  }, [onConfirmCallSecurity]);
  const securityStatus = callSecurity?.status ?? null;

  return (
    <>
      <View style={styles.topBar} accessibilityRole="header">
        <View style={styles.leftGroup}>
          {participantLabel ? (
            <Text style={styles.participantLabel} numberOfLines={1}>
              {participantLabel}
            </Text>
          ) : null}
          {/* Capped: the whole call chrome hangs off `CallScreen`'s
              `StyleSheet.absoluteFill` overlay, so this row is exactly as wide as
              the screen and nothing in it can push anything anywhere. The timer
              is the only fixed-width thing here; the participant label beside it
              is the one element that shrinks, so an uncapped `mm:ss` at 200%
              takes its width and leaves the name as an ellipsis. */}
          <Text
            style={styles.timerText}
            maxFontSizeMultiplier={fontScaleCaps.control}
            accessibilityLabel={`Call duration ${formatCallDuration(elapsedCallSeconds)}`}>
            {formatCallDuration(elapsedCallSeconds)}
          </Text>
        </View>
        <View style={styles.rightGroup}>
          {securityStatus ? (
            // Capped for the same reason as the policy badge below: it shares the
            // right-hand group, and every point it widens comes off the
            // participant's name.
            <Pressable
              onPress={toggleSecurityPanel}
              accessibilityRole="button"
              accessibilityState={{ expanded: isSecurityPanelOpen }}
              accessibilityLabel={`Call verification: ${describeCallSecurityBadge(securityStatus)}`}
              accessibilityHint="Shows the code to read aloud to the other person"
              testID="call-security-badge">
              <Text
                style={[
                  styles.securityBadge,
                  securityStatus === 'verified' && styles.securityBadgeVerified,
                  securityStatus === 'changed' && styles.securityBadgeChanged,
                ]}
                maxFontSizeMultiplier={fontScaleCaps.control}>
                {describeCallSecurityBadge(securityStatus)}
              </Text>
            </Pressable>
          ) : null}
          {iceTransportPolicy === ICE_TRANSPORT_POLICIES.RELAY ? (
            // Capped: a pill drawn with `overflow: 'hidden'` so its radius clips
            // on Android — which means it clips its own text too. It is a
            // two-word diagnostic label in the right-hand group of a row that
            // also has to hold the signal bars and the minimize button, so every
            // point it widens comes off the participant's name.
            <Text
              style={styles.policyBadge}
              maxFontSizeMultiplier={fontScaleCaps.control}
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
                // Capped: the font-not-linked fallback glyph, drawn inside a
                // circle whose 28 dp diameter and 14 dp radius are literal dp —
                // a circle cannot grow and stay a circle, so at 200% a 16 pt
                // chevron is simply clipped by its own button.
                <Text style={styles.minimizeIconText} maxFontSizeMultiplier={fontScaleCaps.badge}>
                  {minimizeIconDef?.emoji ?? '⌄'}
                </Text>
              )}
            </Pressable>
          ) : null}
        </View>
      </View>
      {callSecurity && isSecurityPanelOpen ? (
        <CallSecurityPanel
          callSecurity={callSecurity}
          onConfirm={onConfirmCallSecurity ? handleConfirmCallSecurity : undefined}
          styles={styles}
        />
      ) : null}
    </>
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
    securityBadge: {
      color: colors.onOverlay,
      fontSize: 12,
      fontWeight: '700',
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderRadius: radius.pill,
      backgroundColor: overlay.scrimMedium,
      overflow: 'hidden',
    },
    securityBadgeVerified: {
      backgroundColor: colors.success,
      color: colors.textOnAccent,
    },
    securityBadgeChanged: {
      backgroundColor: colors.danger,
      color: colors.textOnAccent,
    },
    securityPanel: {
      marginTop: spacing.xs,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: overlay.scrimStrong,
      gap: spacing.xs,
    },
    securityWords: {
      color: colors.onOverlay,
      fontSize: 20,
      fontWeight: '700',
      letterSpacing: 0.5,
    },
    securityGuidance: {
      color: colors.onOverlay,
      fontSize: 13,
    },
    securityConfirm: {
      alignSelf: 'flex-start',
      marginTop: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    securityConfirmText: {
      color: colors.textOnAccent,
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
