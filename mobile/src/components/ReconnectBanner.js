import ErrorState from './ErrorState';

/**
 * Banner shown during a transient disconnect, with a manual "Retry" action.
 *
 * Built on the shared `ErrorState` so a dropped connection is announced as an
 * alert and offers the same recovery affordance as every other failure in the
 * app.
 *
 * @param {object} props
 * @param {() => void} props.onRetry
 */
export default function ReconnectBanner({ onRetry }) {
  return (
    <ErrorState
      severity="warning"
      title="Reconnecting…"
      description="The connection dropped. Your call is being kept alive — retry if it does not come back on its own."
      actionLabel="Retry"
      actionHint="Renegotiates the call connection now"
      onAction={onRetry}
      testID="reconnect-banner"
    />
  );
}
