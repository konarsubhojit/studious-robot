import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { deriveInitials, describeRingCountdown } from '../callUx';
import { useThemedStyles } from '../ThemeContext';
import { spacing } from '../theme';
import IconButton from './IconButton';
import RingingAvatar from './RingingAvatar';
import StatusBanner from './StatusBanner';
import type { CallDelivery } from '../hooks/useCallFlow';
import type { CallRecord } from '../../../shared/signaling/schemas';
import type { CallStatus } from './StatusBanner';
import type { MutableRefObject } from 'react';
import type { ThemeColors } from '../theme';

/**
 * Derives the number of seconds until ringTimeoutAt (clamped to ≥ 0).
 *
 * @param ringTimeoutAt – ISO 8601 timestamp from the call record.
 */
function secondsRemaining(ringTimeoutAt: string | null | undefined): number {
  if (!ringTimeoutAt) return 0;
  return Math.max(0, Math.round((new Date(ringTimeoutAt).getTime() - Date.now()) / 1000));
}

/**
 * How the callee is being reached, in the caller's words.
 *
 * The server distinguishes a device that is ringing right now from one that a
 * push still has to wake, and only the caller was left guessing: ten seconds of
 * silence on the push path reads exactly like a hang.
 */
function describeDelivery(delivery: CallDelivery | null | undefined): string | null {
  if (delivery === 'push') return 'Waking their phone';
  if (delivery === 'ringing') return 'Ringing on their device';
  return null;
}

/**
 * Outgoing ringing screen.
 *
 * Shown while the caller waits for the callee to answer: the callee in the
 * upper third with a pulsing avatar, one line saying what is actually
 * happening (ringing, or waking a sleeping phone) and how long the ring window
 * has left, and an icon-only Cancel button in the lower third.
 *
 * The countdown is labelled rather than bare: a lone `1:58` directly beneath a
 * contact name reads as a call that has been connected for 1:58, which is the
 * opposite of the truth.
 *
 * Purely presentational – all behaviour is supplied via props.
 *
 * @param props.calleeId - The ID / name of the callee; falls back to "Unknown".
 * @param props.activeCall - Live call record (may include ringTimeoutAt).
 * @param props.delivery - How the callee is being reached, once known.
 * @param props.status - Current status.
 * @param props.onCancel - Called when the user presses Cancel.
 */
export default function OutgoingCallScreen({ calleeId, activeCall, delivery = null, status, onCancel }: { calleeId?: string; activeCall?: CallRecord | null; delivery?: CallDelivery | null; status: CallStatus; onCancel: () => void; }) {
  const styles = useThemedStyles(createStyles);

  const ringTimeoutAt = activeCall?.ringTimeoutAt ?? null;
  const initials = deriveInitials(calleeId);
  const deliveryLabel = describeDelivery(delivery);

  const [secondsLeft, setSecondsLeft] = useState(() => secondsRemaining(ringTimeoutAt));
  const intervalRef: MutableRefObject<ReturnType<typeof setInterval> | null> = useRef(null);

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

  const countdown = describeRingCountdown(deliveryLabel ?? 'Ringing', secondsLeft);

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
        <RingingAvatar initials={initials} tone="accent" testID="outgoing-avatar" />

        <Text
          style={styles.calleeId}
          accessibilityLabel={`Calling ${calleeId || 'unknown contact'}`}
          testID="outgoing-callee-id">
          {calleeId || 'Unknown'}
        </Text>

        {ringTimeoutAt ? (
          <Text
            style={styles.countdown}
            accessibilityLabel={countdown.spoken}
            testID="outgoing-countdown">
            {countdown.text}
          </Text>
        ) : deliveryLabel ? (
          <Text style={styles.countdown} testID="outgoing-delivery">
            {deliveryLabel}
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

      {/* Problems only: while a call rings, an informational status merely
          repeats the header and the callee's name. Warnings stay — a degraded
          answer path is exactly the news this screen must not eat. */}
      {status?.severity && status.severity !== 'info' ? <StatusBanner status={status} /> : null}
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
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
    // Upper third, not dead centre: a person centred in a field of nothing
    // reads as a loading state rather than as someone you are reaching.
    calleeSection: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'flex-start',
      paddingTop: spacing.xl,
      gap: spacing.md,
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
