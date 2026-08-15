import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { deriveInitials } from '../callUx';
import { colors, spacing } from '../theme';
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
 * Incoming call screen.
 *
 * Shown to the callee while a call is ringing.  Displays the caller's ID with
 * a pulsing avatar, a countdown, and icon-only Accept / Decline buttons.
 *
 * Purely presentational – all behaviour is supplied via props.
 *
 * @param {object}   props
 * @param {object}   props.incomingCall   - Call record from the server (callerId, ringTimeoutAt).
 * @param {object}   props.status         - Current status `{ message, severity }`.
 * @param {Function} props.onAccept       - Called when the user presses Accept.
 * @param {Function} props.onDecline      - Called when the user presses Decline.
 */
export default function IncomingCallScreen({ incomingCall, status, onAccept, onDecline }) {
  const ringTimeoutAt = incomingCall?.ringTimeoutAt ?? null;
  const callerId = incomingCall?.callerId ?? 'Unknown';
  const initials = deriveInitials(callerId);

  const [secondsLeft, setSecondsLeft] = useState(() => secondsRemaining(ringTimeoutAt));
  const intervalRef = useRef(null);

  // ── Pulse animation ───────────────────────────────────────────────────────
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.18,
          duration: 800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 800,
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
      if (remaining <= 0) {
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
    <View style={styles.container} testID="incoming-call-screen">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.headerLabel}>Incoming call</Text>
      </View>

      {/* ── Caller info ───────────────────────────────────────────────────── */}
      <View style={styles.callerSection}>
        {/* Pulsing ring behind the avatar */}
        <Animated.View
          style={[styles.pulseRing, { transform: [{ scale: pulseAnim }] }]}
          accessible={false}
        />
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>

        <Text style={styles.callerId} testID="incoming-caller-id">
          {callerId}
        </Text>

        {ringTimeoutAt ? (
          <Text style={styles.countdown} testID="incoming-countdown">
            {secondsLeft > 0 ? `Rings for ${secondsLeft}s` : 'Timed out'}
          </Text>
        ) : null}
      </View>

      {/* ── Action buttons ────────────────────────────────────────────────── */}
      <View style={styles.actions}>
        <IconButton
          icon="callEnd"
          label="Decline"
          onPress={onDecline}
          variant="danger"
          size={72}
          accessibilityLabel="Decline incoming call"
          testID="incoming-decline"
        />
        <IconButton
          icon="callAccept"
          label="Accept"
          onPress={onAccept}
          variant="success"
          size={72}
          accessibilityLabel="Accept incoming call"
          testID="incoming-accept"
        />
      </View>

      <StatusBanner status={status} />
    </View>
  );
}

const styles = StyleSheet.create({
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
  callerSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  pulseRing: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.success,
    opacity: 0.18,
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
  callerId: {
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
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    paddingBottom: spacing.lg * 2,
  },
});
