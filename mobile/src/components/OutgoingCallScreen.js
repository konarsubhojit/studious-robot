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
 * Outgoing ringing screen.
 *
 * Shown while the caller waits for the callee to answer.  Displays a
 * countdown derived from the call record's `ringTimeoutAt` field and
 * a Cancel button to withdraw the call.
 *
 * Purely presentational – all behaviour is supplied via props.
 *
 * @param {object} props
 * @param {string} props.calleeId - The ID / name of the callee.
 * @param {object|null} props.activeCall - Live call record from the server (may include ringTimeoutAt).
 * @param {object} props.status - Current status message `{ message, severity }`.
 * @param {() => void} props.onCancel - Called when the user presses Cancel.
 */
export default function OutgoingCallScreen({ calleeId, activeCall, status, onCancel }) {
  const ringTimeoutAt = activeCall?.ringTimeoutAt ?? null;

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
    <View style={styles.container} testID="outgoing-call-screen">
      <View style={styles.card}>
        <Text style={styles.label} accessibilityRole="header">
          Calling…
        </Text>

        <Text style={styles.calleeId} testID="outgoing-callee-id">
          {calleeId || 'Unknown'}
        </Text>

        {ringTimeoutAt ? (
          <Text style={styles.countdown} testID="outgoing-countdown">
            {secondsLeft > 0 ? `${secondsLeft}s` : 'Timed out'}
          </Text>
        ) : null}

        <AppButton
          title="Cancel"
          onPress={onCancel}
          style={styles.cancelButton}
          accessibilityLabel="Cancel outgoing call"
          testID="outgoing-cancel"
        />
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
  calleeId: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  countdown: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  cancelButton: {
    backgroundColor: colors.danger,
    marginTop: spacing.sm,
    minWidth: 160,
  },
});
