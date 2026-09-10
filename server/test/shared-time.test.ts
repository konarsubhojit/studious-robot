import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTimestamp, timestampMs } from '../../shared/time.ts';

/**
 * Tests for `shared/time.ts`, the one place a timestamp is rewritten into the
 * canonical `YYYY-MM-DDTHH:MM:SS.sssZ` shape.
 *
 * Two things depend on it and neither fails loudly when it is wrong: the
 * timeline is merge-sorted across messages and calls, and the mobile app runs
 * Hermes, which implements only the ECMAScript `Date.parse` grammar. A value
 * in any other shape either sorts into the wrong place or parses to `NaN` and
 * loses its place in the list entirely — so the inputs below are the exact
 * renderings Postgres produces, not invented ones.
 */

test('Postgres timestamptz renderings become canonical ISO', () => {
  // The trailing zeroes of the fraction are trimmed, the separator is a space
  // and the offset is two digits — all three of which Hermes rejects.
  assert.equal(normalizeTimestamp('2026-09-09 14:16:47.89+00'), '2026-09-09T14:16:47.890Z');
  assert.equal(normalizeTimestamp('2026-09-09 14:16:47+00'), '2026-09-09T14:16:47.000Z');
  assert.equal(normalizeTimestamp('2026-09-09T14:16:47.890+00'), '2026-09-09T14:16:47.890Z');
});

test('a non-UTC offset is resolved rather than assumed away', () => {
  // Nothing pins the database session's timezone, so `+00` cannot be taken for
  // granted; the offset has to be applied.
  assert.equal(normalizeTimestamp('2026-09-09 19:46:47.89+05:30'), '2026-09-09T14:16:47.890Z');
  assert.equal(normalizeTimestamp('2026-09-09 09:16:47.89-05'), '2026-09-09T14:16:47.890Z');
  assert.equal(normalizeTimestamp('2026-09-09 09:16:47.89-0500'), '2026-09-09T14:16:47.890Z');
});

test('sub-millisecond precision is truncated, never rounded', () => {
  // Truncation is monotonic, so normalising can never swap the order of two
  // timestamps — which is the entire point of doing it.
  assert.equal(normalizeTimestamp('2026-09-09 14:16:47.891234+00'), '2026-09-09T14:16:47.891Z');
  assert.equal(normalizeTimestamp('2026-09-09 14:16:47.999999+00'), '2026-09-09T14:16:47.999Z');
});

test('an already-canonical value is returned unchanged, by identity', () => {
  const canonical = '2026-09-09T14:16:47.890Z';
  assert.equal(normalizeTimestamp(canonical), canonical);
  // The mobile ingest path relies on this: an entry whose timestamps did not
  // change must keep its object identity or every memoised row re-renders.
  assert.equal(normalizeTimestamp(canonical) === canonical, true);
});

test('a value that cannot be understood is passed through, not mangled', () => {
  assert.equal(normalizeTimestamp('not a timestamp'), 'not a timestamp');
  assert.equal(normalizeTimestamp(''), '');
  assert.equal(normalizeTimestamp(null), null);
  assert.equal(normalizeTimestamp(undefined), undefined);
  // Beyond four-digit years `toISOString` emits the expanded `±YYYYYY` form,
  // which is not the canonical shape, so the input is kept instead.
  assert.equal(normalizeTimestamp('275760-09-14 00:00:00+00'), '275760-09-14 00:00:00+00');
});

test('out-of-range components are rejected rather than rolled over', () => {
  // `Date`'s setters roll over, so without a check `2026-13-45` would come back
  // as a confident `2027-02-14` — a wrong timestamp that sorts into a
  // plausible-looking place, which is the failure this module exists to stop.
  for (const malformed of [
    '2026-13-45 00:00:00+00',
    '2026-02-30 00:00:00+00',
    '2026-00-00 00:00:00+00',
    '2026-09-09 25:99:99+00',
    // An offset is applied as a plain millisecond shift, so it cannot be
    // caught by reading the built date back; the grammar bounds it instead.
    '2026-09-09 14:16:47.89+99',
    '2026-09-09 14:16:47.89-2400',
  ]) {
    assert.equal(normalizeTimestamp(malformed), malformed);
  }
});

test('normalised timestamps compare lexicographically as they do chronologically', () => {
  const raw = ['2026-09-09 14:16:47.89+00', '2026-09-09T14:16:47.000Z', '2026-09-09 14:16:48+00'];
  const normalized = raw.map((value) => normalizeTimestamp(value));

  assert.deepEqual(
    [...normalized].sort(),
    [...normalized].sort((a, b) => timestampMs(a) - timestampMs(b)),
  );
});

test('timestampMs reports NaN for a timestamp with no usable instant', () => {
  assert.equal(timestampMs('2026-09-09 14:16:47.89+00'), Date.parse('2026-09-09T14:16:47.890Z'));
  assert.ok(Number.isNaN(timestampMs('not a timestamp')));
  assert.ok(Number.isNaN(timestampMs(null)));
  assert.ok(Number.isNaN(timestampMs(undefined)));
});
