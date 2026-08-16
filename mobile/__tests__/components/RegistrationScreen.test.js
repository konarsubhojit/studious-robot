import React from 'react';
import renderer, { act } from 'react-test-renderer';
import RegistrationScreen from '../../src/components/RegistrationScreen';

jest.mock(
  '../../src/components/AppButton',
  () => props => require('react').createElement('AppButton', props),
);

describe('RegistrationScreen', () => {
  test('renders without throwing', () => {
    let tree;
    act(() => {
      tree = renderer.create(<RegistrationScreen onRegister={jest.fn()} />);
    });
    expect(tree.root.findAll(n => n.props.testID === 'registration-username-input')).toHaveLength(
      2,
    ); // composite + host fibers
  });

  test('renders all supported sign-in methods', () => {
    let tree;
    act(() => {
      tree = renderer.create(<RegistrationScreen onRegister={jest.fn()} />);
    });
    const buttons = tree.root.findAllByType('AppButton');
    expect(buttons.map(button => button.props.testID)).toEqual([
      'registration-email-register',
      'registration-email-sign-in',
      'registration-google',
      'registration-microsoft',
    ]);
  });

  test('renders email and password inputs', () => {
    let tree;
    act(() => {
      tree = renderer.create(<RegistrationScreen onRegister={jest.fn()} />);
    });
    expect(
      tree.root.findAll(n => n.props.testID === 'registration-email-input'),
    ).toHaveLength(2);
    expect(
      tree.root.findAll(n => n.props.testID === 'registration-password-input'),
    ).toHaveLength(2);
  });

  test('Get Started button is disabled when input is empty', () => {
    let tree;
    act(() => {
      tree = renderer.create(<RegistrationScreen onRegister={jest.fn()} />);
    });
    const btn = tree.root
      .findAllByType('AppButton')
      .find(button => button.props.testID === 'registration-email-register');
    expect(btn.props.disabled).toBe(true);
  });

  test('shows loading state when isLoading is true', () => {
    let tree;
    act(() => {
      tree = renderer.create(<RegistrationScreen onRegister={jest.fn()} isLoading />);
    });
    const btn = tree.root.findAllByType('AppButton')[0];
    expect(btn.props.title).toBe('Setting up…');
    expect(btn.props.disabled).toBe(true);
  });

  test('submits email registration fields', () => {
    const onRegister = jest.fn();
    let tree;
    act(() => {
      tree = renderer.create(<RegistrationScreen onRegister={onRegister} />);
    });

    act(() => {
      tree.root
        .findAll(n => n.props.testID === 'registration-username-input')[0]
        .props.onChangeText(' alice ');
      tree.root
        .findAll(n => n.props.testID === 'registration-email-input')[0]
        .props.onChangeText(' alice@example.com ');
      tree.root
        .findAll(n => n.props.testID === 'registration-password-input')[0]
        .props.onChangeText('secret12');
    });

    act(() => {
      tree.root
        .findAllByType('AppButton')
        .find(button => button.props.testID === 'registration-email-register')
        .props.onPress();
    });

    expect(onRegister).toHaveBeenCalledWith({
      userId: 'alice',
      method: 'email-register',
      email: 'alice@example.com',
      password: 'secret12',
    });
  });
});
