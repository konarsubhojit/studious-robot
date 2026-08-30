import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { deriveInitials, describeRingCountdown } from '../callUx';
import { useThemedStyles } from '../ThemeContext';
import { spacing } from '../theme';
import IconButton from './IconButton';
import RingingAvatar from './RingingAvatar';
import StatusBanner from './StatusBanner';
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
 * Incoming call screen.
 *
 * Shown to the callee while a call is ringing: the caller in the upper third
 * with a pulsing avatar, one labelled line of ring-window countdown, and
 * icon-only Accept / Decline buttons in the lower third.
 *
 * The countdown says what it counts. A bare `1:58` under a contact name reads
 * as a call that has been connected for 1:58 — the opposite of the truth.
 *
 * Purely presentational – all behaviour is supplied via props.
 *
 *   Call record from the server (callerId, ringTimeoutAt).
 * @param props.status - Current status.
 * @param props.onAccept - Called when the user presses Accept.
 * @param props.onDecline - Called when the user presses Decline.
 * @param props.isAnswering - The call has been accepted and is connecting; the
 *   screen keeps showing who is calling but stops offering Accept/Decline.
 * @param props.onCancelAnswer - Hangs up a call that is still connecting after
 *   it was accepted.  Omit to leave the connecting state without an abort
 *   affordance.
 */
export default function IncomingCallScreen({ incomingCall, status, onAccept, onDecline, isAnswering = false, onCancelAnswer }: { incomingCall?: CallRecord | null; status: CallStatus; onAccept: () => void; onDecline: () => void; isAnswering?: boolean; onCancelAnswer?: () => void; }) {
  const styles = useThemedStyles(createStyles);

  const ringTimeoutAt = isAnswering ? null : incomingCall?.ringTimeoutAt ?? null;
  const callerId = incomingCall?.callerId ?? 'Unknown';
  const initials = deriveInitials(callerId);

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

  const countdown = describeRingCountdown('Ringing', secondsLeft);

  return (
    <View style={styles.container} testID="incoming-call-screen">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.headerLabel} accessibilityRole="header">
          {isAnswering ? 'Connecting' : 'Incoming call'}
        </Text>
      </View>

      {/* ── Caller info ───────────────────────────────────────────────────── */}
      <View style={styles.callerSection}>
        <RingingAvatar initials={initials} tone="success" testID="incoming-avatar" />

        <Text
          style={styles.callerId}
          accessibilityLabel={`Incoming call from ${callerId}`}
          testID="incoming-caller-id">
          {callerId}
        </Text>

        {ringTimeoutAt ? (
          <Text
            style={styles.countdown}
            accessibilityLabel={countdown.spoken}
            testID="incoming-countdown">
            {countdown.text}
          </Text>
        ) : null}
      </View>

      {/* ── Action buttons ────────────────────────────────────────────────── */}
      {/* Once the call has been answered, Accept/Decline would act on a call
          that is already being set up, so the deck becomes a progress
          indicator until the media negotiation moves the app to the in-call
          screen. */}
      <View style={styles.actions}>
        {isAnswering ? (
          <>
            <IconButton
              icon="callAccept"
              label="Connecting…"
              loading
              variant="success"
              size={72}
              accessibilityLabel={`Connecting to ${callerId}`}
              testID="incoming-connecting"
            />
            {/* Media negotiation can stall (no network, a peer that never
                answers), and without this the answered call is a spinner with
                no way out until the server's own timeout fires. Declining is
                no longer possible at this point — the call has been accepted —
                so this hangs the call up instead. */}
            {onCancelAnswer ? (
              <IconButton
                icon="callEnd"
                label="End call"
                onPress={onCancelAnswer}
                variant="danger"
                size={72}
                accessibilityLabel="End the call being connected"
                accessibilityHint="Stops connecting and hangs up"
                testID="incoming-cancel-answer"
              />
            ) : null}
          </>
        ) : (
          <>
            <IconButton
              icon="callEnd"
              label="Decline"
              onPress={onDecline}
              variant="danger"
              size={72}
              accessibilityLabel="Decline incoming call"
              accessibilityHint="Rejects the call and tells the caller you are unavailable"
              testID="incoming-decline"
            />
            <IconButton
              icon="callAccept"
              label="Accept"
              onPress={onAccept}
              variant="success"
              size={72}
              accessibilityLabel="Accept incoming call"
              accessibilityHint="Answers the call and connects audio and video"
              testID="incoming-accept"
            />
          </>
        )}
      </View>

      {/* Problems only: while a call rings, an informational status merely
          repeats the header and the caller's name. Warnings stay — "answering
          without a camera" is exactly the news this screen must not eat. */}
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
    // reads as a loading state rather than as someone who is calling.
    callerSection: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'flex-start',
      paddingTop: spacing.xl,
      gap: spacing.md,
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
