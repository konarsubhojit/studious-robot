import {
  SESSION_EXPIRED_MESSAGE,
  SESSION_REFRESH_FAILED_MESSAGE,
  SESSION_REFRESH_INTERVAL_MS,
  SESSION_REMINT_ATTEMPTS,
  SESSION_REMINT_RETRY_MS,
  parseCallStateReportAck,
  sessionRemintAttempts,
  shouldScheduleSessionRefresh,
  shouldTearDownAfterResync,
} from '../../src/call/sessionLifecycle';

/**
 * Phase 5, slice 2: the session/token rules and the post-reconnect
 * reconciliation that used to be reachable only by mounting `useCallFlow` and
 * driving a fake socket.
 */

describe('session rotation', () => {
  it('rotates well below a one-hour server TTL', () => {
    expect(SESSION_REFRESH_INTERVAL_MS).toBeLessThan(60 * 60 * 1000);
  });

  it('arms the timer once there is an identity and somewhere to rotate against', () => {
    expect(
      shouldScheduleSessionRefresh({ userId: 'alice', signalingUrl: 'http://x' }),
    ).toBe(true);
  });

  it.each([
    ['', 'http://x'],
    ['   ', 'http://x'],
    ['alice', ''],
    ['alice', '  '],
  ])('does not arm the timer for userId %p and url %p', (userId, signalingUrl) => {
    expect(shouldScheduleSessionRefresh({ userId, signalingUrl })).toBe(false);
  });

  it('has distinct messages for a failed rotation and an expired session', () => {
    expect(SESSION_REFRESH_FAILED_MESSAGE).not.toEqual(SESSION_EXPIRED_MESSAGE);
  });
});

describe('session re-mint budget', () => {
  it('retries mid-call, because losing the session means losing the call', () => {
    expect(sessionRemintAttempts(true)).toBe(SESSION_REMINT_ATTEMPTS);
    expect(SESSION_REMINT_ATTEMPTS).toBeGreaterThan(1);
  });

  it('tries exactly once when idle', () => {
    expect(sessionRemintAttempts(false)).toBe(1);
  });

  it('waits between attempts', () => {
    expect(SESSION_REMINT_RETRY_MS).toBeGreaterThan(0);
  });
});

describe('call.state.report ack', () => {
  it('is nothing at all when the server did not accept it', () => {
    expect(parseCallStateReportAck(undefined)).toBeNull();
    expect(parseCallStateReportAck(null)).toBeNull();
    expect(parseCallStateReportAck({ ok: false, error: 'nope' })).toBeNull();
  });

  it('reads cleared calls and the server\'s own calls', () => {
    expect(
      parseCallStateReportAck({
        ok: true,
        clearedCallIds: ['c1'],
        activeCalls: [{ callId: 'c2' }, { callId: 'c3' }],
      }),
    ).toEqual({ clearedCallIds: ['c1'], activeCallIds: ['c2', 'c3'] });
  });

  it('reports null — not [] — when the server described no calls at all', () => {
    expect(parseCallStateReportAck({ ok: true })).toEqual({
      clearedCallIds: [],
      activeCallIds: null,
    });
  });

  it('distinguishes an empty list from an absent one', () => {
    expect(parseCallStateReportAck({ ok: true, activeCalls: [] })?.activeCallIds).toEqual(
      [],
    );
  });

  it('drops entries with no callId', () => {
    expect(
      parseCallStateReportAck({
        ok: true,
        activeCalls: [{ callId: 'c1' }, {}, null],
      })?.activeCallIds,
    ).toEqual(['c1']);
  });
});

describe('post-reconnect reconciliation', () => {
  it('tears down a call the server explicitly cleared', () => {
    expect(
      shouldTearDownAfterResync({
        currentCallId: 'c1',
        clearedCallIds: ['c1'],
        activeCallIds: null,
      }),
    ).toBe(true);
  });

  it('tears down a call the server omitted from the calls it described', () => {
    expect(
      shouldTearDownAfterResync({
        currentCallId: 'c1',
        clearedCallIds: [],
        activeCallIds: ['c2'],
      }),
    ).toBe(true);
  });

  it('keeps a call the server still holds', () => {
    expect(
      shouldTearDownAfterResync({
        currentCallId: 'c1',
        clearedCallIds: [],
        activeCallIds: ['c1'],
      }),
    ).toBe(false);
  });

  it('never reads silence as "the call is gone"', () => {
    expect(
      shouldTearDownAfterResync({
        currentCallId: 'c1',
        clearedCallIds: [],
        activeCallIds: null,
      }),
    ).toBe(false);
  });

  it('has nothing to tear down without a call', () => {
    expect(
      shouldTearDownAfterResync({
        currentCallId: null,
        clearedCallIds: ['c1'],
        activeCallIds: [],
      }),
    ).toBe(false);
  });
});
