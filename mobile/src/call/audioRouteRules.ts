/**
 * Audio-route decisions, as pure logic.
 *
 * Phase 5, slice 9 of the `useCallFlow` decomposition (#216). These rules were
 * inline in the hook's audio effects and therefore only reachable by mounting
 * it and replaying a device-change event. They read the route vocabulary from
 * `audioRouting` — the one place it is defined — but decide only; every
 * `chooseAudioRoute` that acts on a decision stays in the hook.
 *
 * No React, no refs, no native calls.
 */

import {
  AUDIO_ROUTES,
  DETACHABLE_AUDIO_ROUTES,
  getAudioRouteLabel,
} from '../audioRouting';

/**
 * Whether the automatic pick should be upgraded to the loudspeaker.
 *
 * "Speaker on join" is a preference, not an override: with a headset or a
 * Bluetooth device attached the automatic pick is that device and the
 * preference must not steal the call away from it. Only the earpiece — the pick
 * made when nothing else is attached — is upgraded.
 */
export function shouldUpgradeToSpeaker({
  routed,
  selected,
  speakerEnabledByDefault,
}: {
  routed: boolean;
  selected?: string | null;
  speakerEnabledByDefault?: boolean;
}): boolean {
  return Boolean(routed && speakerEnabledByDefault && selected === AUDIO_ROUTES.EARPIECE);
}

/**
 * Whether a route the user picked by hand has physically disappeared, and what
 * to say about it.
 *
 * The automatic route silently takes over, which is right — but saying nothing
 * leaves someone talking into a handset that is now on speaker in a public
 * place, so the hand-over is announced and the manual choice released.
 *
 * Only detachable routes are considered: the earpiece and the loudspeaker are
 * part of the handset, so a device list that happens to omit one of them is an
 * incomplete enumeration, never an unplug.
 */
export function describeDetachedManualRoute({
  manualRoute,
  availableRoutes,
}: {
  manualRoute?: string | null;
  availableRoutes?: readonly string[] | null;
}): { message: string; } | null {
  if (!manualRoute || !DETACHABLE_AUDIO_ROUTES.includes(manualRoute)) return null;
  if ((availableRoutes ?? []).includes(manualRoute)) return null;
  return {
    message: `${getAudioRouteLabel(manualRoute)} disconnected — switching audio output`,
  };
}

/**
 * The status line for a route the user chose.
 *
 * The loudspeaker is named the way the picker names it; anything else is
 * already a device name and is shown as it came, so a route this build has
 * never heard of still reads as something.
 */
export function describeChosenRoute(route: string): string {
  return `Audio: ${route === AUDIO_ROUTES.SPEAKER_PHONE ? 'Speaker' : route}`;
}

/**
 * Which device list to keep after a second selection.
 *
 * The native module reports its list only as a side effect of selecting a
 * route, and a selection that reports nothing has not discovered an empty
 * world — it has discovered nothing. Keeping the earlier list stops the output
 * picker from emptying itself between two successful switches.
 */
export function mergeDiscoveredDevices(
  discovered?: readonly string[] | null,
  previous?: readonly string[] | null,
): string[] {
  return [...((discovered?.length ? discovered : previous) ?? [])];
}
