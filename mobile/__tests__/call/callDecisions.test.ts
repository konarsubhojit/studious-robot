import {
  ANSWERED_CALL_HISTORY_LIMIT,
  buildCallEndSummary,
  callDurationSeconds,
  callOwnerDeviceId,
  callPeerId,
  classifyCallDelivery,
  decideAcceptIncomingCall,
  decideIncomingOffer,
  describeCallOnAnotherDevice,
  describeCallStateEnding,
  describeDialBlocked,
  isCallOwnedByAnotherDevice,
  isLiveCallStatus,
  isStateChangeForOtherCall,
  isMissedCall,
  isTerminalCallStatus,
  isTerminalIceState,
  rememberAnsweredCallId,
  resolveCallEndReason,
  resolveOutgoingCallee,
  resolveKnownCallId,
  shouldReportEmptyCallState,
  shouldResetReplayGuard,
  shouldSummariseCall,
} from '../../src/call/callDecisions';

/**
 * Phase 5, slice 1: the call-lifecycle rules that used to be inline in
 * `useCallFlow` and were therefore only reachable by mounting the hook. These
 * are their direct tests.
 */

describe('call status classification', () => {
  it.each(['accepted', 'connecting_media', 'in_call'])(
    'treats %s as a live call an accept failure must not tear down',
    status => {
      expect(isLiveCallStatus(status)).toBe(true);
    },
  );

  it.each(['ringing', 'ended', 'missed', null, undefined, ''])(
    'does not treat %s as live',
    status => {
      expect(isLiveCallStatus(status)).toBe(false);
    },
  );

  it.each(['ended', 'declined', 'missed', 'busy', 'unreachable'])(
    'treats %s as terminal, so the OS notification goes with it',
    status => {
      expect(isTerminalCallStatus(status)).toBe(true);
    },
  );

  it.each(['ringing', 'accepted', 'in_call', null, undefined])(
    'does not treat %s as terminal',
    status => {
      expect(isTerminalCallStatus(status)).toBe(false);
    },
  );
});

describe('terminal ICE states', () => {
  it.each(['disconnected', 'failed'])('reads %s as "this call is over"', state => {
    expect(isTerminalIceState(state)).toBe(true);
  });

  it.each([['connected'], ['checking'], [null], [undefined], [42], [{}]])(
    'reads %p as not terminal',
    value => {
      expect(isTerminalIceState(value)).toBe(false);
    },
  );
});

describe('delivery classification', () => {
  it('reports a push wake as push', () => {
    expect(classifyCallDelivery('push')).toBe('push');
  });

  it.each([['ringing'], [undefined], [null], ['anything-else']])(
    'treats %p as a live device ringing',
    delivery => {
      expect(classifyCallDelivery(delivery)).toBe('ringing');
    },
  );
});

