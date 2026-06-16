import {
  CALL_EVENTS,
  CALL_PHASES,
  INITIAL_CALL_PHASE,
  callReducer,
  isCallConnectedPhase,
  isInRoomPhase,
  isReconnectingPhase,
} from '../src/callStateMachine';

describe('callStateMachine', () => {
  it('starts idle', () => {
    expect(INITIAL_CALL_PHASE).toBe(CALL_PHASES.IDLE);
  });

  it('walks the happy path idle → previewing → connecting → joined → connected', () => {
    let phase = INITIAL_CALL_PHASE;
    phase = callReducer(phase, CALL_EVENTS.PREVIEW_READY);
    expect(phase).toBe(CALL_PHASES.PREVIEWING);
    phase = callReducer(phase, CALL_EVENTS.JOIN);
    expect(phase).toBe(CALL_PHASES.CONNECTING);
    phase = callReducer(phase, CALL_EVENTS.SIGNALING_CONNECTED);
    expect(phase).toBe(CALL_PHASES.JOINED);
    phase = callReducer(phase, CALL_EVENTS.CALL_CONNECTED);
    expect(phase).toBe(CALL_PHASES.CONNECTED);
  });

  it('can join directly from idle without a preview', () => {
    expect(callReducer(CALL_PHASES.IDLE, CALL_EVENTS.JOIN)).toBe(CALL_PHASES.CONNECTING);
  });

  it('models a reconnect round-trip from connected back to connected', () => {
    let phase = CALL_PHASES.CONNECTED;
    phase = callReducer(phase, CALL_EVENTS.RECONNECTING);
    expect(phase).toBe(CALL_PHASES.RECONNECTING);
    expect(isReconnectingPhase(phase)).toBe(true);
    phase = callReducer(phase, CALL_EVENTS.RECONNECTED);
    expect(phase).toBe(CALL_PHASES.JOINED);
    phase = callReducer(phase, CALL_EVENTS.CALL_CONNECTED);
    expect(phase).toBe(CALL_PHASES.CONNECTED);
  });

  it('ends on LEAVE from any active phase', () => {
    for (const phase of [
      CALL_PHASES.CONNECTING,
      CALL_PHASES.JOINED,
      CALL_PHASES.CONNECTED,
      CALL_PHASES.RECONNECTING,
    ]) {
      expect(callReducer(phase, CALL_EVENTS.LEAVE)).toBe(CALL_PHASES.ENDED);
    }
  });

  it('ends on FATAL from active phases but not from idle/previewing', () => {
    expect(callReducer(CALL_PHASES.CONNECTED, CALL_EVENTS.FATAL)).toBe(CALL_PHASES.ENDED);
    expect(callReducer(CALL_PHASES.IDLE, CALL_EVENTS.FATAL)).toBe(CALL_PHASES.IDLE);
    expect(callReducer(CALL_PHASES.PREVIEWING, CALL_EVENTS.FATAL)).toBe(CALL_PHASES.PREVIEWING);
  });

  it('returns to idle on RESET from any phase', () => {
    for (const phase of Object.values(CALL_PHASES)) {
      expect(callReducer(phase, CALL_EVENTS.RESET)).toBe(CALL_PHASES.IDLE);
    }
  });

  it('leaves the phase unchanged for undefined transitions', () => {
    // RECONNECTED only applies while reconnecting.
    expect(callReducer(CALL_PHASES.CONNECTED, CALL_EVENTS.RECONNECTED)).toBe(CALL_PHASES.CONNECTED);
    // PREVIEW_READY mid-call is ignored.
    expect(callReducer(CALL_PHASES.CONNECTED, CALL_EVENTS.PREVIEW_READY)).toBe(CALL_PHASES.CONNECTED);
    // Unknown events are inert.
    expect(callReducer(CALL_PHASES.JOINED, 'NOPE')).toBe(CALL_PHASES.JOINED);
  });

  it('accepts an action object with a type field', () => {
    expect(callReducer(CALL_PHASES.IDLE, { type: CALL_EVENTS.JOIN })).toBe(CALL_PHASES.CONNECTING);
  });

  it('derives room/connected helpers from the phase', () => {
    expect(isInRoomPhase(CALL_PHASES.IDLE)).toBe(false);
    expect(isInRoomPhase(CALL_PHASES.PREVIEWING)).toBe(false);
    expect(isInRoomPhase(CALL_PHASES.JOINED)).toBe(true);
    expect(isInRoomPhase(CALL_PHASES.RECONNECTING)).toBe(true);
    expect(isCallConnectedPhase(CALL_PHASES.CONNECTED)).toBe(true);
    expect(isCallConnectedPhase(CALL_PHASES.JOINED)).toBe(false);
  });
});
