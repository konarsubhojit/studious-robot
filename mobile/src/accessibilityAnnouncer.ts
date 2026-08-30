import { AccessibilityInfo } from 'react-native';
import { CALL_STATES } from './call/callStateMachine';
import { describeCallOutcome } from './callUx';
import type { CallOutcome } from './callUx';

/**
 * Screen-reader announcements.
 *
 * Call state changes are conveyed visually (a new full-screen screen, a
 * banner); TalkBack/VoiceOver users need them spoken instead, so every
 * transition is announced through `AccessibilityInfo.announceForAccessibility`.
 */

/**
 * Speak `message` if a screen reader is active. Safe to call on any platform:
 * a missing native module simply results in no announcement.
 */
export function announceForAccessibility(message: string) {
  if (!message) return;
  try {
    AccessibilityInfo.announceForAccessibility?.(message);
  } catch {
    // Announcements are advisory: never let one break a call flow.
  }
}

/**
 * Sentence announced when the call machine enters `callState`.
 *
 * @param callState - One of CALL_STATES.
 * @returns the announcement, or `null` for states with nothing to say.
 */
export function describeCallState(callState: string, { callerId, calleeId }: { callerId?: string | null; calleeId?: string | null; } = {}): string | null {
  switch (callState) {
    case CALL_STATES.INCOMING_RINGING:
      return `Incoming call from ${callerId || 'unknown caller'}`;
    case CALL_STATES.OUTGOING_RINGING:
      return `Calling ${calleeId || 'unknown contact'}`;
    case CALL_STATES.IN_CALL:
      return 'Call connected';
    case CALL_STATES.ENDED:
      return 'Call ended';
    default:
      return null;
  }
}

/**
 * Sentence announced when a call's recovery state changes.
 *
 * A reconnect is otherwise conveyed only by a banner appearing and vanishing
 * over the video, which a screen-reader user never sees — so the most alarming
 * moment of a call (audio has stopped and nobody has said why) was silent.
 *
 * @param isRecovering - Whether a recovery episode is currently in flight.
 * @returns the announcement, or `null` when there is nothing new to say.
 */
export function describeRecoveryState(isRecovering: boolean): string | null {
  return isRecovering ? 'Connection lost, reconnecting' : 'Reconnected';
}

/**
 * What the recovery banner is currently saying, as the announcer sees it.
 */
export type RecoveryAnnouncementState = {
  isRecovering: boolean;
  /** Rungs of the restart ladder consumed so far. */
  attempts: number;
  /** The recovery budget was spent with the media still down. */
  isConnectionLost: boolean;
};

/**
 * Sentence announced for the move from one recovery state to the next.
 *
 * Attempt progress and exhaustion are shown only in a small banner over the
 * video, so without this the ladder's whole story — trying, trying again,
 * giving up — reached a screen-reader user as silence followed by a call that
 * simply stopped.
 *
 * @returns the announcement, or `null` when nothing has changed worth saying.
 */
export function describeRecoveryTransition(
  previous: RecoveryAnnouncementState,
  next: RecoveryAnnouncementState,
): string | null {
  if (next.isConnectionLost) {
    return previous.isConnectionLost ? null : 'Connection lost. The call could not be restored.';
  }
  if (next.isRecovering !== previous.isRecovering) {
    return describeRecoveryState(next.isRecovering);
  }
  // The first attempt is already covered by "Connection lost, reconnecting";
  // only the ones that say the app is still trying are worth repeating.
  if (next.isRecovering && next.attempts > previous.attempts && next.attempts > 1) {
    return `Still reconnecting, attempt ${next.attempts}`;
  }
  return null;
}

/**
 * Sentence announced when a call ends, naming how it ended and how long it ran.
 *
 * The summary is a banner above the tab shell the user has just been returned
 * to, which is exactly the kind of state change nothing moves focus to.
 *
 * @returns the announcement, or `null` when there is no summary to read.
 */
export function describeCallEnd(
  summary: (CallOutcome & { durationSeconds?: number | null }) | null | undefined,
): string | null {
  if (!summary) return null;
  const outcome = describeCallOutcome(summary);
  const duration = describeSpokenDuration(summary.durationSeconds);
  return duration ? `${outcome}, ${duration}` : outcome;
}

/**
 * A call duration as words rather than as `2:08`, which a screen reader reads
 * as a time of day.
 */
function describeSpokenDuration(durationSeconds: number | null | undefined): string {
  const total = Math.floor(Number(durationSeconds));
  if (!Number.isFinite(total) || total <= 0) return '';
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (seconds > 0) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/**
 * Sentence announced when a sent message reaches a terminal delivery state.
 *
 * Delivery is shown as a tick glyph in the bubble footer, which conveys nothing
 * unless the row happens to be re-read.
 *
 * @param status - The message's delivery state.
 * @returns the announcement, or `null` for states still in progress.
 */
export function describeMessageDelivery(status: string): string | null {
  switch (status) {
    case 'failed':
      return 'Message failed to send';
    case 'sent':
      return 'Message sent';
    default:
      return null;
  }
}

/**
 * Sentence announced when an appearance preference changes.
 *
 * An appearance control confirms itself *visually* — the screen recolours, the
 * type grows — which is exactly the confirmation a screen-reader user does not
 * get. The selected state is on the control, but nothing repositions focus to
 * it, so without this a change is entirely silent.
 *
 * @param setting - What was changed, e.g. 'Accent colour'.
 * @param value - What it was changed to, e.g. 'Teal'.
 * @returns the announcement, or `null` when there is nothing to say.
 */
export function describeAppearanceChange(setting: string, value: string): string | null {
  if (!setting || !value) return null;
  return `${setting}: ${value}`;
}
