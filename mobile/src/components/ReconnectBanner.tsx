import ErrorState from './ErrorState';
import type { CallRecoveryStatus } from '../hooks/useCallFlow';

/**
 * Banner shown while a call is recovering, with a manual "Retry" action.
 *
 * Built on the shared `ErrorState` so a dropped connection is announced as an
 * alert and offers the same recovery affordance as every other failure in the
 * app.
 *
 * It used to render a static "Reconnecting…" for socket loss only, so the
 * common case — ICE down but the socket fine, the TURN-path failure — showed
 * nothing at all, and even when it did show it never said the wait was
 * bounded. Someone watching a frozen picture could not tell whether waiting
 * was worth it. The recovery episode makes both knowable, so both are said:
 * which attempt is running, how long the wait is bounded to, and — when the
 * ladder runs out — that the connection is gone rather than still coming.
 *
 * @param recovery - the open recovery episode, when there is one.
 * @param isConnectionLost - the budget was spent with the media still down.
 */
export default function ReconnectBanner({
  onRetry,
  recovery = null,
  isConnectionLost = false,
}: {
  onRetry: () => void;
  recovery?: CallRecoveryStatus | null;
  isConnectionLost?: boolean;
}) {
  if (isConnectionLost) {
    // The ladder is over. Offering "Retry" here would promise a recovery that
    // has already been ruled out; the call ends from this state.
    return (
      <ErrorState
        severity="error"
        title="Connection lost"
        description="The call could not be restored, so it is ending."
        testID="reconnect-banner"
      />
    );
  }

  // An automatic attempt is already in flight: a manual "Retry" beside it only
  // duplicates work underway, and a button that visibly changes nothing teaches
  // the user that pressing it does nothing.
  const canRetryManually = !recovery?.isAttemptPending;

  return (
    <ErrorState
      severity="warning"
      title={describeTitle(recovery)}
      description={describeProgress(recovery)}
      {...(canRetryManually
        ? {
            actionLabel: 'Retry',
            actionHint: 'Renegotiates the call connection now',
            onAction: onRetry,
          }
        : {})}
      testID="reconnect-banner"
    />
  );
}

/** Title that names what is actually broken, and which attempt is running. */
function describeTitle(recovery: CallRecoveryStatus | null): string {
  if (recovery?.isPaused) return 'Waiting for a network…';
  const attempts = recovery?.attempts ?? 0;
  const progress = attempts > 0 ? ` (attempt ${attempts})` : '';
  if (recovery && recovery.trigger !== 'socket-disconnect') {
    return `Restoring your call…${progress}`;
  }
  return `Reconnecting…${progress}`;
}

/** Description that says how long the wait is bounded to, and by what. */
function describeProgress(recovery: CallRecoveryStatus | null): string {
  if (!recovery) {
    return 'The connection dropped. Your call is being kept alive — retry if it does not come back on its own.';
  }
  if (recovery.isPaused) {
    return 'This device has no usable network. The call is held, and recovery resumes the moment one is back.';
  }
  const seconds = Math.max(0, Math.ceil(recovery.remainingMs / 1000));
  const attempts = recovery.attempts === 1 ? '1 attempt' : `${recovery.attempts} attempts`;
  const opening = `The connection dropped and is being restored (${attempts} so far). Trying for up to ${seconds}s more`;
  return recovery.isAttemptPending
    ? `${opening} — an attempt is running right now.`
    : `${opening} — retry now if you would rather not wait.`;
}
