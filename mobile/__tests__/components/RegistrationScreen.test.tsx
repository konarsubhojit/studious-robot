import React from 'react';
import { AccessibilityInfo } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import RegistrationScreen from '../../src/components/RegistrationScreen';

jest.mock(
  '../../src/components/AppButton',
  () => (props: any) => require('react').createElement('AppButton', props),
);

type Props = Partial<React.ComponentProps<typeof RegistrationScreen>>;

const render = (props: Props = {}) => {
  const onRegister = props.onRegister ?? jest.fn();
  let tree: any;
  act(() => {
    tree = renderer.create(<RegistrationScreen {...props} onRegister={onRegister} />);
  });
  return { tree, onRegister };
};

/** Re-render with new props, as `AppShell` does when the status changes. */
const update = (tree: any, props: Props & { onRegister: any }) => {
  act(() => {
    tree.update(<RegistrationScreen {...props} />);
  });
};

const nodes = (tree: any, testID: string) =>
  tree.root.findAll((n: any) => n.props?.testID === testID);

/** Only host fibers carry the rendered accessibility attributes. */
const hosts = (tree: any, testID: string) =>
  nodes(tree, testID).filter((n: any) => typeof n.type === 'string');

const button = (tree: any, testID: string) =>
  tree.root.findAllByType('AppButton').find((b: any) => b.props.testID === testID);

const press = (tree: any, testID: string) => {
  const target = nodes(tree, testID).find((n: any) => typeof n.props?.onPress === 'function');
  act(() => {
    target.props.onPress();
  });
};

const typeInto = (tree: any, testID: string, text: string) => {
  const input = nodes(tree, testID)[0];
  act(() => {
    input.props.onChangeText(text);
  });
};

/** Text of every heading currently rendered, in tree order. */
const headings = (tree: any) =>
  tree.root
    .findAll((n: any) => typeof n.type === 'string' && n.props?.accessibilityRole === 'header')
    .map((n: any) => n.props.children);

/** Step 2 is the only step with the username field on it. */
const isOnUsernameStep = (tree: any) => hosts(tree, 'registration-username-input').length === 1;

/** Fill in the email credentials and take the named route to step 2. */
const goToUsernameStep = (tree: any, method = 'registration-email-register') => {
  typeInto(tree, 'registration-email-input', 'alice@example.com');
  typeInto(tree, 'registration-password-input', 'secret12');
  press(tree, method);
};

describe('RegistrationScreen step 1: choosing how to sign in', () => {
  test('opens on the sign-in choices, with the username step still ahead', () => {
    const { tree } = render();

    expect(hosts(tree, 'registration-logo')).toHaveLength(1);
    expect(headings(tree)[0]).toBe('How do you want to sign in?');
    expect(hosts(tree, 'registration-email-input')).toHaveLength(1);
    expect(hosts(tree, 'registration-password-input')).toHaveLength(1);
    expect(isOnUsernameStep(tree)).toBe(false);
  });

  test('renders all supported sign-in methods', () => {
    const { tree } = render();

    expect(tree.root.findAllByType('AppButton').map((b: any) => b.props.testID)).toEqual([
      'registration-google',
      'registration-microsoft',
      'registration-email-register',
      'registration-email-sign-in',
    ]);
  });

  test('email routes stay disabled until an email and a 6-character password are given', () => {
    const { tree } = render();

    expect(button(tree, 'registration-email-register').props.disabled).toBe(true);
    expect(button(tree, 'registration-email-sign-in').props.disabled).toBe(true);

    typeInto(tree, 'registration-email-input', 'alice@example.com');
    typeInto(tree, 'registration-password-input', 'short');
    expect(button(tree, 'registration-email-register').props.disabled).toBe(true);

    typeInto(tree, 'registration-password-input', 'secret12');
    expect(button(tree, 'registration-email-register').props.disabled).toBe(false);
    expect(button(tree, 'registration-email-sign-in').props.disabled).toBe(false);
  });

  test('provider routes do not wait for a username, which is now the next step', () => {
    const { tree } = render();

    expect(button(tree, 'registration-google').props.disabled).toBe(false);
    expect(button(tree, 'registration-microsoft').props.disabled).toBe(false);
  });

  test('disables provider buttons when providers are unconfigured', () => {
    const { tree } = render({
      isGoogleSignInAvailable: false,
      isMicrosoftSignInAvailable: false,
    });

    const googleButton = button(tree, 'registration-google');
    const microsoftButton = button(tree, 'registration-microsoft');

    expect(googleButton.props.disabled).toBe(true);
    expect(googleButton.props.title).toMatch(/unavailable/i);
    expect(microsoftButton.props.disabled).toBe(true);
    expect(microsoftButton.props.title).toMatch(/unavailable/i);
  });

  test('choosing a method advances to step 2 instead of registering', () => {
    const { tree, onRegister } = render();

    goToUsernameStep(tree);

    expect(onRegister).not.toHaveBeenCalled();
    expect(isOnUsernameStep(tree)).toBe(true);
    expect(headings(tree)[0]).toBe('Choose your username');
  });

  test('keeps the accessibility labels and hints on the credential fields', () => {
    const { tree } = render();

    const [email] = hosts(tree, 'registration-email-input');
    const [password] = hosts(tree, 'registration-password-input');

    expect(email.props.accessibilityLabel).toBe('Email address');
    expect(password.props.accessibilityLabel).toBe('Password');
    expect(password.props.accessibilityHint).toBe('At least 6 characters');
    expect(button(tree, 'registration-email-register').props.accessibilityLabel).toBe(
      'Create account',
    );
    expect(button(tree, 'registration-google').props.accessibilityHint).toMatch(/step 2/i);
  });
});

