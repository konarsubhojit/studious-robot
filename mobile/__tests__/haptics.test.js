import { AccessibilityInfo, Vibration } from 'react-native';
import {
  areHapticsSuppressed,
  HAPTIC_PATTERNS,
  initHaptics,
  resetHapticsForTests,
  triggerHaptic,
} from '../src/haptics';

describe('haptics', () => {
  let vibrateSpy;

  beforeEach(() => {
    resetHapticsForTests();
    vibrateSpy = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    vibrateSpy.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetHapticsForTests();
  });

  test('fires the vibration duration mapped to the named pattern', () => {
    expect(triggerHaptic('answer')).toBe(true);
    expect(vibrateSpy).toHaveBeenCalledWith(HAPTIC_PATTERNS.answer);
  });

  test('ignores unknown patterns', () => {
    expect(triggerHaptic('nope')).toBe(false);
    expect(vibrateSpy).not.toHaveBeenCalled();
  });

  test('never throws when the platform vibration API fails', () => {
    vibrateSpy.mockImplementation(() => {
      throw new Error('no vibrator');
    });
    expect(triggerHaptic('tap')).toBe(false);
  });

  test('suppresses haptics while the OS asks for reduced motion', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => {} });

    const unsubscribe = initHaptics();
    await Promise.resolve();

    expect(areHapticsSuppressed()).toBe(true);
    expect(triggerHaptic('end')).toBe(false);
    expect(vibrateSpy).not.toHaveBeenCalled();

    unsubscribe();
  });

  test('reacts to later reduce-motion changes', async () => {
    let listener = null;
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((event, handler) => {
      if (event === 'reduceMotionChanged') listener = handler;
      return { remove: () => {} };
    });

    const unsubscribe = initHaptics();
    await Promise.resolve();

    expect(triggerHaptic('tap')).toBe(true);

    listener(true);
    expect(triggerHaptic('tap')).toBe(false);

    listener(false);
    expect(triggerHaptic('tap')).toBe(true);

    unsubscribe();
  });

  test('unsubscribing removes the accessibility listener', () => {
    const remove = jest.fn();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove });

    initHaptics()();

    expect(remove).toHaveBeenCalled();
  });
});
