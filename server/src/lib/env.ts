/**
 * Parsing helpers for numeric environment knobs.
 *
 * The idiom this replaces — `Number(process.env.X) || DEFAULT` — cannot
 * express "disabled": `0` is falsy, so an operator who sets a knob to `0`
 * silently gets the default instead. For the retention and grace windows that
 * is the opposite of what they asked for, because `0` is exactly the value the
 * consuming code documents as "skip this pass". `NaN` from a typo is swallowed
 * by the same expression, so a misconfigured value looks identical to an unset
 * one.
 */

/**
 * Parse a duration/count env var, falling back only when the value is absent
 * or not a finite, non-negative number.
 *
 * `0` is therefore honoured as an explicit setting rather than treated as
 * "unset".
 */
function parseNonNegativeNumber(raw: string | undefined | null, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export { parseNonNegativeNumber };
