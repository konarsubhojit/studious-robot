import { AccessibilityInfo } from 'react-native';
import {
  announceForAccessibility,
  describeCallState,
  describeMessageDelivery,
  describeRecoveryState,
} from '../src/accessibilityAnnouncer';
import { CALL_STATES } from '../src/call/callStateMachine';

describe('describeRecoveryState', () => {
  test('names the start of a recovery episode', () => {
    expect(describeRecoveryState(true)).toBe('Connection lost, reconnecting');
  });

  test('names the end of one', () => {
    expect(describeRecoveryState(false)).toBe('Reconnected');
  });
});

describe('describeMessageDelivery', () => {
  test('announces a failed send, which is the one the user must act on', () => {
    expect(describeMessageDelivery('failed')).toBe('Message failed to send');
  });

  test('announces a completed send', () => {
    expect(describeMessageDelivery('sent')).toBe('Message sent');
  });

  test('says nothing for states that are still in progress or already implied', () => {
    expect(describeMessageDelivery('sending')).toBeNull();
    expect(describeMessageDelivery('delivered')).toBeNull();
    expect(describeMessageDelivery('read')).toBeNull();
    expect(describeMessageDelivery('unknown')).toBeNull();
  });
});

describe('describeCallState', () => {
  test('names the caller for an incoming call', () => {
    expect(describeCallState(CALL_STATES.INCOMING_RINGING, { callerId: 'alice' })).toBe(
      'Incoming call from alice',
    );
  });

  test('falls back to a generic caller when the id is missing', () => {
    expect(describeCallState(CALL_STATES.INCOMING_RINGING, {})).toBe(
      'Incoming call from unknown caller',
    );
  });

  test('names the callee for an outgoing call', () => {
    expect(describeCallState(CALL_STATES.OUTGOING_RINGING, { calleeId: 'bob' })).toBe(
      'Calling bob',
    );
  });

  test('announces connected and ended calls', () => {
    expect(describeCallState(CALL_STATES.IN_CALL)).toBe('Call connected');
    expect(describeCallState(CALL_STATES.ENDED)).toBe('Call ended');
  });

  test('says nothing while idle', () => {
    expect(describeCallState(CALL_STATES.IDLE)).toBeNull();
  });
});

describe('announceForAccessibility', () => {
  let spy: jest.SpyInstance;

  beforeEach(() => {
    spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation();
    spy.mockClear();
  });

  afterEach(() => jest.restoreAllMocks());

  test('forwards the message to the platform', () => {
    announceForAccessibility('Call connected');
    expect(spy).toHaveBeenCalledWith('Call connected');
  });

  test('ignores empty messages', () => {
    announceForAccessibility('');
    expect(spy).not.toHaveBeenCalled();
  });

  test('never throws when the platform announcement fails', () => {
    spy.mockImplementation(() => {
      throw new Error('no native module');
    });
    expect(() => announceForAccessibility('Call ended')).not.toThrow();
  });
});
