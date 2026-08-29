const mockStart = jest.fn();
const mockStop = jest.fn();

jest.mock('react-native-incall-manager', () => ({
  __esModule: true,
  default: { start: mockStart, stop: mockStop },
}));

const mockShouldRingAudibly = jest.fn();

jest.mock('../src/ringerMode', () => ({
  shouldRingAudibly: (...args: any[]) => mockShouldRingAudibly(...args),
}));

import * as ringtone from '../src/ringtone';
import {
  _resetRingtoneCache,
  startIncomingRingtone,
  stopIncomingRingtone,
} from '../src/ringtone';

describe('ringtone', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetRingtoneCache();
    mockShouldRingAudibly.mockResolvedValue(true);
  });

  test('rings when the device ringer is not silenced', async () => {
    await expect(startIncomingRingtone()).resolves.toBe(true);
    expect(mockStart).toHaveBeenCalledWith({ media: false, ringback: '_BUNDLE_' });
  });

  test('stays quiet when the device ringer is silenced', async () => {
    mockShouldRingAudibly.mockResolvedValue(false);

    await expect(startIncomingRingtone()).resolves.toBe(false);
    expect(mockStart).not.toHaveBeenCalled();
  });

  test('is idempotent while already ringing', async () => {
    await startIncomingRingtone();
    await startIncomingRingtone();

    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  test('does not ring when the call was answered while the ringer was read', async () => {
    let resolveRingerState: (value: boolean) => void = () => {};
    mockShouldRingAudibly.mockReturnValue(
      new Promise<boolean>(resolve => {
        resolveRingerState = resolve;
      }),
    );

    const started = startIncomingRingtone();
    stopIncomingRingtone();
    resolveRingerState(true);

    await expect(started).resolves.toBe(false);
    expect(mockStart).not.toHaveBeenCalled();
  });

  test('stopping is safe when nothing is playing', () => {
    expect(() => stopIncomingRingtone()).not.toThrow();
    expect(mockStop).not.toHaveBeenCalled();
  });

  test('stops the ringtone it started', async () => {
    await startIncomingRingtone();
    stopIncomingRingtone();
    stopIncomingRingtone();

    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  test('never rings on the caller side', () => {
    // Callers get no ringback: placing a call must stay silent, and must not
    // take over the audio session before the call is connected.
    expect(ringtone).not.toHaveProperty('startOutgoingRingback');
    expect(ringtone).not.toHaveProperty('stopOutgoingRingback');
  });
});
