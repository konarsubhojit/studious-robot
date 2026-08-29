import { AccessibilityInfo, Vibration } from 'react-native';
import {
  areHapticsSuppressed,
  HAPTIC_PATTERNS,
  resetHapticsForTests,
  setHapticsEnabled,
  triggerHaptic,
} from '../src/haptics';

describe('haptics', () => {
  let vibrateSpy: jest.SpyInstance;

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
    expect(triggerHaptic(('nope' as any))).toBe(false);
    expect(vibrateSpy).not.toHaveBeenCalled();
  });

  test('never throws when the platform vibration API fails', () => {
    vibrateSpy.mockImplementation(() => {
      throw new Error('no vibrator');
    });
    expect(triggerHaptic('tap')).toBe(false);
  });

  test('is on until the user says otherwise', () => {
    // The settings load is asynchronous; a control tapped before it resolves
    // should still answer.
    expect(areHapticsSuppressed()).toBe(false);
    expect(triggerHaptic('tap')).toBe(true);
  });

  test('the user preference silences and restores haptics', () => {
    setHapticsEnabled(false);
    expect(areHapticsSuppressed()).toBe(true);
    expect(triggerHaptic('end')).toBe(false);
    expect(vibrateSpy).not.toHaveBeenCalled();

    setHapticsEnabled(true);
    expect(areHapticsSuppressed()).toBe(false);
    expect(triggerHaptic('end')).toBe(true);
  });

  test('reduced motion no longer silences haptics', () => {
    // Reduce motion asks for less *animation*. A vibration is not motion on
    // screen, and for some users it is the only confirmation that a tap
    // registered, so the two preferences are now separate: this module never
    // consults the OS accessibility settings at all.
    const isReduceMotionEnabled = jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(true);

    expect(triggerHaptic('tap')).toBe(true);
    expect(isReduceMotionEnabled).not.toHaveBeenCalled();
  });
});
