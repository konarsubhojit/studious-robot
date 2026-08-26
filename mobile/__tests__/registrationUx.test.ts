import {
  AUTH_METHOD_COPY,
  REGISTRATION_STEPS,
  REGISTRATION_STEP_TITLES,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_UNIQUENESS_NOTE,
  checkUsername,
  describeRegistrationStep,
  describeStepPosition,
  describeUsernameRule,
  stepForFailure,
} from '../src/registrationUx';
import type { UsernameRuleId, UsernameRuleState } from '../src/registrationUx';

/** State of one rule by id, so a case only states the rules it cares about. */
const stateOf = (value: string, id: UsernameRuleId): UsernameRuleState | undefined =>
  checkUsername(value).rules.find(rule => rule.id === id)?.state;

describe('registration steps', () => {
  test('counts the steps the user actually walks', () => {
    expect(describeStepPosition('method')).toBe('Step 1 of 2');
    expect(describeStepPosition('username')).toBe('Step 2 of 2');
  });

  test('announces a step as its position plus its heading', () => {
    REGISTRATION_STEPS.forEach(step => {
      expect(describeRegistrationStep(step)).toBe(
        `${describeStepPosition(step)}. ${REGISTRATION_STEP_TITLES[step]}`,
      );
    });
  });

  test('every sign-in method has copy for the step it is completed on', () => {
    const methods = Object.keys(AUTH_METHOD_COPY);

    expect(methods.sort()).toEqual(
      ['email-register', 'email-sign-in', 'google', 'microsoft'].sort(),
    );
    const submitLabels = Object.values(AUTH_METHOD_COPY).map(copy => copy.submitLabel);
    // A shared label would leave step 2 unable to say which choice it is
    // completing, which is the only reason the choice is restated there.
    expect(new Set(submitLabels).size).toBe(submitLabels.length);
    Object.values(AUTH_METHOD_COPY).forEach(copy => {
      expect(copy.chosenLabel.length).toBeGreaterThan(0);
    });
  });
});

describe('checkUsername', () => {
  test('accuses an untouched field of nothing', () => {
    const check = checkUsername('');

    expect(check.rules.map(rule => rule.state)).toEqual(['pending', 'pending', 'pending']);
    expect(check.isValid).toBe(false);
    expect(check.summary).toBe('Pick the name other people will type to call you.');
  });

  test('treats a field of pure whitespace as untouched, since that is what is sent', () => {
    const check = checkUsername('   ');

    expect(check.value).toBe('');
    expect(check.rules.every(rule => rule.state === 'pending')).toBe(true);
  });

  test('reports the length bounds', () => {
    expect(stateOf('ab', 'length')).toBe('unmet');
    expect(stateOf('a'.repeat(USERNAME_MIN_LENGTH), 'length')).toBe('met');
    expect(stateOf('a'.repeat(USERNAME_MAX_LENGTH), 'length')).toBe('met');
    expect(stateOf('a'.repeat(USERNAME_MAX_LENGTH + 1), 'length')).toBe('unmet');
  });

  test('reports the allowed characters', () => {
    expect(stateOf('alice bob', 'characters')).toBe('unmet');
    expect(stateOf('alice!', 'characters')).toBe('unmet');
    expect(stateOf('Alice.Bob_42-x', 'characters')).toBe('met');
  });

  test('reports leading and trailing separators', () => {
    expect(stateOf('-alice', 'separators')).toBe('unmet');
    expect(stateOf('alice.', 'separators')).toBe('unmet');
    expect(stateOf('_alice_', 'separators')).toBe('unmet');
    expect(stateOf('alice-42', 'separators')).toBe('met');
  });

  test('reports every rule at once, so the feedback is a checklist not a queue', () => {
    const check = checkUsername('-!');

    expect(check.rules.map(rule => `${rule.id}:${rule.state}`)).toEqual([
      'length:unmet',
      'characters:unmet',
      'separators:unmet',
    ]);
  });

  test('summarises the first thing left to fix, as an instruction', () => {
    expect(checkUsername('ab').summary).toBe(
      `Use between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters.`,
    );
    expect(checkUsername('alice bob').summary).toBe('Use letters, numbers, and . _ - only.');
    expect(checkUsername('alice-').summary).toBe('Start and end with a letter or number.');
  });

  test('passes a usable name, and sends exactly what was validated', () => {
    const check = checkUsername('  alice-42  ');

    expect(check.value).toBe('alice-42');
    expect(check.isValid).toBe(true);
    expect(check.rules.every(rule => rule.state === 'met')).toBe(true);
  });

  test('never claims a name is free, because nothing here can know that', () => {
    expect(checkUsername('alice').summary).toBe('Looks usable so far.');
    expect(checkUsername('alice').summary).not.toMatch(/available|free|taken/i);
  });

  test('states when uniqueness is checked instead of pretending to check it', () => {
    expect(USERNAME_UNIQUENESS_NOTE).toMatch(/checked when you continue/i);
    expect(USERNAME_UNIQUENESS_NOTE).toMatch(/cannot be checked before you sign in/i);
  });
});

describe('describeUsernameRule', () => {
  test('speaks the state a tick glyph and a colour convey visually', () => {
    const [length] = checkUsername('alice').rules;
    const [pending] = checkUsername('').rules;
    const [unmet] = checkUsername('ab').rules;

    expect(describeUsernameRule(length)).toBe(`${length.label}, met`);
    expect(describeUsernameRule(unmet)).toBe(`${unmet.label}, not met`);
    expect(describeUsernameRule(pending)).toBe(`${pending.label}, not checked yet`);
  });
});

describe('stepForFailure', () => {
  test('sends a username conflict to the step that owns the username', () => {
    // Both messages are raised by `useSession` on an HTTP 409.
    expect(stepForFailure('This username is already bound to another account.')).toBe('username');
    expect(stepForFailure('This account is already bound to alice.')).toBe('username');
  });

  test('sends a credential failure back to the step that owns the credentials', () => {
    // All four are raised by `getAuthenticationErrorMessage` in `useIdentity`.
    expect(stepForFailure('That email is already in use. Try signing in instead.')).toBe('method');
    expect(stepForFailure('Password is too weak. Use at least 6 characters.')).toBe('method');
    expect(stepForFailure('Enter a valid email address.')).toBe('method');
    expect(stepForFailure('Email/password sign-in is disabled in Firebase Auth settings.')).toBe(
      'method',
    );
  });

  test('leaves the user where they are when the message names nothing to fix', () => {
    expect(stepForFailure('Authentication failed.')).toBeNull();
    expect(stepForFailure('Network request failed')).toBeNull();
    expect(stepForFailure('')).toBeNull();
    expect(stepForFailure(null)).toBeNull();
    expect(stepForFailure(undefined)).toBeNull();
  });
});
