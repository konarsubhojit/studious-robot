import { AccessibilityInfo } from 'react-native';
import {
  announceForAccessibility,
  describeAppearanceChange,
  describeCallState,
  describeCallEnd,
  describeMessageDelivery,
  describeRecoveryState,
  describeRecoveryTransition,
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

describe('describeRecoveryTransition', () => {
  const idle = { isRecovering: false, isConnectionLost: false, attempts: 0 };
  const recovering = { isRecovering: true, isConnectionLost: false, attempts: 1 };

  test('announces the start and the end of an episode', () => {
    expect(describeRecoveryTransition(idle, recovering)).toBe('Connection lost, reconnecting');
    expect(describeRecoveryTransition(recovering, idle)).toBe('Reconnected');
  });

  test('announces later attempts, but not the first, which is already implied', () => {
    expect(describeRecoveryTransition(recovering, { ...recovering, attempts: 2 })).toBe(
      'Still reconnecting, attempt 2',
    );
    expect(describeRecoveryTransition(recovering, recovering)).toBeNull();
  });

  test('announces an exhausted ladder once', () => {
    const lost = { isRecovering: true, isConnectionLost: true, attempts: 3 };
    expect(describeRecoveryTransition(recovering, lost)).toBe(
      'Connection lost. The call could not be restored.',
    );
    expect(describeRecoveryTransition(lost, lost)).toBeNull();
  });

  test('says nothing while nothing is happening', () => {
    expect(describeRecoveryTransition(idle, idle)).toBeNull();
  });
});

describe('describeCallEnd', () => {
  test('reads the outcome and the duration in words, not as a clock time', () => {
    expect(
      describeCallEnd({ direction: 'outgoing', status: 'ended', durationSeconds: 65 }),
    ).toBe('Outgoing call, 1 minute 5 seconds');
  });

  test('drops the duration for a call that never connected', () => {
    expect(
      describeCallEnd({ direction: 'incoming', status: 'missed', durationSeconds: 0 }),
    ).toBe('Missed call');
  });

  test('names a lost connection rather than a plain ending', () => {
    expect(
      describeCallEnd({
        direction: 'outgoing',
        status: 'ended',
        endReason: 'media_failed',
        durationSeconds: 30,
      }),
    ).toBe('Connection lost, 30 seconds');
  });

  test('says nothing when there is no summary', () => {
    expect(describeCallEnd(null)).toBeNull();
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

describe('describeAppearanceChange', () => {
  test('names the setting and its new value', () => {
    expect(describeAppearanceChange('Accent colour', 'Teal')).toBe('Accent colour: Teal');
  });

  test('says nothing when either half is missing', () => {
    expect(describeAppearanceChange('', 'Teal')).toBeNull();
    expect(describeAppearanceChange('Accent colour', '')).toBeNull();
  });
});
