/**
 * Display-name normalisation and validation.
 *
 * A display name is rendered next to a `userId` everywhere the directory and
 * the chat list show a person, so it is attacker-controlled text on a trusted
 * surface.  Three classes of abuse are rejected here:
 *
 *   - **Invisible / direction-flipping codepoints.**  Control characters, bidi
 *     overrides and zero-width joiners let a name render as something other
 *     than what it stores (`"alice\u202Eeci la"`), so they are stripped before
 *     anything else looks at the value.
 *   - **Unbounded length.**  Capped in codepoints, not UTF-16 units, so an
 *     emoji costs one character rather than two.
 *   - **Impersonation.**  A name that folds onto someone else's `userId` makes
 *     the directory spoofable, which is the whole risk: the username is the
 *     only identifier a reader can trust.
 */

/** Maximum display-name length, in Unicode codepoints. */
const MAX_DISPLAY_NAME_LENGTH = 48;

/**
 * Codepoints removed outright: C0/C1 controls and DEL, the bidi overrides and
 * isolates (U+061C, U+200E/U+200F, U+202A–U+202E, U+2066–U+2069), and the
 * zero-width characters (U+200B–U+200D, U+FEFF) that render as nothing.
 */
const STRIPPED_CODEPOINTS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Any Unicode whitespace run, collapsed to a single space. */
const WHITESPACE_RUN = /\s+/gu;

/** Everything dropped when folding a name or a `userId` for comparison. */
const NON_IDENTIFIER_CHARACTERS = /[^\p{Letter}\p{Number}]+/gu;

export type DisplayNameRejection =
  | 'invalid_type'
  | 'empty'
  | 'too_long'
  | 'impersonates_user';

export type DisplayNameResult =
  | { ok: true; displayName: string | null; }
  | { ok: false; reason: DisplayNameRejection; };

/**
 * Normalise a requested display name.
 *
 * `null` means "clear my display name" and is accepted as-is; anything else
 * must be a string that survives stripping with at least one character left.
 *
 * @returns The canonical value to store, or the reason it was rejected.
 */
function normaliseDisplayName(value: unknown): DisplayNameResult {
  if (value === null) return { ok: true, displayName: null };
  if (typeof value !== 'string') return { ok: false, reason: 'invalid_type' };

  // NFC first so a decomposed name and its composed twin are one value, and so
  // the length cap counts what the reader sees rather than how it was typed.
  //
  // Whitespace is folded to plain spaces *before* the strip, because tabs and
  // newlines are control characters too: stripping first would silently glue
  // "Alice\tSmith" into one word. The second collapse mops up the gap a
  // stripped codepoint leaves between two spaces.
  const cleaned = value
    .normalize('NFC')
    .replace(WHITESPACE_RUN, ' ')
    .replace(STRIPPED_CODEPOINTS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();

  if (cleaned.length === 0) return { ok: false, reason: 'empty' };
  if ([...cleaned].length > MAX_DISPLAY_NAME_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  return { ok: true, displayName: cleaned };
}

/**
 * Fold a name or `userId` to the key the impersonation check compares on.
 *
 * Case, spacing and punctuation are all discarded, so `"B o b.!"` and `"bob"`
 * collide: the separators are exactly what an impersonator would add to slip
 * an existing username past an equality test.
 */
function foldForImpersonation(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(NON_IDENTIFIER_CHARACTERS, '');
}

/**
 * Decide whether a display name lays claim to somebody else's username.
 *
 * The caller's own `userId` is always allowed — using your own username as
 * your display name impersonates nobody.
 *
 * @param displayName - An already-normalised display name.
 * @param ownUserId - The `userId` of the account the name belongs to.
 * @param userIds - Every known username.
 */
function impersonatesKnownUserId(
  displayName: string,
  ownUserId: string,
  userIds: Iterable<string>
): boolean {
  const folded = foldForImpersonation(displayName);
  if (folded.length === 0) return false;
  if (folded === foldForImpersonation(ownUserId)) return false;
  for (const userId of userIds) {
    if (userId === ownUserId) continue;
    if (foldForImpersonation(userId) === folded) return true;
  }
  return false;
}

export {
  MAX_DISPLAY_NAME_LENGTH,
  normaliseDisplayName,
  foldForImpersonation,
  impersonatesKnownUserId,
};
