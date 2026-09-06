import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../theme';
import { Toast } from './primitives';
import type { CallStatus } from './StatusBanner';

/**
 * App-level status, surfaced over a list screen as a transient bar at the top.
 *
 * The single `status` slot is written by every subsystem — call setup, session
 * refresh, identity, the message outbox — so a list screen that renders it
 * inline ends up quoting failures that have nothing to do with what it shows:
 * the call log would report "Message failed to send", and an authentication or
 * rate-limit error would push the log itself down the screen to say so.
 *
 * Two rules follow, and this component encodes both:
 *
 * - **Only warnings and errors.** Informational and success chatter ("Calling
 *   bob…", "Camera switched") belongs to the screen that caused it. On a list
 *   it is noise.
 * - **Floated, not inserted.** A message that occupies layout moves the rows
 *   under the user's finger. This sits over them and dismisses itself.
 *
 * Persistent *conditions* — "server unreachable" — are deliberately not routed
 * here; those stay as an inline `Banner`, because they remain true until
 * something changes and must not fade away.
 */
/**
 * The status if it is one this bar shows, otherwise `undefined`.
 *
 * Exported so a caller can narrow before passing it down: the status slot is
 * rewritten constantly during a call, and a screen that takes the raw value as
 * a prop re-renders for every "Calling bob…" it is going to ignore anyway.
 */
export function alertStatus(status?: CallStatus): CallStatus | undefined {
  const severity = status?.severity;
  if (severity !== 'warning' && severity !== 'error') return undefined;
  return status?.message ? status : undefined;
}

export default function StatusToast({
  status,
  testID = 'status-toast',
}: {
  status?: CallStatus;
  testID?: string;
}) {
  const message = alertStatus(status)?.message ?? '';
  // Held separately from `status` so dismissing hides the toast without having
  // to clear state this screen does not own; a new message re-arms it.
  const [dismissed, setDismissed] = useState('');
  const onDismiss = useCallback(() => setDismissed(message), [message]);

  useEffect(() => {
    setDismissed(current => (current === message ? current : ''));
  }, [message]);

  if (!message || dismissed === message) return null;

  return (
    <View style={styles.layer} pointerEvents="box-none">
      <Toast
        message={message}
        tone="error"
        onDismiss={onDismiss}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 1,
  },
});
