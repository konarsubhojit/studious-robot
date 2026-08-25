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
 * was worth it. The recovery episode makes both knowable, so both are said.
 *
 * @param recovery - the open recovery episode, when there is one.
 */
export default function ReconnectBanner({
  onRetry,
  recovery = null,
}: {
  onRetry: () => void;
  recovery?: CallRecoveryStatus | null;
}) {
  return (
    <ErrorState
      severity="warning"
      title={describeTitle(recovery)}
      description={describeProgress(recovery)}
      actionLabel="Retry"
      actionHint="Renegotiates the call connection now"
      onAction={onRetry}
      testID="reconnect-banner"
    />
  );
}

/** Title that names what is actually broken. */
function describeTitle(recovery: CallRecoveryStatus | null): string {
  if (recovery?.isPaused) return 'Waiting for a network…';
  if (recovery && recovery.trigger !== 'socket-disconnect') return 'Restoring your call…';
  return 'Reconnecting…';
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
  return `The connection dropped and is being restored (${attempts} so far). Trying for up to ${seconds}s more — retry now if you would rather not wait.`;
}
