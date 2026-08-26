/**
 * Vocabulary for the two-step registration flow.
 *
 * Lives outside `components/` so the rules and the copy can be asserted without
 * rendering a screen, and so the screen cannot quietly disagree with itself
 * about what a usable username is.
 *
 * The username rules below are *this app's* conventions, not a mirror of a
 * server contract: the signaling server accepts any non-empty trimmed id (see
 * `normaliseId`). They exist because a username is what somebody else types to
 * reach you and reads back off a call log, so whitespace, punctuation and
 * 40-character names cost the user's contacts rather than the user.
 *
 * Uniqueness is deliberately *not* a rule here. There is no unauthenticated
 * availability endpoint (`GET /users` requires a session), so a live "that name
 * is free" tick would be a lie. The only honest thing to say before sign-in is
 * when the check happens — `USERNAME_UNIQUENESS_NOTE` — and the real answer
 * arrives as a server error the screen already renders through `ErrorState`.
 */

/** How the user chose to authenticate in step 1. */
export type AuthMethod = 'email-register' | 'email-sign-in' | 'google' | 'microsoft';

/** `method` = choose how to sign in; `username` = choose the public name. */
export type RegistrationStep = 'method' | 'username';

/** Order the steps are walked in, and what "Step 1 of 2" counts. */
export const REGISTRATION_STEPS: RegistrationStep[] = ['method', 'username'];

/** Heading each step is introduced by, reused as its announcement. */
export const REGISTRATION_STEP_TITLES: Record<RegistrationStep, string> = {
  method: 'How do you want to sign in?',
  username: 'Choose your username',
};

/**
 * "Step 1 of 2" — shown beside the heading so a form that now spans two
 * screens still tells the user how much of it is left.
 */
export function describeStepPosition(step: RegistrationStep): string {
  return `Step ${REGISTRATION_STEPS.indexOf(step) + 1} of ${REGISTRATION_STEPS.length}`;
}

/**
 * Sentence announced when the flow moves between steps. Swapping the form's
 * contents is not a navigation event, so nothing else would tell a screen
 * reader that the screen it just read is gone.
 */
export function describeRegistrationStep(step: RegistrationStep): string {
  return `${describeStepPosition(step)}. ${REGISTRATION_STEP_TITLES[step]}`;
}

export type AuthMethodCopy = {
  /** Title of step 2's primary button: the choice, restated as its outcome. */
  submitLabel: string;
  /** Names the step-1 choice on step 2, where the buttons are out of sight. */
  chosenLabel: string;
};

export const AUTH_METHOD_COPY: Record<AuthMethod, AuthMethodCopy> = {
  'email-register': { submitLabel: 'Create account', chosenLabel: 'Creating an account with email' },
  'email-sign-in': { submitLabel: 'Sign in', chosenLabel: 'Signing in with email' },
  google: { submitLabel: 'Continue with Google', chosenLabel: 'Signing in with Google' },
  microsoft: { submitLabel: 'Continue with Microsoft', chosenLabel: 'Signing in with Microsoft' },
};

/** Short enough to stay readable in a call log row. */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/** Allowed inside a username, but not at either end, where they read as typos. */
export const USERNAME_SEPARATORS = '._-';

/** The one honest statement available about uniqueness before sign-in. */
export const USERNAME_UNIQUENESS_NOTE =
  'Usernames are unique. Whether this one is free is checked when you continue — it cannot be checked before you sign in.';

export type UsernameRuleId = 'length' | 'characters' | 'separators';

/**
 * `pending` exists so an empty field is not accused of breaking three rules
 * the user has not had a chance to satisfy yet.
 */
export type UsernameRuleState = 'pending' | 'met' | 'unmet';

export type UsernameRule = {
  id: UsernameRuleId;
  /** Stated as the requirement, so the list reads the same in every state. */
  label: string;
  state: UsernameRuleState;
};

