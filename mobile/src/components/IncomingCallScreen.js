import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';
import AppButton from './AppButton';
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
 * Shown to the callee while a call is ringing.  Displays the caller's ID,
 * a countdown derived from the call record's `ringTimeoutAt` field, and
 * Accept / Decline buttons.
 *
 * Purely presentational – all behaviour is supplied via props.
 *
 * @param {object} props
 * @param {object} props.incomingCall - Call record from the server (includes callerId, ringTimeoutAt).
 * @param {object} props.status - Current status message `{ message, severity }`.
 * @param {() => void} props.onAccept - Called when the user presses Accept.
 * @param {() => void} props.onDecline - Called when the user presses Decline.
 */
export default function IncomingCallScreen({ incomingCall, status, onAccept, onDecline }) {
  const ringTimeoutAt = incomingCall?.ringTimeoutAt ?? null;
  const callerId = incomingCall?.callerId ?? 'Unknown';

  const [secondsLeft, setSecondsLeft] = useState(() => secondsRemaining(ringTimeoutAt));
  const intervalRef = useRef(null);

  // Update the countdown every second.
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
      <View style={styles.card}>
        <Text style={styles.label} accessibilityRole="header">
          Incoming call
        </Text>

        <Text style={styles.callerId} testID="incoming-caller-id">
          {callerId}
        </Text>

        {ringTimeoutAt ? (
          <Text style={styles.countdown} testID="incoming-countdown">
            {secondsLeft > 0 ? `Rings for ${secondsLeft}s` : 'Timed out'}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <AppButton
            title="Decline"
            onPress={onDecline}
            style={styles.declineButton}
            accessibilityLabel="Decline incoming call"
            testID="incoming-decline"
          />
          <AppButton
            title="Accept"
            onPress={onAccept}
            style={styles.acceptButton}
            accessibilityLabel="Accept incoming call"
            testID="incoming-accept"
          />
        </View>
      </View>

      <StatusBanner status={status} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'stretch',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    backgroundColor: colors.background,
  },
  card: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.md,
  },
  label: {
    fontSize: 16,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  callerId: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  countdown: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
    width: '100%',
  },
  declineButton: {
    backgroundColor: colors.danger,
  },
  acceptButton: {
    backgroundColor: colors.success,
  },
});
