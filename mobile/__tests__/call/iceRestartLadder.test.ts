import {
  ICE_RESTART_BACKOFF_MAX_MS,
  ICE_RESTART_PRECONDITION_RETRY_MS,
  ICE_RESTART_TIEBREAK_MS,
  canReuseIceServers,
  decideFetchedIceServers,
  decideIceConnectionState,
  decideLadderRun,
  decideLadderSchedule,
  decideRecoveryExhausted,
  iceRestartBackoffMs,
  iceRestartTiebreakMs,
  isRecoveredIceState,
} from '../../src/call/iceRestartLadder';
import type { EpisodeView } from '../../src/call/iceRestartLadder';

/**
 * The ICE-recovery ladder was previously reachable only by mounting
 * `useCallFlow` and driving a fake peer connection, which is why its glare
 * tie-break, its backoff sequence and its TURN-less path had no direct tests.
 * These are those tests.
 */

/** An episode that is open, running and still has budget. */
const RUNNING: EpisodeView = {
  isOpen: true,
  isPaused: false,
  pauseReason: null,
  hasExpired: false,
};

function schedule(overrides: Partial<Parameters<typeof decideLadderSchedule>[0]> = {}) {
  return decideLadderSchedule({
    trigger: 'ice-failure',
    hasActiveCall: true,
    isPending: false,
    attempt: 0,
    episode: RUNNING,
    localUserId: 'alice',
    remoteUserId: 'bob',
    ...overrides,
  });
}

function run(overrides: Partial<Parameters<typeof decideLadderRun>[0]> = {}) {
  return decideLadderRun({
    trigger: 'ice-failure',
    hasActiveCall: true,
    attempt: 1,
    iceState: 'failed',
    socketConnected: true,
    isNegotiating: false,
    ...overrides,
  });
}

describe('iceRestartBackoffMs', () => {
  test.each([
    [0, 0],
    [1, 0],
    [2, 1500],
    [3, 3000],
    [4, 6000],
    [5, ICE_RESTART_BACKOFF_MAX_MS],
    [12, ICE_RESTART_BACKOFF_MAX_MS],
  ])('rung %i waits %ims', (attempt, expected) => {
    expect(iceRestartBackoffMs(attempt)).toBe(expected);
  });
});

describe('the userId tie-break', () => {
  test.each([
    ['lower id restarts immediately', 'alice', 'bob', 0],
    ['higher id waits out the glare window', 'bob', 'alice', ICE_RESTART_TIEBREAK_MS],
    ['whitespace is not part of the comparison', ' alice ', 'bob', 0],
    ['no remote id means no glare risk', 'alice', null, 0],
    ['no local id means no glare risk', '', 'bob', 0],
    ['identical ids cannot glare with themselves', 'alice', 'alice', 0],
  ])('%s', (_name, local, remote, expected) => {
    expect(iceRestartTiebreakMs(local, remote)).toBe(expected);
  });
});

describe('decideLadderSchedule', () => {
  test.each(['ice-failure', 'socket-reconnect', 'network-change'] as const)(
    '%s schedules its first rung immediately for the lower userId',
    trigger => {
      expect(schedule({ trigger })).toEqual({
        action: 'schedule',
        attempt: 1,
        consumeAttempt: true,
        backoffMs: 0,
        tiebreakMs: 0,
        delayMs: 0,
      });
    },
  );

  test('the ladder climbs its backoff, one rung per scheduled attempt', () => {
    const delays = [0, 1, 2, 3, 4].map(attempt => {
      const decision = schedule({ attempt });
      if (decision.action !== 'schedule') throw new Error('expected a scheduled rung');
      return decision.delayMs;
    });
    expect(delays).toEqual([0, 1500, 3000, 6000, ICE_RESTART_BACKOFF_MAX_MS]);
  });

  test('the losing side of the tie-break adds the glare delay to every rung', () => {
    expect(schedule({ localUserId: 'bob', remoteUserId: 'alice', attempt: 2 })).toMatchObject({
      backoffMs: 3000,
      tiebreakMs: ICE_RESTART_TIEBREAK_MS,
      delayMs: 3000 + ICE_RESTART_TIEBREAK_MS,
    });
  });

  test('a precondition retry costs no rung and uses the flat retry delay', () => {
    expect(schedule({ attempt: 3, consumeAttempt: false })).toEqual({
      action: 'schedule',
      attempt: 3,
      consumeAttempt: false,
      backoffMs: ICE_RESTART_PRECONDITION_RETRY_MS,
      tiebreakMs: 0,
      delayMs: ICE_RESTART_PRECONDITION_RETRY_MS,
    });
  });

  test.each([
    ['no call to restart', { hasActiveCall: false }, 'no-active-call'],
    ['a rung is already queued', { isPending: true }, 'already-pending'],
    [
      'the budget is spent',
      { episode: { ...RUNNING, hasExpired: true } },
      'budget-spent',
    ],
  ])('skips because %s', (_name, overrides, reason) => {
    expect(schedule(overrides)).toMatchObject({ action: 'skip', reason });
  });

  test('a paused episode defers rather than burning CPU on a dead interface', () => {
    expect(
      schedule({
        episode: { ...RUNNING, isPaused: true, pauseReason: 'socket-offline' },
      }),
    ).toEqual({ action: 'skip', reason: 'paused', pauseReason: 'socket-offline' });
  });

  test('an expired episode that is not open cannot block the first rung', () => {
    expect(
      schedule({
        episode: { isOpen: false, isPaused: true, pauseReason: null, hasExpired: true },
      }),
    ).toMatchObject({ action: 'schedule', attempt: 1 });
  });
});

