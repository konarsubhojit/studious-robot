// @ts-check
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
 *
 * @param {string} message
 */
export function announceForAccessibility(message) {
  if (!message) return;
  try {
    AccessibilityInfo.announceForAccessibility?.(message);
  } catch (_error) {
    // Announcements are advisory: never let one break a call flow.
  }
}

/**
 * Sentence announced when the call machine enters `callState`.
 *
 * @param {string} callState - One of CALL_STATES.
 * @param {{ callerId?: string|null, calleeId?: string|null }} [peers]
 * @returns {string|null} the announcement, or `null` for states with nothing to say.
 */
export function describeCallState(callState, { callerId, calleeId } = {}) {
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
