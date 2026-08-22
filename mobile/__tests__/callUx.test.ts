// @ts-check
import {
  clamp,
  formatCallDuration,
  formatRingCountdown,
  getConnectionQuality,
} from '../src/callUx';

describe('callUx', () => {
  test('formats elapsed call duration', () => {
    expect(formatCallDuration(0)).toBe('00:00');
    expect(formatCallDuration(75)).toBe('01:15');
    expect(formatCallDuration(3671)).toBe('01:01:11');
  });

  test('formats the ring countdown as m:ss once past a minute', () => {
    // The ring window is two minutes, so "117s" would read as noise.
    expect(formatRingCountdown(120)).toBe('2:00');
    expect(formatRingCountdown(117)).toBe('1:57');
    expect(formatRingCountdown(60)).toBe('1:00');
    expect(formatRingCountdown(59)).toBe('59s');
    expect(formatRingCountdown(0)).toBe('0s');
    expect(formatRingCountdown(-5)).toBe('0s');
  });

  test('clamps draggable PiP coordinates to stage bounds', () => {
    expect(clamp(2, 12, 88)).toBe(12);
    expect(clamp(24, 12, 88)).toBe(24);
    expect(clamp(120, 12, 88)).toBe(88);
  });

  test('maps network metrics to signal quality bars', () => {
    expect(getConnectionQuality({})).toEqual({ bars: 0, label: 'No link' });
    expect(getConnectionQuality({ rttMs: 120, packetLossRatio: 0.01, bitrateKbps: 900 })).toEqual({
      bars: 3,
      label: 'Strong',
    });
    expect(getConnectionQuality({ rttMs: 390, packetLossRatio: 0.02, bitrateKbps: 600 })).toEqual({
      bars: 1,
      label: 'Weak',
    });
    expect(getConnectionQuality({ rttMs: 700, packetLossRatio: 0.14, bitrateKbps: 80 })).toEqual({
      bars: 0,
      label: 'Poor',
    });
  });
});