describe('RegistrationScreen step 2: choosing a username', () => {
  test('accuses an untouched field of nothing, and keeps the button out of reach', () => {
    const { tree } = render();
    goToUsernameStep(tree);

    expect(hosts(tree, 'registration-username-rule-length')[0].props.accessibilityLabel).toBe(
      '3 to 32 characters, not checked yet',
    );
    expect(hosts(tree, 'registration-username-summary')[0].props.children).toBe(
      'Pick the name other people will type to call you.',
    );
    expect(button(tree, 'registration-submit').props.disabled).toBe(true);
  });

  test('marks each rule live as the user types', () => {
    const { tree } = render();
    goToUsernameStep(tree);

    typeInto(tree, 'registration-username-input', '-a');
    expect(hosts(tree, 'registration-username-rule-length')[0].props.accessibilityLabel).toBe(
      '3 to 32 characters, not met',
    );
    expect(hosts(tree, 'registration-username-rule-separators')[0].props.accessibilityLabel).toBe(
      'Starts and ends with a letter or number, not met',
    );
    expect(hosts(tree, 'registration-username-summary')[0].props.children).toBe(
      'Use between 3 and 32 characters.',
    );
    expect(button(tree, 'registration-submit').props.disabled).toBe(true);

    typeInto(tree, 'registration-username-input', 'alice bob');
    expect(hosts(tree, 'registration-username-rule-characters')[0].props.accessibilityLabel).toBe(
      'Letters, numbers, and . _ - only, not met',
    );
    expect(button(tree, 'registration-submit').props.disabled).toBe(true);

    typeInto(tree, 'registration-username-input', 'alice-42');
    expect(hosts(tree, 'registration-username-rules')).toHaveLength(1);
    ['length', 'characters', 'separators'].forEach(id => {
      expect(hosts(tree, `registration-username-rule-${id}`)[0].props.accessibilityLabel).toMatch(
        /, met$/,
      );
    });
    expect(button(tree, 'registration-submit').props.disabled).toBe(false);
  });

  test('says when uniqueness is checked rather than pretending to check it', () => {
    const { tree } = render();
    goToUsernameStep(tree);
    typeInto(tree, 'registration-username-input', 'alice');

    expect(hosts(tree, 'registration-username-note')[0].props.children).toMatch(
      /checked when you continue/i,
    );
    expect(hosts(tree, 'registration-username-summary')[0].props.children).toBe(
      'Looks usable so far.',
    );
  });

  test('submits email registration fields', () => {
    const { tree, onRegister } = render();

    typeInto(tree, 'registration-email-input', ' alice@example.com ');
    typeInto(tree, 'registration-password-input', 'secret12');
    press(tree, 'registration-email-register');
    typeInto(tree, 'registration-username-input', ' alice ');
    press(tree, 'registration-submit');

    expect(onRegister).toHaveBeenCalledWith({
      userId: 'alice',
      method: 'email-register',
      email: 'alice@example.com',
      password: 'secret12',
    });
  });

  test('submits with the method chosen in step 1', () => {
    const { tree, onRegister } = render();

    press(tree, 'registration-google');
    typeInto(tree, 'registration-username-input', 'alice');
    expect(button(tree, 'registration-submit').props.title).toBe('Continue with Google');
    press(tree, 'registration-submit');

    expect(onRegister).toHaveBeenCalledWith({
      userId: 'alice',
      method: 'google',
      email: '',
      password: '',
    });
  });

  test('shows loading state when isLoading is true', () => {
    const { tree, onRegister } = render();
    goToUsernameStep(tree);
    typeInto(tree, 'registration-username-input', 'alice');
    update(tree, { onRegister, isLoading: true });

    const submit = button(tree, 'registration-submit');
    expect(submit.props.title).toBe('Setting up…');
    expect(submit.props.disabled).toBe(true);
    expect(hosts(tree, 'registration-back')[0].props.accessibilityState.disabled).toBe(true);
  });

  test('keeps the username field accessible and the step heading a heading', () => {
    const { tree } = render();
    goToUsernameStep(tree);

    const [input] = hosts(tree, 'registration-username-input');
    expect(input.props.accessibilityLabel).toBe('Your username');
    expect(input.props.accessibilityHint).toBe('Other people will call you by this name');
    expect(headings(tree)).toContain('Choose your username');
  });

  test('going back keeps everything that was already typed', () => {
    const { tree } = render();
    goToUsernameStep(tree);
    typeInto(tree, 'registration-username-input', 'alice');

    press(tree, 'registration-back');
    expect(isOnUsernameStep(tree)).toBe(false);
    expect(hosts(tree, 'registration-email-input')[0].props.value).toBe('alice@example.com');
    expect(hosts(tree, 'registration-password-input')[0].props.value).toBe('secret12');

    press(tree, 'registration-email-sign-in');
    expect(hosts(tree, 'registration-username-input')[0].props.value).toBe('alice');
    expect(button(tree, 'registration-submit').props.title).toBe('Sign in');
  });
});

