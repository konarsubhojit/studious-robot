// @ts-check
import {
  CALL_EVENTS,
  CALL_STATES,
  INITIAL_CALL_STATE,
  callStateReducer,
  isCallActiveState,
  isRingingState,
} from '../../src/call/callStateMachine';

describe('callStateReducer', () => {
  test('starts idle', () => {
    expect(INITIAL_CALL_STATE).toBe(CALL_STATES.IDLE);
  });

  test('idle → outgoing_ringing when the local user places a call', () => {
    expect(callStateReducer(CALL_STATES.IDLE, CALL_EVENTS.PLACE)).toBe(
      CALL_STATES.OUTGOING_RINGING,
    );
  });

  test('idle → incoming_ringing when a call arrives', () => {
    expect(callStateReducer(CALL_STATES.IDLE, CALL_EVENTS.RECEIVE)).toBe(
      CALL_STATES.INCOMING_RINGING,
    );
  });

  test('idle → in_call for a call rehydrated from a push notification', () => {
    expect(callStateReducer(CALL_STATES.IDLE, CALL_EVENTS.CONNECT)).toBe(CALL_STATES.IN_CALL);
  });

  test('outgoing_ringing → in_call once media connects', () => {
    expect(callStateReducer(CALL_STATES.OUTGOING_RINGING, CALL_EVENTS.CONNECT)).toBe(
      CALL_STATES.IN_CALL,
    );
  });

  test('incoming_ringing → in_call once media connects', () => {
    expect(callStateReducer(CALL_STATES.INCOMING_RINGING, CALL_EVENTS.CONNECT)).toBe(
      CALL_STATES.IN_CALL,
    );
  });

  test.each([CALL_STATES.OUTGOING_RINGING, CALL_STATES.INCOMING_RINGING, CALL_STATES.IN_CALL])(
    '%s → ended when the call terminates',
    state => {
      expect(callStateReducer(state, CALL_EVENTS.END)).toBe(CALL_STATES.ENDED);
    },
  );

  test('ended → idle on reset', () => {
    expect(callStateReducer(CALL_STATES.ENDED, CALL_EVENTS.RESET)).toBe(CALL_STATES.IDLE);
  });

  test('accepts `{ type }` actions as well as bare event strings', () => {
    expect(callStateReducer(CALL_STATES.IDLE, { type: CALL_EVENTS.PLACE })).toBe(
      CALL_STATES.OUTGOING_RINGING,
    );
  });

  test('ignores an end event while idle', () => {
    expect(callStateReducer(CALL_STATES.IDLE, CALL_EVENTS.END)).toBe(CALL_STATES.IDLE);
  });

  test('ignores a second incoming call while already ringing or connected', () => {
    expect(callStateReducer(CALL_STATES.INCOMING_RINGING, CALL_EVENTS.RECEIVE)).toBe(
      CALL_STATES.INCOMING_RINGING,
    );
    expect(callStateReducer(CALL_STATES.IN_CALL, CALL_EVENTS.RECEIVE)).toBe(CALL_STATES.IN_CALL);
  });

  test('ignores a late connect after the call ended', () => {
    expect(callStateReducer(CALL_STATES.ENDED, CALL_EVENTS.CONNECT)).toBe(CALL_STATES.ENDED);
  });

  test('ignores a duplicate end event once ended', () => {
    expect(callStateReducer(CALL_STATES.ENDED, CALL_EVENTS.END)).toBe(CALL_STATES.ENDED);
  });

  test('ignores unknown events and unknown states', () => {
    expect(callStateReducer(CALL_STATES.IN_CALL, 'nonsense')).toBe(CALL_STATES.IN_CALL);
    expect(callStateReducer(CALL_STATES.IN_CALL, /** @type {any} */ (undefined))).toBe(
      CALL_STATES.IN_CALL
    );
    expect(callStateReducer('nonsense', CALL_EVENTS.PLACE)).toBe('nonsense');
  });

  test('runs a full outgoing call lifecycle', () => {
    const events = [CALL_EVENTS.PLACE, CALL_EVENTS.CONNECT, CALL_EVENTS.END, CALL_EVENTS.RESET];
    /** @type {any} */
    const states: any = [];
    events.reduce((state, event) => {
      const next = callStateReducer(state, event);
      states.push(next);
      return next;
    }, INITIAL_CALL_STATE);

    expect(states).toEqual([
      CALL_STATES.OUTGOING_RINGING,
      CALL_STATES.IN_CALL,
      CALL_STATES.ENDED,
      CALL_STATES.IDLE,
    ]);
  });

  test('runs a declined incoming call lifecycle', () => {
    const ringing = callStateReducer(INITIAL_CALL_STATE, CALL_EVENTS.RECEIVE);
    const ended = callStateReducer(ringing, CALL_EVENTS.END);

    expect(ringing).toBe(CALL_STATES.INCOMING_RINGING);
    expect(ended).toBe(CALL_STATES.ENDED);
    expect(callStateReducer(ended, CALL_EVENTS.RESET)).toBe(CALL_STATES.IDLE);
  });
});

describe('state predicates', () => {
  test('isRingingState is true only while ringing', () => {
    expect(isRingingState(CALL_STATES.OUTGOING_RINGING)).toBe(true);
    expect(isRingingState(CALL_STATES.INCOMING_RINGING)).toBe(true);
    expect(isRingingState(CALL_STATES.IN_CALL)).toBe(false);
    expect(isRingingState(CALL_STATES.IDLE)).toBe(false);
  });

  test('isCallActiveState covers ringing and connected states', () => {
    expect(isCallActiveState(CALL_STATES.OUTGOING_RINGING)).toBe(true);
    expect(isCallActiveState(CALL_STATES.INCOMING_RINGING)).toBe(true);
    expect(isCallActiveState(CALL_STATES.IN_CALL)).toBe(true);
    expect(isCallActiveState(CALL_STATES.IDLE)).toBe(false);
    expect(isCallActiveState(CALL_STATES.ENDED)).toBe(false);
  });
});
