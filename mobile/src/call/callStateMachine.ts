// @ts-check
/**
 * The single call state machine.
 *
 * Every screen derives what it shows from exactly one call state, so the UI
 * never has to reconcile competing sources of truth:
 *
 *   idle ──place──► outgoing_ringing ──connect──► in_call ──end──► ended
 *    │                                   ▲                          │
 *    └──receive──► incoming_ringing ─────┘                    reset─┘
 *
 * `ended` is the short-lived state entered when a call terminates (for any
 * reason: hang-up, decline, cancel, timeout, failure). It exists so consumers
 * can observe the terminal transition; `reset` returns the machine to `idle`
 * once the teardown has been acknowledged.
 *
 * The reducer is pure: transitions that are not legal from the current state
 * are ignored (the state is returned unchanged) rather than throwing, so a
 * late/duplicate signaling event can never corrupt the UI.
 */

export type CallState = 'idle' | 'outgoing_ringing' | 'incoming_ringing' | 'in_call' | 'ended';
export type CallState = 'idle' | 'outgoing_ringing' | 'incoming_ringing' | 'in_call' | 'ended';
export type CallState = 'idle' | 'outgoing_ringing' | 'incoming_ringing' | 'in_call' | 'ended';
export type CallState = 'idle' | 'outgoing_ringing' | 'incoming_ringing' | 'in_call' | 'ended';
export type CallState = 'idle' | 'outgoing_ringing' | 'incoming_ringing' | 'in_call' | 'ended';
export const CALL_STATES = {
  IDLE: 'idle',
  OUTGOING_RINGING: 'outgoing_ringing',
  INCOMING_RINGING: 'incoming_ringing',
  IN_CALL: 'in_call',
  ENDED: 'ended',
};

export type CallEvent = 'place' | 'receive' | 'connect' | 'end' | 'reset';
export type CallEvent = 'place' | 'receive' | 'connect' | 'end' | 'reset';
export type CallEvent = 'place' | 'receive' | 'connect' | 'end' | 'reset';
export type CallEvent = 'place' | 'receive' | 'connect' | 'end' | 'reset';
export type CallEvent = 'place' | 'receive' | 'connect' | 'end' | 'reset';
export const CALL_EVENTS = {
  /** Local user placed a call (outgoing ringing). */
  PLACE: 'place',
  /** An incoming call arrived (incoming ringing). */
  RECEIVE: 'receive',
  /** Media negotiated — the call is connected. */
  CONNECT: 'connect',
  /** The call terminated, for any reason. */
  END: 'end',
  /** Teardown acknowledged — return to idle. */
  RESET: 'reset',
};

export const INITIAL_CALL_STATE = CALL_STATES.IDLE;

/**
 * Legal transitions, keyed by state then event. A state/event pair that is
 * absent from the table is a no-op.
 *
 * @type {Record<string, Record<string, string>>}
 */
const TRANSITIONS: Record<string, Record<string, string>> = {
  [CALL_STATES.IDLE]: {
    [CALL_EVENTS.PLACE]: CALL_STATES.OUTGOING_RINGING,
    [CALL_EVENTS.RECEIVE]: CALL_STATES.INCOMING_RINGING,
    // A call rehydrated from a push notification / CallKeep answer can connect
    // without this device ever having rendered a ringing screen.
    [CALL_EVENTS.CONNECT]: CALL_STATES.IN_CALL,
  },
  [CALL_STATES.OUTGOING_RINGING]: {
    [CALL_EVENTS.CONNECT]: CALL_STATES.IN_CALL,
    [CALL_EVENTS.END]: CALL_STATES.ENDED,
  },
  [CALL_STATES.INCOMING_RINGING]: {
    [CALL_EVENTS.CONNECT]: CALL_STATES.IN_CALL,
    [CALL_EVENTS.END]: CALL_STATES.ENDED,
  },
  [CALL_STATES.IN_CALL]: {
    [CALL_EVENTS.END]: CALL_STATES.ENDED,
  },
  [CALL_STATES.ENDED]: {
    [CALL_EVENTS.RESET]: CALL_STATES.IDLE,
  },
};

/**
 * Pure reducer for the call state machine.
 *
 * @param {string} state current state
 * @param {string|{ type: string }} event event (or `{ type }` action)
 * @returns {string} the next state, or `state` when the transition is not legal
 */
export function callStateReducer(state: string, event: string | { type: string; }): string {
  const type = typeof event === 'string' ? event : event?.type;
  return TRANSITIONS[state]?.[type] ?? state;
}

/**
 * @param {string} state
 * @returns {boolean} true while a call is ringing in either direction
 */
export function isRingingState(state: string): boolean {
  return state === CALL_STATES.OUTGOING_RINGING || state === CALL_STATES.INCOMING_RINGING;
}

/**
 * @param {string} state
 * @returns {boolean} true while a call occupies the device (ringing or connected)
 */
export function isCallActiveState(state: string): boolean {
  return state !== CALL_STATES.IDLE && state !== CALL_STATES.ENDED;
}