describe('RegistrationScreen failures', () => {
  test('surfaces a failed sign-in as an error state that retries the last attempt', () => {
    const status = { message: 'Server unreachable', severity: 'error' as const };
    const { tree, onRegister } = render({ status });

    // No attempt yet: the error is explained, but there is nothing to retry.
    expect(nodes(tree, 'registration-error').length).toBeGreaterThanOrEqual(1);
    expect(nodes(tree, 'registration-error-action')).toHaveLength(0);

    goToUsernameStep(tree);
    typeInto(tree, 'registration-username-input', 'alice');
    press(tree, 'registration-submit');
    expect(onRegister).toHaveBeenCalledTimes(1);

    press(tree, 'registration-error-action');

    expect(onRegister).toHaveBeenCalledTimes(2);
    expect(onRegister).toHaveBeenLastCalledWith({
      userId: 'alice',
      method: 'email-register',
      email: 'alice@example.com',
      password: 'secret12',
    });
  });

  test('offers no retry while the username itself could not be sent', () => {
    const { tree, onRegister } = render();
    goToUsernameStep(tree);
    typeInto(tree, 'registration-username-input', 'alice');
    press(tree, 'registration-submit');

    update(tree, {
      onRegister,
      status: { message: 'This username is already bound to another account.', severity: 'error' },
    });
    expect(nodes(tree, 'registration-error-action').length).toBeGreaterThanOrEqual(1);

    typeInto(tree, 'registration-username-input', 'a');
    expect(nodes(tree, 'registration-error-action')).toHaveLength(0);
  });

  test('a taken username lands the user on the step that owns the username', () => {
    const { tree, onRegister } = render();
    goToUsernameStep(tree);
    typeInto(tree, 'registration-username-input', 'alice');
    press(tree, 'registration-submit');
    press(tree, 'registration-back');
    expect(isOnUsernameStep(tree)).toBe(false);

    update(tree, {
      onRegister,
      status: { message: 'This username is already bound to another account.', severity: 'error' },
    });

    expect(isOnUsernameStep(tree)).toBe(true);
    expect(hosts(tree, 'registration-username-input')[0].props.value).toBe('alice');
  });

  test('a rejected email lands the user back on the step that owns the credentials', () => {
    const { tree, onRegister } = render();
    goToUsernameStep(tree);
    typeInto(tree, 'registration-username-input', 'alice');
    press(tree, 'registration-submit');

    update(tree, {
      onRegister,
      status: {
        message: 'That email is already in use. Try signing in instead.',
        severity: 'error',
      },
    });

    expect(isOnUsernameStep(tree)).toBe(false);
    expect(hosts(tree, 'registration-email-input')[0].props.value).toBe('alice@example.com');
    // The recovery affordance follows the user to the step they were sent to.
    expect(nodes(tree, 'registration-error-action').length).toBeGreaterThanOrEqual(1);
  });

  test('a failure that names nothing to fix leaves the user where they are', () => {
    const { tree, onRegister } = render();
    goToUsernameStep(tree);
    typeInto(tree, 'registration-username-input', 'alice');
    press(tree, 'registration-submit');

    update(tree, { onRegister, status: { message: 'Authentication failed.', severity: 'error' } });

    expect(isOnUsernameStep(tree)).toBe(true);
  });

  test('a non-error status still renders as a plain status line', () => {
    const { tree } = render({ status: { message: 'Account authenticated.', severity: 'success' } });

    expect(nodes(tree, 'registration-error')).toHaveLength(0);
    expect(hosts(tree, 'status-banner')[0].props.children).toBe('Account authenticated.');
  });
});

describe('RegistrationScreen accessibility announcements', () => {
  let announce: jest.SpyInstance;

  beforeEach(() => {
    announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation();
    announce.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('says nothing on arrival, then names each step the user is moved to', () => {
    const { tree } = render();
    expect(announce).not.toHaveBeenCalled();

    press(tree, 'registration-google');
    expect(announce).toHaveBeenLastCalledWith('Step 2 of 2. Choose your username');

    press(tree, 'registration-back');
    expect(announce).toHaveBeenLastCalledWith('Step 1 of 2. How do you want to sign in?');
    expect(announce).toHaveBeenCalledTimes(2);
  });

  test('announces a step the user did not ask for, when a failure moves them', () => {
    const { tree, onRegister } = render();
    press(tree, 'registration-google');
    typeInto(tree, 'registration-username-input', 'alice');
    press(tree, 'registration-submit');
    announce.mockClear();

    update(tree, {
      onRegister,
      status: { message: 'Enter a valid email address.', severity: 'error' },
    });

    expect(announce).toHaveBeenCalledWith('Step 1 of 2. How do you want to sign in?');
  });
});
