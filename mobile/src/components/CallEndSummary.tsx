import { StyleSheet } from 'react-native';
import { describeCallOutcome } from '../callUx';
import { spacing } from '../theme';
import { formatCallDuration } from './CallTimelineRow';
import { Banner } from './primitives';
import type { CallEndSummary as CallEndSummaryData } from '../hooks/useCallFlow';

/**
 * How a call that has just ended is resolved for the user.
 *
 * A call used to end by simply returning the user to the tab shell: a dropped
 * call, a declined one and a peer hanging up all looked identical, which makes
 * a lost connection indistinguishable from a broken app. This says which of
 * them happened, and — for a call that connected — how long it lasted.
 *
 * The wording comes from the same vocabulary as the conversation timeline
 * (`describeCallOutcome`), so the sentence the user reads now is the one they
 * will read in their history later.
 */
export default function CallEndSummary({
  summary,
  onDismiss,
}: {
  summary: CallEndSummaryData;
  onDismiss: () => void;
}) {
  const isFailure = summary.endReason === 'media_failed' || summary.endReason === 'failed';
  const duration = formatCallDuration(summary.durationSeconds);
  const outcome = describeCallOutcome(summary);
  const peer = summary.peerId ? ` with ${summary.peerId}` : '';

  return (
    <Banner
      tone={isFailure ? 'negative' : 'neutral'}
      icon={isFailure ? 'callMissed' : 'callOutgoing'}
      message={duration ? `${outcome}${peer} · ${duration}` : `${outcome}${peer}`}
      onDismiss={onDismiss}
      dismissLabel="Dismiss call summary"
      accessibilityRole="alert"
      style={styles.container}
      testID="call-end-summary"
    />
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
});
