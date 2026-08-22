// @ts-check
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { deriveInitials, formatRingCountdown } from '../callUx';
import { useThemedStyles } from '../ThemeContext';
import { spacing } from '../theme';
import IconButton from './IconButton';
import StatusBanner from './StatusBanner';

/**
 * Derives the number of seconds until ringTimeoutAt (clamped to ≥ 0).
 *
 * @param {string|null|undefined} ringTimeoutAt – ISO 8601 timestamp from the call record.
 * @returns {number}
 */
function secondsRemaining(ringTimeoutAt) {
  if (!ringTimeoutAt) return 0;
  return Math.max(0, Math.round((new Date(ringTimeoutAt).getTime() - Date.now()) / 1000));
}

/**
 * Outgoing ringing screen.
 *
 * Shown while the caller waits for the callee to answer.  Displays a
 * pulsing callee avatar, a countdown, and an icon-only Cancel button.
 *
 * Purely presentational – all behaviour is supplied via props.
 *
 * @param {object} props
 * @param {string} props.calleeId - The ID / name of the callee.
 * @param {import('../../../shared/signaling/schemas').CallRecord | null} [props.activeCall]
 *   Live call record (may include ringTimeoutAt).
 * @param {import('./StatusBanner').CallStatus} props.status - Current status.
 * @param {() => void} props.onCancel - Called when the user presses Cancel.
 */
export default function OutgoingCallScreen({ calleeId, activeCall, status, onCancel }) {
  const styles = useThemedStyles(createStyles);

  const ringTimeoutAt = activeCall?.ringTimeoutAt ?? null;
  const initials = deriveInitials(calleeId);

  const [secondsLeft, setSecondsLeft] = useState(() => secondsRemaining(ringTimeoutAt));
  /** @type {import('react').MutableRefObject<ReturnType<typeof setInterval> | null>} */
  const intervalRef = useRef(null);

  // ── Pulse animation ───────────────────────────────────────────────────────
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.2,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  // ── Countdown timer ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!ringTimeoutAt) {
      setSecondsLeft(0);
      return undefined;
    }

    setSecondsLeft(secondsRemaining(ringTimeoutAt));

    intervalRef.current = setInterval(() => {
      const remaining = secondsRemaining(ringTimeoutAt);
      setSecondsLeft(remaining);
      if (remaining <= 0 && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [ringTimeoutAt]);

  return (
    <View style={styles.container} testID="outgoing-call-screen">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.headerLabel} accessibilityRole="header">
          Calling…
        </Text>
      </View>

      {/* ── Callee info ───────────────────────────────────────────────────── */}
      <View style={styles.calleeSection}>
        {/* Pulsing ring behind avatar */}
        <Animated.View
          style={[styles.pulseRing, { transform: [{ scale: pulseAnim }] }]}
          accessible={false}
        />
        <View
          style={styles.avatar}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants">
          <Text style={styles.avatarText}>{initials}</Text>
        </View>

        <Text
          style={styles.calleeId}
          accessibilityLabel={`Calling ${calleeId || 'unknown contact'}`}
          testID="outgoing-callee-id">
          {calleeId || 'Unknown'}
        </Text>

        {ringTimeoutAt ? (
          <Text
            style={styles.countdown}
            accessibilityLabel={
              secondsLeft > 0
                ? `Rings for ${formatRingCountdown(secondsLeft)}`
                : 'The call timed out'
            }
            testID="outgoing-countdown">
            {secondsLeft > 0 ? formatRingCountdown(secondsLeft) : 'Timed out'}
          </Text>
        ) : null}
      </View>

      {/* ── Action button ─────────────────────────────────────────────────── */}
      <View style={styles.actions}>
        <IconButton
          icon="callEnd"
          label="Cancel"
          onPress={onCancel}
          variant="danger"
          size={72}
          accessibilityLabel="Cancel outgoing call"
          accessibilityHint="Stops calling and returns to the lobby"
          testID="outgoing-cancel"
        />
      </View>

      <StatusBanner status={status} />
    </View>
  );
}

/** @param {import('../theme').ThemeColors} colors */
const createStyles = colors =>
  StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: 'space-between',
      backgroundColor: colors.background,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.lg,
    },
    header: {
      alignItems: 'center',
      paddingTop: spacing.lg,
    },
    headerLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 1.2,
    },
    calleeSection: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
    },
    pulseRing: {
      position: 'absolute',
      width: 130,
      height: 130,
      borderRadius: 65,
      backgroundColor: colors.accentButton,
      opacity: 0.15,
    },
    avatar: {
      width: 100,
      height: 100,
      borderRadius: 50,
      backgroundColor: colors.surfaceRaised,
      borderWidth: 2,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: {
      fontSize: 36,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    calleeId: {
      fontSize: 30,
      fontWeight: '700',
      color: colors.textPrimary,
      textAlign: 'center',
      marginTop: spacing.sm,
    },
    countdown: {
      fontSize: 14,
      color: colors.textSecondary,
    },
    actions: {
      alignItems: 'center',
      paddingBottom: spacing.lg * 2,
    },
  });
