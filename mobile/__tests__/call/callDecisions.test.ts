import {
  ANSWERED_CALL_HISTORY_LIMIT,
  buildCallEndSummary,
  callDurationSeconds,
  classifyCallDelivery,
  decideAcceptIncomingCall,
  decideIncomingOffer,
  isLiveCallStatus,
  isMissedCall,
  isTerminalCallStatus,
  isTerminalIceState,
  rememberAnsweredCallId,
  resolveCallEndReason,
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
