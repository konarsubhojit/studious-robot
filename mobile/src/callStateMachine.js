/**
 * Pure finite-state machine describing the lifecycle of a WebRTC call.
 *
 * The `useWebRTCCall` hook concentrates a large amount of imperative
 * signaling/peer-connection logic. Modelling *which phase the call is in* as an
 * explicit, side-effect-free state machine makes that lifecycle testable in
 * isolation and removes the need to juggle several overlapping booleans
 * (`isReconnecting`, ad-hoc status strings) to answer "what is the call doing
 * right now?".
 *
 * The reducer is intentionally permissive: an event that has no defined
 * transition from the current phase leaves the phase unchanged rather than
 * throwing, so the surrounding hook can dispatch liberally without crashing a
 * live call on an unexpected ordering.
 */

export const CALL_PHASES = Object.freeze({
  IDLE: 'idle',
  PREVIEWING: 'previewing',
  CONNECTING: 'connecting',
  JOINED: 'joined',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ENDED: 'ended',
});

export const CALL_EVENTS = Object.freeze({
  PREVIEW_READY: 'PREVIEW_READY',
  JOIN: 'JOIN',
  SIGNALING_CONNECTED: 'SIGNALING_CONNECTED',
  CALL_CONNECTED: 'CALL_CONNECTED',
  RECONNECTING: 'RECONNECTING',
  RECONNECTED: 'RECONNECTED',
  LEAVE: 'LEAVE',
  FATAL: 'FATAL',
  RESET: 'RESET',
});

export const INITIAL_CALL_PHASE = CALL_PHASES.IDLE;

const {
  IDLE,
  PREVIEWING,
  CONNECTING,
  JOINED,
  CONNECTED,
  RECONNECTING,
  ENDED,
} = CALL_PHASES;

// Per-phase transition tables. Any (phase, event) pair not listed here leaves
// the phase unchanged.
const TRANSITIONS = {
  [CALL_EVENTS.PREVIEW_READY]: {
    [IDLE]: PREVIEWING,
    [PREVIEWING]: PREVIEWING,
    [ENDED]: PREVIEWING,
  },
  [CALL_EVENTS.JOIN]: {
    [IDLE]: CONNECTING,
    [PREVIEWING]: CONNECTING,
    [ENDED]: CONNECTING,
    [CONNECTING]: CONNECTING,
  },
  [CALL_EVENTS.SIGNALING_CONNECTED]: {
    [CONNECTING]: JOINED,
    [JOINED]: JOINED,
    [RECONNECTING]: JOINED,
    [CONNECTED]: CONNECTED,
  },
  [CALL_EVENTS.CALL_CONNECTED]: {
    [CONNECTING]: CONNECTED,
    [JOINED]: CONNECTED,
    [RECONNECTING]: CONNECTED,
    [CONNECTED]: CONNECTED,
  },
  [CALL_EVENTS.RECONNECTING]: {
    [CONNECTING]: RECONNECTING,
    [JOINED]: RECONNECTING,
    [CONNECTED]: RECONNECTING,
    [RECONNECTING]: RECONNECTING,
  },
  [CALL_EVENTS.RECONNECTED]: {
    [RECONNECTING]: JOINED,
  },
  // Leaving / fatal failures end any active phase.
  [CALL_EVENTS.LEAVE]: {
    [PREVIEWING]: ENDED,
    [CONNECTING]: ENDED,
    [JOINED]: ENDED,
    [CONNECTED]: ENDED,
    [RECONNECTING]: ENDED,
  },
  [CALL_EVENTS.FATAL]: {
    [CONNECTING]: ENDED,
    [JOINED]: ENDED,
    [CONNECTED]: ENDED,
    [RECONNECTING]: ENDED,
  },
  [CALL_EVENTS.RESET]: {
    [IDLE]: IDLE,
    [PREVIEWING]: IDLE,
    [CONNECTING]: IDLE,
    [JOINED]: IDLE,
    [CONNECTED]: IDLE,
    [RECONNECTING]: IDLE,
    [ENDED]: IDLE,
  },
};

/**
 * Compute the next call phase for an event.
 *
 * @param {string} phase - Current phase (one of `CALL_PHASES`).
 * @param {string} event - Event name (one of `CALL_EVENTS`).
 * @returns {string} The next phase, or the current phase if the transition is undefined.
 */
export function callReducer(phase, event) {
  const eventName = typeof event === 'string' ? event : event?.type;
  const table = TRANSITIONS[eventName];
  if (!table) {
    return phase;
  }
  const next = table[phase];
  return next === undefined ? phase : next;
}

/**
 * @param {string} phase
 * @returns {boolean} Whether the call is actively reconnecting.
 */
export function isReconnectingPhase(phase) {
  return phase === RECONNECTING;
}

/**
 * @param {string} phase
 * @returns {boolean} Whether the call is occupying a room (joined/connected/reconnecting).
 */
export function isInRoomPhase(phase) {
  return phase === CONNECTING || phase === JOINED || phase === CONNECTED || phase === RECONNECTING;
}

/**
 * @param {string} phase
 * @returns {boolean} Whether media is fully connected.
 */
export function isCallConnectedPhase(phase) {
  return phase === CONNECTED;
}
