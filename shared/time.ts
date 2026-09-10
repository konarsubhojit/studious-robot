/**
 * Timestamp canonicalisation, shared by `mobile/` and `server/`.
 *
 * Every timestamp that crosses the wire is expected to be in one shape:
 * `YYYY-MM-DDTHH:MM:SS.sssZ`.  Two independent properties of the chat timeline
 * depend on that, and both broke when a value arrived in some other shape:
 *
 *   - **Ordering.**  Messages and calls are merge-sorted against each other,
 *     and a timeline entry's timestamp doubles as the `before` pagination
 *     cursor.  Fixed-width UTC ISO is the one form where a lexicographic
 *     comparison and a chronological one agree, so any deviation silently
 *     reorders the conversation instead of failing.
 *   - **Parsing on the device.**  Hermes implements only the ES `Date.parse`
 *     grammar: `2026-09-09 14:16:47.89+00` — a perfectly ordinary Postgres
 *     `timestamptz` rendering — parses to `NaN` there, as does any ISO string
 *     with a two-digit `±HH` offset.  A `NaN` timestamp is not an error the
 *     chat screen can see; it just loses the entry's place in the list, drops
 *     its bubble time and its day separator.
 *
 * Hence this module: one conversion, applied where untrusted timestamp text
 * enters the system, rather than a defensive parse at each of the two dozen
 * places one is read.  It is deliberately hand-rolled rather than built on
 * `new Date(value)`, because the whole point is to accept the inputs the
 * *engine* will not.
 */

/**
 * The canonical form: exactly the output of `Date.prototype.toISOString` for a
 * date inside the four-digit-year range.
 */
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The accepted inputs, which is the union of the ISO 8601 date-time grammar and
 * Postgres' `timestamptz` text output:
 *
 *   - `T` or a space between the date and the time;
 *   - seconds optional, fractional seconds optional and of any length;
 *   - the zone as `Z`, `±HH`, `±HHMM` or `±HH:MM`, or absent.
 */
const TIMESTAMP_TEXT =
  /^(\d{4,})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

/** Milliseconds in one minute, for applying a UTC offset. */
const MS_PER_MINUTE = 60_000;

/**
 * The fraction digits as whole milliseconds.
 *
 * Truncated rather than rounded: truncation is monotonic, so two timestamps
 * never swap order by being normalised, and rounding a `.9999` up would carry
 * into the next second.  Nothing in this system writes sub-millisecond
 * precision — every producer goes through `Date`, which has none — so the
 * digits being discarded are always zeroes that Postgres rendered and then
 * trimmed.
 */
function fractionToMilliseconds(fraction: string | undefined): number {
  if (!fraction) return 0;
  return Number(fraction.slice(0, 3).padEnd(3, '0'));
}

/**
 * The zone suffix as minutes to subtract to reach UTC.
 *
 * An absent zone is read as UTC.  ECMAScript would read it as *local* time,
 * which would make the same stored value mean different instants on two
 * devices; every timestamp this system produces is UTC, so assuming it is the
 * choice that keeps two clients agreeing.
 */
function offsetMinutes(zone: string | undefined): number {
  if (!zone || zone === 'Z' || zone === 'z') return 0;
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
  return sign * (hours * 60 + minutes);
}

/**
 * Rewrite a timestamp into the canonical `YYYY-MM-DDTHH:MM:SS.sssZ` form.
 *
 * Returns the value unchanged when it is already canonical (so a normalised
 * object keeps its identity), and when it cannot be understood at all — a
 * timestamp this module does not recognise is someone else's data, and
 * mangling it would be worse than passing it along.
 *
 * @param value - Timestamp text, or `null`/`undefined` for a column that has
 *   none.
 */
export function normalizeTimestamp(value: string): string;
export function normalizeTimestamp(value: string | null): string | null;
export function normalizeTimestamp(value: string | null | undefined): string | null | undefined;
export function normalizeTimestamp(
  value: string | null | undefined,
): string | null | undefined {
  if (typeof value !== 'string') return value;
  if (CANONICAL_TIMESTAMP.test(value)) return value;

  const parts = TIMESTAMP_TEXT.exec(value);
  if (!parts) return value;

  const [, year, month, day, hour, minute, second, fraction, zone] = parts;
  // Built field by field rather than with `Date.UTC`, which remaps years 0–99
  // onto 1900–1999 — the regex accepts a four-digit `0099`, which must stay in
  // the first century.
  const instant = new Date(0);
  instant.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  instant.setUTCHours(
    Number(hour),
    Number(minute),
    second ? Number(second) : 0,
    fractionToMilliseconds(fraction),
  );
  instant.setTime(instant.getTime() - offsetMinutes(zone) * MS_PER_MINUTE);

  // Outside ±8.64e15 ms the date is invalid, and beyond four-digit years
  // `toISOString` emits the expanded `±YYYYYY` form, which is not canonical.
  if (Number.isNaN(instant.getTime())) return value;
  const iso = instant.toISOString();
  return CANONICAL_TIMESTAMP.test(iso) ? iso : value;
}

/**
 * Milliseconds since the epoch for a timestamp, or `NaN` when it has none that
 * can be understood.
 *
 * Ordering code compares these rather than the strings themselves: a
 * comparison over text is only chronological while every value has the same
 * width, which is a property of the data rather than of the type.
 */
export function timestampMs(value: string | null | undefined): number {
  const normalized = normalizeTimestamp(value);
  return typeof normalized === 'string' ? Date.parse(normalized) : Number.NaN;
}