describe('decideLadderRun', () => {
  test('restarts when the socket is up and nothing else is negotiating', () => {
    expect(run()).toEqual({ action: 'restart' });
  });

  test.each(['connected', 'completed'])('aborts once ICE reports %s', iceState => {
    expect(run({ iceState })).toEqual({ action: 'abort', reason: 'recovered' });
  });

  test('aborts when the call went away under the timer', () => {
    expect(run({ hasActiveCall: false })).toEqual({
      action: 'abort',
      reason: 'no-active-call',
    });
  });

  test('the first network-change rung runs before ICE notices the old path died', () => {
    expect(run({ trigger: 'network-change', attempt: 1, iceState: 'connected' })).toEqual({
      action: 'restart',
    });
    // Later rungs are no longer proactive: a healthy connection ends the ladder.
    expect(run({ trigger: 'network-change', attempt: 2, iceState: 'connected' })).toEqual({
      action: 'abort',
      reason: 'recovered',
    });
  });

  test.each([
    ['an offline socket', { socketConnected: false }, 'socket-offline'],
    ['an in-flight negotiation', { isNegotiating: true }, 'negotiating'],
  ])('defers on %s, which clears on its own', (_name, overrides, reason) => {
    expect(run(overrides)).toEqual({ action: 'defer', reason });
  });
});

describe('the TURN-less path', () => {
  test('a cached list is only reused while it still carries a relay', () => {
    expect(canReuseIceServers(true)).toBe(true);
    expect(canReuseIceServers(false)).toBe(false);
    expect(canReuseIceServers(null)).toBe(false);
  });

  test.each([
    ['a relay is present', true, false, 'cache-and-use'],
    ['the first fetch had no relay', false, false, 'refetch'],
    ['the re-fetch still had no relay', false, true, 'use-without-turn'],
    ['the re-fetch found a relay', true, true, 'cache-and-use'],
  ])('%s', (_name, hasTurn, isRefetch, expected) => {
    expect(decideFetchedIceServers(hasTurn, isRefetch)).toBe(expected);
  });
});

describe('decideRecoveryExhausted', () => {
  test.each(['connected', 'completed'])(
    'media that came back in the last moment closes the episode as recovered (%s)',
    iceState => {
      expect(
        decideRecoveryExhausted({ iceState, socketConnected: true, worstIceState: 'failed' }),
      ).toEqual({ action: 'close', outcome: 'recovered' });
    },
  );

  test('a failure is never reported over a dead socket, where it would be queued', () => {
    expect(
      decideRecoveryExhausted({
        iceState: 'failed',
        socketConnected: false,
        worstIceState: 'failed',
      }),
    ).toEqual({ action: 'skip-report', reason: 'offline' });
  });

  test.each([
    ['failed', 'failed'],
    ['disconnected', 'disconnected'],
    ['checking', 'disconnected'],
  ])('reports the worst state seen (%s) as %s', (worstIceState, expected) => {
    expect(
      decideRecoveryExhausted({ iceState: 'failed', socketConnected: true, worstIceState }),
    ).toEqual({ action: 'report-failure', iceState: expected });
  });
});

describe('decideIceConnectionState', () => {
  test.each(['connected', 'completed'])('%s clears the ladder', state => {
    expect(decideIceConnectionState(state)).toEqual({ action: 'recovered' });
    expect(isRecoveredIceState(state)).toBe(true);
  });

  test('a dip records the symptom but does not restart on its own', () => {
    expect(decideIceConnectionState('disconnected')).toEqual({
      action: 'symptom',
      trigger: 'ice-disconnected',
      restart: false,
    });
  });

  test('a failure records the symptom and starts a ladder', () => {
    expect(decideIceConnectionState('failed')).toEqual({
      action: 'symptom',
      trigger: 'ice-failure',
      restart: true,
    });
  });

  test.each(['new', 'checking', 'closed', null, undefined])('%s is ignored', state => {
    expect(decideIceConnectionState(state)).toEqual({ action: 'ignore' });
  });
});
