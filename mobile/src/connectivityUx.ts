/**
 * Shared vocabulary for the one connectivity condition the app can be in.
 *
 * "You are offline" used to be phrased and weighted four different ways —
 * a full `ErrorState` card headed "Server unreachable" on Calls, a line of grey
 * body text on Search, a warning row in the conversation, and a themed status
 * line in a call — so the same fact read as four different severities. The
 * consequence genuinely differs per screen (you cannot place a call; you are
 * seeing local results; your message is queued), so what is shared is the lead
 * and the weight, not the whole sentence.
 *
 * Lives outside `components/` so it can be asserted on without rendering, and
 * so a screen cannot drift by re-wording its own copy.
 */

/** The lead every offline banner opens with. */
export const OFFLINE_LEAD = 'Offline';

/** Semantic `ICONS` key every offline banner uses. */
export const OFFLINE_ICON = 'offline';

/**
 * Composes the one offline sentence: the shared lead, then what it means *here*.
 *
 * @param consequence What being offline costs the user on this screen, in the
 *   present tense and without a leading capital ("messages will send when
 *   you're back").
 */
export function describeOffline(consequence: string): string {
  return `${OFFLINE_LEAD} — ${consequence}`;
}

/** What being offline costs the user, per surface. */
export const OFFLINE_CONSEQUENCE = {
  calls: "calls can't be placed until the app reconnects",
  search: 'showing conversations and calls stored on this device',
  conversation: "messages will send when you're back",
} as const;