describe('answered-call history', () => {
  it('remembers a new callId', () => {
    expect(rememberAnsweredCallId([], 'a')).toEqual(['a']);
  });

  it('never records the same callId twice', () => {
    expect(rememberAnsweredCallId(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });

  it('does not mutate the history it was given', () => {
    const history = ['a'];
    rememberAnsweredCallId(history, 'b');
    expect(history).toEqual(['a']);
  });

  it('is bounded, dropping the oldest entry', () => {
    let history: string[] = [];
    for (let i = 0; i < ANSWERED_CALL_HISTORY_LIMIT + 5; i += 1) {
      history = rememberAnsweredCallId(history, `call-${i}`);
    }
    expect(history).toHaveLength(ANSWERED_CALL_HISTORY_LIMIT);
    expect(history[0]).toBe('call-5');
    expect(history[history.length - 1]).toBe(
      `call-${ANSWERED_CALL_HISTORY_LIMIT + 4}`,
    );
  });

  it('empties the replay guard only once it reaches the bound', () => {
    expect(shouldResetReplayGuard(ANSWERED_CALL_HISTORY_LIMIT - 1)).toBe(false);
    expect(shouldResetReplayGuard(ANSWERED_CALL_HISTORY_LIMIT)).toBe(true);
  });
});

describe('incoming offer', () => {
  it('answers an offer for the active call', () => {
    expect(
      decideIncomingOffer({ callId: 'c1', activeCallId: 'c1', isNegotiating: false }),
    ).toBe('negotiate');
  });

  it('ignores an offer for a call this device is not in', () => {
    expect(
      decideIncomingOffer({ callId: 'c2', activeCallId: 'c1', isNegotiating: false }),
    ).toBe('ignore-unknown-call');
  });

  it('ignores a concurrent offer as glare', () => {
    expect(
      decideIncomingOffer({ callId: 'c1', activeCallId: 'c1', isNegotiating: true }),
    ).toBe('ignore-glare');
  });

  it('treats an offer with no active call as unknown, not as glare', () => {
    expect(
      decideIncomingOffer({ callId: 'c1', activeCallId: null, isNegotiating: true }),
    ).toBe('ignore-unknown-call');
  });
});

describe('duplicate-accept suppression', () => {
  const base = {
    callId: 'c1',
    status: 'ringing',
    acceptInFlightCallId: null,
    answeredCallIds: [] as string[],
  };

  it('accepts a ringing call nothing else is answering', () => {
    expect(decideAcceptIncomingCall(base)).toEqual({ action: 'accept' });
  });

  it('skips a tap while an accept for the same call is in flight', () => {
    expect(
      decideAcceptIncomingCall({ ...base, acceptInFlightCallId: 'c1' }),
    ).toEqual({ action: 'skip', reason: 'accept_in_flight' });
  });

  it('skips a call already answered', () => {
    expect(
      decideAcceptIncomingCall({ ...base, answeredCallIds: ['c0', 'c1'] }),
    ).toEqual({ action: 'skip', reason: 'already_accepted' });
  });

  it('dismisses a tap for a call that stopped ringing', () => {
    expect(decideAcceptIncomingCall({ ...base, status: 'missed' })).toEqual({
      action: 'dismiss',
      reason: 'call_already_ended',
    });
  });

  it('accepts a call whose status the server has not reported', () => {
    expect(decideAcceptIncomingCall({ ...base, status: undefined })).toEqual({
      action: 'accept',
    });
  });

  it('prefers the in-flight reason over the stale-status one', () => {
    expect(
      decideAcceptIncomingCall({
        ...base,
        status: 'ended',
        acceptInFlightCallId: 'c1',
      }),
    ).toEqual({ action: 'skip', reason: 'accept_in_flight' });
  });

  it('does not suppress a different call', () => {
    expect(
      decideAcceptIncomingCall({
        ...base,
        acceptInFlightCallId: 'other',
        answeredCallIds: ['other'],
      }),
    ).toEqual({ action: 'accept' });
  });
});

describe('call duration', () => {
  it('is null for a call that never connected', () => {
    expect(callDurationSeconds(null, 10_000)).toBeNull();
  });

  it('floors to whole seconds', () => {
    expect(callDurationSeconds(1_000, 6_900)).toBe(5);
  });
});

describe('end-reason resolution', () => {
  it('outranks the wire reason when recovery was exhausted', () => {
    expect(
      resolveCallEndReason({
        isConnectionLost: true,
        requestedReason: 'ended',
        recordEndReason: 'ended',
      }),
    ).toBe('media_failed');
  });

  it('prefers the requested reason over the record', () => {
    expect(
      resolveCallEndReason({
        isConnectionLost: false,
        requestedReason: 'declined',
        recordEndReason: 'ended',
      }),
    ).toBe('declined');
  });

  it('falls back to the record, then to null', () => {
    expect(
      resolveCallEndReason({
        isConnectionLost: false,
        requestedReason: null,
        recordEndReason: 'busy',
      }),
    ).toBe('busy');
    expect(
      resolveCallEndReason({ isConnectionLost: false, requestedReason: null }),
    ).toBeNull();
  });
});

describe('end summary', () => {
  it('summarises every call that connected', () => {
    expect(shouldSummariseCall({ hasConnected: true, endReason: 'ended' })).toBe(true);
  });

  it.each(['media_failed', 'failed', 'missed', 'timeout', 'busy', 'unreachable'])(
    'summarises a call that never connected but ended as %s',
    endReason => {
      expect(shouldSummariseCall({ hasConnected: false, endReason })).toBe(true);
    },
  );

  it.each([['ended'], ['declined'], [null]])(
    'does not summarise a call the user cancelled (%p)',
    endReason => {
      expect(shouldSummariseCall({ hasConnected: false, endReason })).toBe(false);
    },
  );

  it('describes an outgoing call from the caller side', () => {
    expect(
      buildCallEndSummary({
        durationSeconds: 42,
        qualityLabel: 'Good',
        endReason: 'ended',
        isCaller: true,
        call: { status: 'ended', callerId: 'me', calleeId: 'them' },
      }),
    ).toEqual({
      durationSeconds: 42,
      quality: 'Good',
      endReason: 'ended',
      status: 'ended',
      direction: 'outgoing',
      peerId: 'them',
    });
  });

  it('describes an incoming call from the callee side', () => {
    expect(
      buildCallEndSummary({
        durationSeconds: null,
        endReason: 'missed',
        isCaller: false,
        call: { status: 'missed', callerId: 'them', calleeId: 'me' },
      }),
    ).toEqual({
      durationSeconds: null,
      quality: 'No link',
      endReason: 'missed',
      status: 'missed',
      direction: 'incoming',
      peerId: 'them',
    });
  });

  it('reports no link when quality was never measured, and no call record', () => {
    expect(
      buildCallEndSummary({
        durationSeconds: null,
        qualityLabel: '',
        endReason: null,
        isCaller: true,
        call: null,
      }),
    ).toEqual({
      durationSeconds: null,
      quality: 'No link',
      endReason: null,
      status: null,
      direction: 'outgoing',
      peerId: null,
    });
  });
});

describe('missed calls', () => {
  it.each(['missed', 'timeout'])('counts %s as missed', endReason => {
    expect(isMissedCall({ endReason, status: 'ended' })).toBe(true);
  });

  it('counts a missed status even when the reason says otherwise', () => {
    expect(isMissedCall({ endReason: 'ended', status: 'missed' })).toBe(true);
  });

  it('does not count an ordinary hangup', () => {
    expect(isMissedCall({ endReason: 'ended', status: 'ended' })).toBe(false);
    expect(isMissedCall({ endReason: null })).toBe(false);
  });
});

describe('call.state_changed dispatch', () => {
  it('prefers the active callId, then the active call, then the incoming one', () => {
    expect(
      resolveKnownCallId({
        activeCallId: 'active',
        activeCall: { callId: 'record' },
        incomingCall: { callId: 'incoming' },
      }),
    ).toBe('active');
    expect(
      resolveKnownCallId({
        activeCallId: null,
        activeCall: { callId: 'record' },
        incomingCall: { callId: 'incoming' },
      }),
    ).toBe('record');
    expect(
      resolveKnownCallId({ incomingCall: { callId: 'incoming' } }),
    ).toBe('incoming');
    expect(resolveKnownCallId({})).toBeNull();
  });

  it('suppresses a transition for a stale ring while another call is up', () => {
    expect(
      isStateChangeForOtherCall({ eventCallId: 'stale', knownCallId: 'live' }),
    ).toBe(true);
  });

  it('does not suppress a transition for the call in progress', () => {
    expect(
      isStateChangeForOtherCall({ eventCallId: 'live', knownCallId: 'live' }),
    ).toBe(false);
  });

  it.each([
    [null, 'live'],
    ['stale', null],
    [null, null],
  ])(
    'does not treat an unidentifiable transition (%p vs %p) as another call',
    (eventCallId, knownCallId) => {
      expect(isStateChangeForOtherCall({ eventCallId, knownCallId })).toBe(false);
    },
  );
});

describe('terminal transitions', () => {
  it.each([
    ['declined', 'Call declined', 'info', 'declined'],
    ['missed', 'Call not answered', 'error', 'missed'],
    ['busy', 'Callee is busy', 'error', 'busy'],
    ['unreachable', 'Callee is unreachable', 'error', 'unreachable'],
  ])('reports %s as "%s"', (status, message, severity, endReason) => {
    expect(describeCallStateEnding({ status })).toEqual({
      message,
      severity,
      endReason,
    });
  });

  it('calls a hang-up before the callee answered a cancellation', () => {
    expect(describeCallStateEnding({ status: 'ended', reason: 'cancelled' })).toEqual({
      message: 'Call cancelled',
      severity: 'info',
      endReason: 'cancelled',
    });
  });

  it('carries the server reason through an ordinary end', () => {
    expect(describeCallStateEnding({ status: 'ended', reason: 'peer_left' })).toEqual({
      message: 'Call ended',
      severity: 'info',
      endReason: 'peer_left',
    });
    expect(describeCallStateEnding({ status: 'ended' })?.endReason).toBe('ended');
  });

  it.each(['accepted', 'ringing', 'connecting_media', 'anything'])(
    'does not end the call for %s',
    status => {
      expect(describeCallStateEnding({ status })).toBeNull();
    },
  );
});

describe('busy self-heal', () => {
  it('reports an empty call state when this device holds nothing', () => {
    expect(
      shouldReportEmptyCallState({
        eventCallId: 'c1',
        activeCallId: null,
        incomingCallId: null,
      }),
    ).toBe(true);
  });

  it('does not count the call the rejection is about', () => {
    expect(
      shouldReportEmptyCallState({
        eventCallId: 'c1',
        activeCallId: 'c1',
        incomingCallId: null,
      }),
    ).toBe(true);
  });

  it.each([
    ['activeCallId', { activeCallId: 'other' }],
    ['incomingCallId', { incomingCallId: 'other' }],
  ])('stays quiet while this device holds a call via %s', (_label, held) => {
    expect(shouldReportEmptyCallState({ eventCallId: 'c1', ...held })).toBe(false);
  });
});

describe('resolveOutgoingCallee', () => {
  it('rings the contact that was tapped, not whatever is in the field', () => {
    expect(
      resolveOutgoingCallee({
        explicitCalleeId: 'bob',
        typedCalleeId: 'stale-entry',
        userId: 'alice',
      }),
    ).toEqual({ ok: true, calleeId: 'bob' });
  });

  it('falls back to the dial field when no contact was tapped', () => {
    expect(
      resolveOutgoingCallee({ typedCalleeId: '  bob  ', userId: 'alice' }),
    ).toEqual({ ok: true, calleeId: 'bob' });
  });

  it.each([
    ['a blank string', '   '],
    ['a non-string', 42],
    ['undefined', undefined],
  ])('treats %s as no explicit callee and uses the field', (_label, explicitCalleeId) => {
    expect(
      resolveOutgoingCallee({ explicitCalleeId, typedCalleeId: 'bob', userId: 'alice' }),
    ).toEqual({ ok: true, calleeId: 'bob' });
  });

  it.each([
    ['neither is set', { typedCalleeId: '', userId: 'alice' }],
    ['both are blank', { explicitCalleeId: '  ', typedCalleeId: '  ', userId: 'alice' }],
    ['there is no field at all', { userId: 'alice' }],
  ])('refuses to place a call when %s', (_label, input) => {
    expect(resolveOutgoingCallee(input)).toEqual({
      ok: false,
      message: 'Enter a callee ID to call',
    });
  });

  it.each([
    ['no userId', undefined],
    ['a blank userId', '   '],
    ['a null userId', null],
  ])('asks for an identity first when there is %s', (_label, userId) => {
    expect(resolveOutgoingCallee({ typedCalleeId: 'bob', userId })).toEqual({
      ok: false,
      message: 'Enter your user ID first',
    });
  });

  it('names the missing callee before the missing identity', () => {
    expect(resolveOutgoingCallee({})).toEqual({
      ok: false,
      message: 'Enter a callee ID to call',
    });
  });
});

/**
 * Multi-device ownership: every call event fans out to all of a user's
 * devices, so these rules are what stops an idle second device from acting on
 * — and ending — a call running on the first.
 */
describe('callPeerId', () => {
  it.each([
    ['the caller sees the callee', 'alice', 'bob'],
    ['the callee sees the caller', 'bob', 'alice'],
  ])('%s', (_label, userId, expected) => {
    expect(callPeerId({ callerId: 'alice', calleeId: 'bob' }, userId)).toBe(expected);
  });

  it.each([
    ['a bystander', 'carol'],
    ['no identity', undefined],
    ['a blank identity', '  '],
  ])('has no peer for %s', (_label, userId) => {
    expect(callPeerId({ callerId: 'alice', calleeId: 'bob' }, userId)).toBeNull();
  });
});

describe('callOwnerDeviceId', () => {
  const call = {
    callerId: 'alice',
    calleeId: 'bob',
    callerDeviceId: 'device-a',
    calleeDeviceId: 'device-b',
  };

  it.each([
    ['the caller reads their own device', 'alice', 'device-a'],
    ['the callee reads their own device', 'bob', 'device-b'],
  ])('%s', (_label, userId, expected) => {
    expect(callOwnerDeviceId(call, userId)).toBe(expected);
  });

  it('reports an unclaimed side as unknown rather than as a device', () => {
    expect(callOwnerDeviceId({ callerId: 'alice', calleeId: 'bob' }, 'bob')).toBeNull();
  });

  it('has no owner for a bystander', () => {
    expect(callOwnerDeviceId(call, 'carol')).toBeNull();
  });
});

describe('describeCallOnAnotherDevice', () => {
  const base = {
    callId: 'call-1',
    status: 'connecting_media',
    callerId: 'alice',
    calleeId: 'bob',
    callerDeviceId: 'device-a',
  };

  it("names the peer of a live call held by this user's other device", () => {
    expect(
      describeCallOnAnotherDevice({ call: base, userId: 'alice', deviceId: 'device-b' }),
    ).toEqual({ callId: 'call-1', peerId: 'bob', status: 'connecting_media' });
  });

  it.each([
    ['this device holds it', { call: base, userId: 'alice', deviceId: 'device-a' }],
    [
      'the owning device is unknown',
      {
        call: { ...base, callerDeviceId: null },
        userId: 'alice',
        deviceId: 'device-b',
      },
    ],
    [
      'the call is already over',
      { call: { ...base, status: 'ended' }, userId: 'alice', deviceId: 'device-b' },
    ],
    ['this user is not in it', { call: base, userId: 'carol', deviceId: 'device-c' }],
    ['there is no call', { call: null, userId: 'alice', deviceId: 'device-b' }],
    [
      'the call has no id',
      { call: { ...base, callId: '' }, userId: 'alice', deviceId: 'device-b' },
    ],
    [
      'the call has no status',
      { call: { ...base, status: '' }, userId: 'alice', deviceId: 'device-b' },
    ],
    ['this device has no id yet', { call: base, userId: 'alice', deviceId: null }],
  ])('is not another device\'s call when %s', (_label, input) => {
    expect(describeCallOnAnotherDevice(input)).toBeNull();
  });
});

describe('isCallOwnedByAnotherDevice', () => {
  const base = {
    callId: 'call-1',
    callerId: 'alice',
    calleeId: 'bob',
    callerDeviceId: 'device-a',
  };

  it.each([
    ['a live call', 'connecting_media'],
    ['a call that has already ended', 'ended'],
  ])("still recognises %s as another device's", (_label, status) => {
    expect(
      isCallOwnedByAnotherDevice({
        call: { ...base, status },
        userId: 'alice',
        deviceId: 'device-b',
      }),
    ).toBe(true);
  });

  it.each([
    ['this device owns it', { call: base, userId: 'alice', deviceId: 'device-a' }],
    [
      'no device has claimed it',
      { call: { ...base, callerDeviceId: null }, userId: 'alice', deviceId: 'device-b' },
    ],
    ['this user is not in it', { call: base, userId: 'carol', deviceId: 'device-c' }],
    ['there is no call', { call: null, userId: 'alice', deviceId: 'device-b' }],
    ['this device has no id yet', { call: base, userId: 'alice', deviceId: '' }],
  ])('is not another device\'s call when %s', (_label, input) => {
    expect(isCallOwnedByAnotherDevice(input)).toBe(false);
  });
});

describe('describeDialBlocked', () => {
  it('lets an idle device dial', () => {
    expect(describeDialBlocked({})).toBeNull();
  });

  it('sends the user to the incoming call before anything else', () => {
    expect(
      describeDialBlocked({
        incomingCall: { callId: 'call-in' },
        activeCall: { callId: 'call-live', status: 'connecting_media' },
        callElsewhere: { callId: 'call-far', peerId: 'bob', status: 'accepted' },
      }),
    ).toBe('Answer or decline the incoming call first');
  });

  it('refuses a second call from this device', () => {
    expect(
      describeDialBlocked({ activeCall: { callId: 'call-live', status: 'connecting_media' } }),
    ).toBe('End the current call before placing another');
  });

  it('names the peer when another device holds the call', () => {
    expect(
      describeDialBlocked({
        callElsewhere: { callId: 'call-far', peerId: 'bob', status: 'accepted' },
      }),
    ).toBe('You are in a call with bob on another device');
  });

  it('does not count a finished call as a call in progress', () => {
    expect(describeDialBlocked({ activeCall: { callId: 'call-old', status: 'ended' } })).toBeNull();
  });
});
