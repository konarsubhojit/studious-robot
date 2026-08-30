/**
 * Direct tests for the audio-route rules.
 *
 * None of this mounts `useCallFlow`: the hand-over announced when a headset is
 * unplugged mid-call used to be reachable only by mounting the hook and
 * replaying a native device-change event.
 *
 * `audioRouting` is imported for its route vocabulary, so its two native
 * dependencies are stubbed exactly as its own suite stubs them.
 */

jest.mock('react-native-incall-manager', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  setForceSpeakerphoneOn: jest.fn(),
  setSpeakerphoneOn: jest.fn(),
  setKeepScreenOn: jest.fn(),
  chooseAudioRoute: jest.fn(),
}));

jest.mock('../../src/permissions', () => ({
  ensureBluetoothPermission: jest.fn(),
}));

import { AUDIO_ROUTES } from '../../src/audioRouting';
import {
  describeChosenRoute,
  describeDetachedManualRoute,
  mergeDiscoveredDevices,
  shouldUpgradeToSpeaker,
} from '../../src/call/audioRouteRules';

describe('shouldUpgradeToSpeaker', () => {
  it('upgrades the earpiece when the user asked for speaker on join', () => {
    expect(
      shouldUpgradeToSpeaker({
        routed: true,
        selected: AUDIO_ROUTES.EARPIECE,
        speakerEnabledByDefault: true,
      }),
    ).toBe(true);
  });

  it.each([AUDIO_ROUTES.BLUETOOTH, AUDIO_ROUTES.WIRED_HEADSET])(
    'never steals the call away from %s',
    selected => {
      expect(
        shouldUpgradeToSpeaker({ routed: true, selected, speakerEnabledByDefault: true }),
      ).toBe(false);
    },
  );

  it('leaves a call that is already on speaker alone', () => {
    expect(
      shouldUpgradeToSpeaker({
        routed: true,
        selected: AUDIO_ROUTES.SPEAKER_PHONE,
        speakerEnabledByDefault: true,
      }),
    ).toBe(false);
  });

  it('does nothing without the preference', () => {
    expect(
      shouldUpgradeToSpeaker({ routed: true, selected: AUDIO_ROUTES.EARPIECE }),
    ).toBe(false);
  });

  it('does not upgrade a route that was never applied', () => {
    expect(
      shouldUpgradeToSpeaker({
        routed: false,
        selected: AUDIO_ROUTES.EARPIECE,
        speakerEnabledByDefault: true,
      }),
    ).toBe(false);
  });
});

describe('describeDetachedManualRoute', () => {
  it('announces a headset that was unplugged mid-call', () => {
    expect(
      describeDetachedManualRoute({
        manualRoute: AUDIO_ROUTES.WIRED_HEADSET,
        availableRoutes: [AUDIO_ROUTES.EARPIECE, AUDIO_ROUTES.SPEAKER_PHONE],
      }),
    ).toEqual({ message: 'Wired headset disconnected — switching audio output' });
  });

  it('announces a Bluetooth device that dropped off', () => {
    expect(
      describeDetachedManualRoute({
        manualRoute: AUDIO_ROUTES.BLUETOOTH,
        availableRoutes: [],
      }),
    ).toEqual({ message: 'Bluetooth disconnected — switching audio output' });
  });

  it('says nothing while the chosen device is still there', () => {
    expect(
      describeDetachedManualRoute({
        manualRoute: AUDIO_ROUTES.BLUETOOTH,
        availableRoutes: [AUDIO_ROUTES.BLUETOOTH],
      }),
    ).toBeNull();
  });

  it.each([AUDIO_ROUTES.EARPIECE, AUDIO_ROUTES.SPEAKER_PHONE])(
    'never reads an incomplete device list as losing %s',
    manualRoute => {
      expect(describeDetachedManualRoute({ manualRoute, availableRoutes: [] })).toBeNull();
    },
  );

  it.each([
    ['no manual choice', undefined],
    ['a released manual choice', null],
    ['an empty manual choice', ''],
  ])('says nothing when there is %s', (_label, manualRoute) => {
    expect(describeDetachedManualRoute({ manualRoute, availableRoutes: [] })).toBeNull();
  });

  it('tolerates a missing device list', () => {
    expect(
      describeDetachedManualRoute({ manualRoute: AUDIO_ROUTES.BLUETOOTH }),
    ).toEqual({ message: 'Bluetooth disconnected — switching audio output' });
  });
});

describe('describeChosenRoute', () => {
  it('names the loudspeaker the way the picker names it', () => {
    expect(describeChosenRoute(AUDIO_ROUTES.SPEAKER_PHONE)).toBe('Audio: Speaker');
  });

  it.each([AUDIO_ROUTES.BLUETOOTH, AUDIO_ROUTES.EARPIECE, 'SOME_FUTURE_DEVICE'])(
    'shows %s as it came',
    route => {
      expect(describeChosenRoute(route)).toBe(`Audio: ${route}`);
    },
  );
});

describe('mergeDiscoveredDevices', () => {
  it('prefers the freshly discovered list', () => {
    expect(mergeDiscoveredDevices(['A'], ['B', 'C'])).toEqual(['A']);
  });

  it('keeps the earlier list when a selection discovered nothing', () => {
    expect(mergeDiscoveredDevices([], ['B', 'C'])).toEqual(['B', 'C']);
    expect(mergeDiscoveredDevices(undefined, ['B'])).toEqual(['B']);
    expect(mergeDiscoveredDevices(null, ['B'])).toEqual(['B']);
  });

  it('returns an empty list when neither knows anything', () => {
    expect(mergeDiscoveredDevices(undefined, undefined)).toEqual([]);
  });

  it('copies rather than aliasing either input', () => {
    const previous = ['B'];
    const merged = mergeDiscoveredDevices([], previous);
    merged.push('C');
    expect(previous).toEqual(['B']);
  });
});
