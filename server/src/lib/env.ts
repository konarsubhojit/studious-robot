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
 * Parse a duration/count env var, falling back only when the value is absent.
 *
 * `0` is therefore honoured as an explicit setting rather than treated as
 * "unset". An explicitly configured invalid value is a startup error, rather
 * than an indistinguishable fallback to the default.
 */
function parseNonNegativeNumber(
  name: string,
  raw: string | undefined | null,
  fallback: number
): number {
  if (raw === undefined || raw === null) return fallback;
  const parsed = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: expected a non-negative integer, received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function parseByteSize(name: string, raw: string | undefined | null, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  const value = raw.trim();
  if (!/^\d+(?:b|kb|mb)?$/i.test(value)) {
    throw new Error(`Invalid ${name}: expected a non-negative byte size, received ${JSON.stringify(raw)}`);
  }
  return value;
}

export { parseNonNegativeNumber, parseByteSize };
