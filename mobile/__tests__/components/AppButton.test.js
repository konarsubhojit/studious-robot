import React from 'react';
import renderer, { act } from 'react-test-renderer';
import AppButton from '../../src/components/AppButton';

describe('AppButton', () => {
  test('renders with button a11y role and fires onPress', () => {
    const onPress = jest.fn();
    let tree;
    act(() => {
      tree = renderer.create(
        <AppButton title="Join Room" onPress={onPress} testID="join" />,
      );
    });

    const pressable = tree.root.find((n) => n.props.testID && n.props.accessibilityRole === 'button' && (n.type.displayName || n.type.name) === 'Pressable');
    expect(pressable.props.accessibilityRole).toBe('button');
    expect(pressable.props.accessibilityLabel).toBe('Join Room');
    expect(pressable.props.accessibilityState).toEqual({ disabled: false, selected: false });

    act(() => {
      pressable.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test('marks itself disabled in props and a11y state', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <AppButton title="Mute" onPress={() => {}} disabled testID="mute" />,
      );
    });

    const pressable = tree.root.find((n) => n.props.testID && n.props.accessibilityRole === 'button' && (n.type.displayName || n.type.name) === 'Pressable');
    expect(pressable.props.disabled).toBe(true);
    expect(pressable.props.accessibilityState).toEqual({ disabled: true, selected: false });
  });

  test('reflects the active (selected) accessibility state', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <AppButton title="Muted" onPress={() => {}} active testID="active" />,
      );
    });

    const pressable = tree.root.find((n) => n.props.testID && n.props.accessibilityRole === 'button' && (n.type.displayName || n.type.name) === 'Pressable');
    expect(pressable.props.accessibilityState).toEqual({ disabled: false, selected: true });
  });
});
