import React from 'react';
import renderer, { act } from 'react-test-renderer';
import RegistrationScreen from '../../src/components/RegistrationScreen';

jest.mock(
  '../../src/components/AppButton',
  () => (/** @type {any} */ props: any) => require('react').createElement('AppButton', props),
);

describe('RegistrationScreen', () => {
  test('renders without throwing', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<RegistrationScreen onRegister={jest.fn()} />);
    });
    expect(tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'registration-username-input')).toHaveLength(
      2,
    ); // composite + host fibers
  });

  test('renders all supported sign-in methods', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<RegistrationScreen onRegister={jest.fn()} />);
    });
    const buttons = tree.root.findAllByType('AppButton');
    expect(buttons.map((/** @type {any} */ button: any) => button.props.testID)).toEqual([
      'registration-email-register',
      'registration-email-sign-in',
      'registration-google',
      'registration-microsoft',
    ]);
  });

  test('renders email and password inputs', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<RegistrationScreen onRegister={jest.fn()} />);
    });
    expect(
      tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'registration-email-input'),
    ).toHaveLength(2);
    expect(
      tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'registration-password-input'),
    ).toHaveLength(2);
  });

  test('Get Started button is disabled when input is empty', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<RegistrationScreen onRegister={jest.fn()} />);
    });
    const btn = tree.root
      .findAllByType('AppButton')
      .find((/** @type {any} */ button: any) => button.props.testID === 'registration-email-register');
    expect(btn.props.disabled).toBe(true);
  });

  test('shows loading state when isLoading is true', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<RegistrationScreen onRegister={jest.fn()} isLoading />);
    });
    const btn = tree.root.findAllByType('AppButton')[0];
    expect(btn.props.title).toBe('Setting up…');
    expect(btn.props.disabled).toBe(true);
  });

  test('submits email registration fields', () => {
    const onRegister = jest.fn();
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<RegistrationScreen onRegister={onRegister} />);
    });

    act(() => {
      tree.root
        .findAll((/** @type {any} */ n: any) => n.props.testID === 'registration-username-input')[0]
        .props.onChangeText(' alice ');
      tree.root
        .findAll((/** @type {any} */ n: any) => n.props.testID === 'registration-email-input')[0]
        .props.onChangeText(' alice@example.com ');
      tree.root
        .findAll((/** @type {any} */ n: any) => n.props.testID === 'registration-password-input')[0]
        .props.onChangeText('secret12');
    });

    act(() => {
      tree.root
        .findAllByType('AppButton')
        .find((/** @type {any} */ button: any) => button.props.testID === 'registration-email-register')
        .props.onPress();
    });

    expect(onRegister).toHaveBeenCalledWith({
      userId: 'alice',
      method: 'email-register',
      email: 'alice@example.com',
      password: 'secret12',
    });
  });

  test('disables provider buttons when providers are unconfigured', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(
        <RegistrationScreen
          onRegister={jest.fn()}
          isGoogleSignInAvailable={false}
          isMicrosoftSignInAvailable={false}
        />,
      );
    });

    const googleButton = tree.root
      .findAllByType('AppButton')
      .find((/** @type {any} */ button: any) => button.props.testID === 'registration-google');
    const microsoftButton = tree.root
      .findAllByType('AppButton')
      .find((/** @type {any} */ button: any) => button.props.testID === 'registration-microsoft');

    expect(googleButton.props.disabled).toBe(true);
    expect(googleButton.props.title).toMatch(/unavailable/i);
    expect(microsoftButton.props.disabled).toBe(true);
    expect(microsoftButton.props.title).toMatch(/unavailable/i);
  });

  test('surfaces a failed sign-in as an error state that retries the last attempt', () => {
    const onRegister = jest.fn();
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(
        <RegistrationScreen
          onRegister={onRegister}
          status={{ message: 'Server unreachable', severity: 'error' }}
        />,
      );
    });

    // No attempt yet: the error is explained, but there is nothing to retry.
    expect(
      tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'registration-error').length,
    ).toBeGreaterThanOrEqual(1);
    expect(tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'registration-error-action')).toHaveLength(0);

    act(() => {
      tree.root
        .findAll((/** @type {any} */ n: any) => n.props.testID === 'registration-username-input')[0]
        .props.onChangeText('alice');
    });
    act(() => {
      tree.root
        .findAll((/** @type {any} */ n: any) => n.props.testID === 'registration-email-input')[0]
        .props.onChangeText('alice@example.com');
    });
    act(() => {
      tree.root
        .findAll((/** @type {any} */ n: any) => n.props.testID === 'registration-password-input')[0]
        .props.onChangeText('secret12');
    });
    act(() => {
      tree.root
        .findAllByType('AppButton')
        .find((/** @type {any} */ button: any) => button.props.testID === 'registration-email-register')
        .props.onPress();
    });
    expect(onRegister).toHaveBeenCalledTimes(1);

    const retry = tree.root.find(
      (/** @type {any} */ n: any) => n.props?.testID === 'registration-error-action' && typeof n.props.onPress === 'function',
    );
    act(() => {
      retry.props.onPress();
    });

    expect(onRegister).toHaveBeenCalledTimes(2);
    expect(onRegister).toHaveBeenLastCalledWith({
      userId: 'alice',
      method: 'email-register',
      email: 'alice@example.com',
      password: 'secret12',
    });
  });
});
