import React from 'react';
import renderer, { act } from 'react-test-renderer';
import RegistrationScreen from '../../src/components/RegistrationScreen';

jest.mock('../../src/components/AppButton', () => (props) =>
  require('react').createElement('AppButton', props),
);

describe('RegistrationScreen', () => {
  test('renders without throwing', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <RegistrationScreen onRegister={jest.fn()} />,
      );
    });
    expect(
      tree.root.findAll((n) => n.props.testID === 'registration-username-input'),
    ).toHaveLength(2); // composite + host fibers
  });

  test('renders Get Started button', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <RegistrationScreen onRegister={jest.fn()} />,
      );
    });
    const buttons = tree.root.findAllByType('AppButton');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.testID).toBe('registration-submit');
  });

  test('renders optional recovery code input', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <RegistrationScreen onRegister={jest.fn()} />,
      );
    });
    expect(
      tree.root.findAll((n) => n.props.testID === 'registration-recovery-code-input'),
    ).toHaveLength(2);
  });

  test('Get Started button is disabled when input is empty', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <RegistrationScreen onRegister={jest.fn()} />,
      );
    });
    const btn = tree.root.findAllByType('AppButton')[0];
    expect(btn.props.disabled).toBe(true);
  });

  test('shows loading state when isLoading is true', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <RegistrationScreen onRegister={jest.fn()} isLoading />,
      );
    });
    const btn = tree.root.findAllByType('AppButton')[0];
    expect(btn.props.title).toBe('Setting up…');
    expect(btn.props.disabled).toBe(true);
  });

  test('submits the username and optional recovery code', () => {
    const onRegister = jest.fn();
    let tree;
    act(() => {
      tree = renderer.create(
        <RegistrationScreen onRegister={onRegister} />,
      );
    });

    act(() => {
      tree.root.findAll((n) => n.props.testID === 'registration-username-input')[0]
        .props.onChangeText(' alice ');
      tree.root.findAll((n) => n.props.testID === 'registration-recovery-code-input')[0]
        .props.onChangeText(' abcd-efgh ');
    });

    act(() => {
      tree.root.findAllByType('AppButton')[0].props.onPress();
    });

    expect(onRegister).toHaveBeenCalledWith('alice', 'ABCD-EFGH');
  });
});
