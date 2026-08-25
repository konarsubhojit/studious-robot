import { CALL_END_REASON_LABELS, DEFAULT_CALL_MEDIA_TYPE } from './callUx';
import type { CallHistoryEntry } from './hooks/useCallHistory';
import type { CallMediaType } from './settingsStorage';

/**
 * Pure helpers behind the Calls tab's log.
 *
 * The log used to be five rows of "Call · 02:31" with no date, no time of day,
 * no grouping and no filter, and every one of those rows redialled with video
 * regardless of how the original call was placed. Keeping the derivations here
 * (rather than inside the screen) makes each of them directly testable and lets
 * the person hub reuse the same phrasing for its own per-peer history.
 */

/** The filters offered above the log. */
export const CALL_FILTERS = {
  ALL: 'all',
  MISSED: 'missed',
} as const;

export type CallFilter = (typeof CALL_FILTERS)[keyof typeof CALL_FILTERS];

/** A day's worth of calls, newest day first. */
export type CallLogSection = {
  /** Stable key for the list: the local calendar date, `YYYY-MM-DD`. */
  key: string;
  /** "Today", "Yesterday", a weekday name, or a full date. */
  title: string;
  entries: CallHistoryEntry[];
};

/**
 * Whether an entry is a call the local user missed.
 *
 * Only *incoming* calls can be missed: an outgoing call that timed out was
 * unanswered by the other side, which is a different thing and must not inflate
 * the missed badge.
 */
export function isMissedCall(entry: CallHistoryEntry): boolean {
  return (
    entry?.direction === 'incoming' &&
    (entry?.status === 'missed' || entry?.endReason === 'timeout')
  );
}

/** The other party in a call, from the local user's point of view. */
export function callPeerId(entry: CallHistoryEntry): string {
  return (entry?.direction === 'outgoing' ? entry?.calleeId : entry?.callerId) ?? '';
}

/**
 * How the call was placed. Falls back to the app default for calls this device
 * has no record of (see `CallHistoryEntry.mediaType`), which is also what
 * redialling such a call will do — so the icon never contradicts the button.
 */
export function callMediaType(entry: CallHistoryEntry): CallMediaType {
  return entry?.mediaType ?? DEFAULT_CALL_MEDIA_TYPE;
}

/** Semantic icon key for the call's direction and outcome. */
export function callDirectionIcon(entry: CallHistoryEntry): string {
  if (isMissedCall(entry)) return 'callMissed';
  return entry?.direction === 'outgoing' ? 'callOutgoing' : 'callIncoming';
}

/** Semantic icon key for the call's modality. */
export function callMediaIcon(entry: CallHistoryEntry): string {
  return callMediaType(entry) === 'audio' ? 'callTypeAudio' : 'callTypeVideo';
}

/**
 * Human outcome for a call: "Missed", "Declined", "Outgoing"…
 *
 * Prefers the end reason the server recorded, falls back to the status, and
 * finally to the direction, so a row never degrades to a bare "Call".
 */
export function describeCallOutcome(entry: CallHistoryEntry): string {
  const mapped =
    (entry?.endReason ? CALL_END_REASON_LABELS[entry.endReason] : undefined) ??
    (entry?.status ? CALL_END_REASON_LABELS[entry.status] : undefined);
  if (mapped) return mapped;
  return entry?.direction === 'outgoing' ? 'Outgoing' : 'Incoming';
}

/** `HH:MM` in the device's locale and timezone; empty for an unparseable date. */
export function formatCallTimeOfDay(isoString: string | null | undefined): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Local calendar date key (`YYYY-MM-DD`) — the grouping key for a day. */
function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Whole days between two dates, ignoring the time of day. */
function calendarDaysApart(from: Date, to: Date): number {
  const startOfFrom = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const startOfTo = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((startOfTo - startOfFrom) / 86400000);
}

/**
 * Heading for a day of calls: "Today", "Yesterday", a weekday name within the
 * last week, and a full date beyond that.
 *
 * @param now - injected so the boundaries are testable without faking the clock
 */
export function formatCallDayHeading(date: Date, now: Date = new Date()): string {
  const daysApart = calendarDaysApart(date, now);
  if (daysApart <= 0) return 'Today';
  if (daysApart === 1) return 'Yesterday';
  if (daysApart < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

/** Apply the All / Missed filter. */
export function filterCallLog(
  entries: CallHistoryEntry[] | null | undefined,
  filter: CallFilter,
): CallHistoryEntry[] {
  const safe = Array.isArray(entries) ? entries : [];
  return filter === CALL_FILTERS.MISSED ? safe.filter(isMissedCall) : safe;
}

/**
 * Group calls into newest-first day sections.
 *
 * Entries without a usable `createdAt` are kept — dropping a call because the
 * server omitted a timestamp would silently lose history — and collected under
 * a trailing "Earlier" section rather than being dated arbitrarily.
 *
 * @param now - injected so "Today"/"Yesterday" are testable
 */
export function groupCallsByDay(
  entries: CallHistoryEntry[] | null | undefined,
  now: Date = new Date(),
): CallLogSection[] {
  const safe = Array.isArray(entries) ? entries : [];
  const sections: CallLogSection[] = [];
  const byKey = new Map<string, CallLogSection>();

  safe.forEach(entry => {
    const parsed = entry?.createdAt ? new Date(entry.createdAt) : null;
    const isValid = parsed !== null && !Number.isNaN(parsed.getTime());
    const key = isValid ? dayKey(parsed) : 'unknown';
    let section = byKey.get(key);
    if (!section) {
      section = {
        key,
        title: isValid ? formatCallDayHeading(parsed, now) : 'Earlier',
        entries: [],
      };
      byKey.set(key, section);
      sections.push(section);
    }
    section.entries.push(entry);
  });

  // Undated calls sort last however the server ordered them.
  return sections.sort((a, b) => {
    if (a.key === 'unknown') return 1;
    if (b.key === 'unknown') return -1;
    return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
  });
}

/**
 * Full screen-reader sentence for a log row.
 *
 * The visual row splits the same information across a glyph, two lines and a
 * trailing button; a screen reader needs it as one utterance.
 */
export function describeCallEntryForA11y(entry: CallHistoryEntry, durationLabel: string): string {
  const peer = callPeerId(entry) || 'Unknown contact';
  const modality = callMediaType(entry) === 'audio' ? 'Audio' : 'Video';
  const outcome = describeCallOutcome(entry);
  const time = formatCallTimeOfDay(entry?.createdAt);
  const parts = [`${modality} call`, outcome, peer && `with ${peer}`, time, durationLabel];
  return parts.filter(Boolean).join(', ');
}
