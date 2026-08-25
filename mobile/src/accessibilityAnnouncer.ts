import { AccessibilityInfo } from 'react-native';
import { CALL_STATES } from './call/callStateMachine';

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
