import { createRecoveryEpisode } from '../../src/call/recoveryEpisode';
import { CALL_RECOVERY_BUDGET_MS, CALL_RECOVERY_MAX_EPISODE_MS } from '../../../shared';

/**
 * The behaviour these tests pin down is the reason a call used to die on a
 * Wi-Fi⇄cellular handoff: the old fuse latched on the first ICE dip, could
 * never be extended by the network change that followed, and kept running
 * through the offline window in which no recovery attempt was even possible.
 */

/** A controllable clock, so a 30s budget takes no wall-clock time to test. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('recoveryEpisode', () => {
  test('the first symptom opens an episode with the full budget', () => {
    const clock = fakeClock();
    const episode = createRecoveryEpisode({ now: clock.now });

    expect(episode.isOpen()).toBe(false);
    expect(episode.note('ice-disconnected')).toBe('opened');
    expect(episode.isOpen()).toBe(true);
    expect(episode.remainingMs()).toBe(CALL_RECOVERY_BUDGET_MS);
    expect(episode.snapshot()?.trigger).toBe('ice-disconnected');
  });

  test('a repeated ICE symptom is the same outage, so it buys no more time', () => {
    const clock = fakeClock();
    const episode = createRecoveryEpisode({ now: clock.now });

    episode.note('ice-disconnected');
    clock.advance(5_000);
    expect(episode.note('ice-failure')).toBe('ignored');
    expect(episode.note('ice-disconnected')).toBe('ignored');
    expect(episode.remainingMs()).toBe(CALL_RECOVERY_BUDGET_MS - 5_000);
    expect(episode.snapshot()?.extensions).toBe(0);
  });

  test('a genuine network change extends the episode instead of being swallowed', () => {
    const clock = fakeClock();
    const episode = createRecoveryEpisode({ now: clock.now });

    episode.note('ice-disconnected');
    clock.advance(20_000);
    expect(episode.remainingMs()).toBe(CALL_RECOVERY_BUDGET_MS - 20_000);

    // The handoff completes: recovery is newly possible, so the clock restarts.
    expect(episode.note('network-change')).toBe('extended');
    expect(episode.remainingMs()).toBe(CALL_RECOVERY_BUDGET_MS);
    expect(episode.snapshot()?.extensions).toBe(1);
  });

  test('extensions are bounded, so a flapping interface cannot keep a dead call alive', () => {
    const clock = fakeClock();
    const episode = createRecoveryEpisode({ now: clock.now });

    episode.note('socket-disconnect');
    for (let elapsed = 0; elapsed < CALL_RECOVERY_MAX_EPISODE_MS * 2; elapsed += 5_000) {
      clock.advance(5_000);
      episode.note('network-change');
    }

    expect(episode.remainingMs()).toBe(0);
    expect(episode.hasExpired()).toBe(true);
  });

  test('the budget is frozen while recovery is impossible', () => {
    const clock = fakeClock();
    const episode = createRecoveryEpisode({ now: clock.now });

    episode.note('ice-disconnected');
    clock.advance(4_000);
    expect(episode.pause('no-connectivity')).toBe(true);
    expect(episode.isPaused()).toBe(true);

    // A long offline window: under the old latched timer this alone would have
    // burned the whole grace period and ended the call.
    clock.advance(CALL_RECOVERY_BUDGET_MS * 2);
    expect(episode.remainingMs()).toBe(CALL_RECOVERY_BUDGET_MS - 4_000);
    expect(episode.hasExpired()).toBe(false);

    expect(episode.resume()).toBe(true);
    expect(episode.isPaused()).toBe(false);
    expect(episode.remainingMs()).toBe(CALL_RECOVERY_BUDGET_MS - 4_000);

    clock.advance(1_000);
    expect(episode.remainingMs()).toBe(CALL_RECOVERY_BUDGET_MS - 5_000);
    expect(episode.snapshot()?.pausedMs).toBe(CALL_RECOVERY_BUDGET_MS * 2);
  });

  test('pausing and resuming are idempotent', () => {
    const clock = fakeClock();
    const episode = createRecoveryEpisode({ now: clock.now });

    expect(episode.pause('socket-offline')).toBe(false);
    expect(episode.resume()).toBe(false);

    episode.note('socket-disconnect');
    expect(episode.pause('socket-offline')).toBe(true);
    expect(episode.pause('no-connectivity')).toBe(false);
    expect(episode.snapshot()?.pauseReason).toBe('socket-offline');
    expect(episode.resume()).toBe(true);
    expect(episode.resume()).toBe(false);
  });

  test('the budget expires only once it has actually been spent', () => {
    const clock = fakeClock();
    const episode = createRecoveryEpisode({ now: clock.now, budgetMs: 30_000 });

    episode.note('ice-failure');
    clock.advance(29_999);
    expect(episode.hasExpired()).toBe(false);
    clock.advance(1);
    expect(episode.hasExpired()).toBe(true);
    expect(episode.remainingMs()).toBe(0);
  });

  test('closing reports one correlated summary and re-arms for the next outage', () => {
    const clock = fakeClock();
    const episode = createRecoveryEpisode({ now: clock.now });

    expect(episode.close('recovered')).toBeNull();

    episode.note('network-change');
    expect(episode.recordAttempt()).toBe(1);
    expect(episode.recordAttempt()).toBe(2);
    episode.pause('no-connectivity');
    clock.advance(3_000);
    episode.resume();
    clock.advance(2_000);

    const summary = episode.close('recovered');
    expect(summary).toMatchObject({
      trigger: 'network-change',
      outcome: 'recovered',
      attempts: 2,
      pausedMs: 3_000,
      elapsedMs: 5_000,
    });

    expect(episode.isOpen()).toBe(false);
    expect(episode.attemptCount()).toBe(0);
    expect(episode.hasExpired()).toBe(false);
    expect(episode.note('ice-disconnected')).toBe('opened');
  });
});
