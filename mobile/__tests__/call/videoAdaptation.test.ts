import {
  INITIAL_VIDEO_ADAPTATION,
  nextVideoAdaptation,
} from '../../src/call/videoAdaptation';
import type { VideoAdaptationState } from '../../src/call/videoAdaptation';

describe('nextVideoAdaptation', () => {
  test('requires sustained degradation and then respects its cooldown', () => {
    const first = nextVideoAdaptation(INITIAL_VIDEO_ADAPTATION, {
      bars: 0, dataSaverEnabled: false, isScreenSharing: false, nowMs: 0,
    });
    expect(first.level).toBe('standard');
    const degraded = nextVideoAdaptation(first, {
      bars: 0, dataSaverEnabled: false, isScreenSharing: false, nowMs: 7000,
    });
    expect(degraded.level).toBe('minimal');
    expect(nextVideoAdaptation(degraded, {
      bars: 3, dataSaverEnabled: false, isScreenSharing: false, nowMs: 14_000,
    }).level).toBe('minimal');
  });

  test('requires sustained recovery and never changes a screen share', () => {
    const minimal = { ...INITIAL_VIDEO_ADAPTATION, level: 'minimal' as const, changedAtMs: 0 };
    const afterRecovery = [28_000, 35_000, 42_000].reduce<VideoAdaptationState>(
      (state, nowMs) => nextVideoAdaptation(state, {
        bars: 3, dataSaverEnabled: false, isScreenSharing: false, nowMs,
      }),
      minimal,
    );
    expect(afterRecovery.level).toBe('standard');
    expect(nextVideoAdaptation(minimal, {
      bars: 3, dataSaverEnabled: false, isScreenSharing: true, nowMs: 50_000,
    })).toBe(minimal);
  });

  test('starts data saver at the constrained level after sustained samples', () => {
    const first = nextVideoAdaptation(INITIAL_VIDEO_ADAPTATION, {
      bars: 3, dataSaverEnabled: true, isScreenSharing: false, nowMs: 0,
    });
    expect(nextVideoAdaptation(first, {
      bars: 3, dataSaverEnabled: true, isScreenSharing: false, nowMs: 7000,
    }).level).toBe('constrained');
  });
});