export type UsernameCheck = {
  /** Trimmed value, i.e. exactly what would be sent as the `userId`. */
  value: string;
  rules: UsernameRule[];
  isValid: boolean;
  /** One live sentence: the next thing to fix, or that nothing is left. */
  summary: string;
};

/**
 * The rules, in the order a user hits them while typing. `fix` is phrased as an
 * instruction because a summary that repeats the requirement ("3 to 32
 * characters") leaves a screen-reader user to work out what to do about it.
 */
const USERNAME_RULES: {
  id: UsernameRuleId;
  label: string;
  fix: string;
  isMet: (value: string) => boolean;
}[] = [
  {
    id: 'length',
    label: `${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} characters`,
    fix: `Use between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters.`,
    isMet: value => value.length >= USERNAME_MIN_LENGTH && value.length <= USERNAME_MAX_LENGTH,
  },
  {
    id: 'characters',
    label: 'Letters, numbers, and . _ - only',
    fix: 'Use letters, numbers, and . _ - only.',
    isMet: value => /^[a-z0-9._-]+$/i.test(value),
  },
  {
    id: 'separators',
    label: 'Starts and ends with a letter or number',
    fix: 'Start and end with a letter or number.',
    isMet: value =>
      !USERNAME_SEPARATORS.includes(value.charAt(0)) &&
      !USERNAME_SEPARATORS.includes(value.charAt(value.length - 1)),
  },
];

/** Shown while the field is empty: names the job rather than the rules. */
const USERNAME_EMPTY_SUMMARY = 'Pick the name other people will type to call you.';

/** Shown once every rule is met; uniqueness is still open, hence "so far". */
const USERNAME_VALID_SUMMARY = 'Looks usable so far.';

/**
 * Evaluate a username as it is typed.
 *
 * Every rule is reported, not just the first failure, so the feedback is a
 * checklist that fills in rather than a single error that moves around.
 *
 * @param raw - Exactly what is in the input, untrimmed.
 */
export function checkUsername(raw: string): UsernameCheck {
  const value = (raw ?? '').trim();
  const isEmpty = value.length === 0;

  const stateOf = (isMet: (value: string) => boolean): UsernameRuleState => {
    if (isEmpty) return 'pending';
    return isMet(value) ? 'met' : 'unmet';
  };

  const rules: UsernameRule[] = USERNAME_RULES.map(rule => ({
    id: rule.id,
    label: rule.label,
    state: stateOf(rule.isMet),
  }));

  const firstUnmet = isEmpty ? undefined : USERNAME_RULES.find(rule => !rule.isMet(value));
  const isValid = !isEmpty && !firstUnmet;

  let summary = USERNAME_VALID_SUMMARY;
  if (isEmpty) summary = USERNAME_EMPTY_SUMMARY;
  else if (firstUnmet) summary = firstUnmet.fix;

  return { value, rules, isValid, summary };
}

/**
 * Accessible name for a checklist row. The row's state is carried by colour and
 * a tick glyph, neither of which a screen reader conveys.
 */
export function describeUsernameRule(rule: UsernameRule): string {
  if (rule.state === 'met') return `${rule.label}, met`;
  return rule.state === 'unmet' ? `${rule.label}, not met` : `${rule.label}, not checked yet`;
}

/**
 * Which step owns a failed attempt, so the user lands where the fix is.
 *
 * The auth and session layers hand this screen a sentence, not a code (see
 * `getAuthenticationErrorMessage` and the 409 branch in `useSession`), so the
 * sentence is what has to be classified. Username conflicts are tested first
 * because "That email is already in use" and "This username is already bound"
 * are both "already" messages that belong to opposite steps.
 *
 * @returns the step to move to, or `null` when the message names nothing the
 *   user can fix by moving (a network failure is retried where they stand).
 */
export function stepForFailure(message: string | null | undefined): RegistrationStep | null {
  const text = (message ?? '').toLowerCase();
  if (!text) return null;
  if (text.includes('username') || text.includes('already bound')) return 'username';
  if (/email|password|sign[-\s]?in/.test(text)) return 'method';
  return null;
}
