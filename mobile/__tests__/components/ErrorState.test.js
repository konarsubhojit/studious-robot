// @ts-check
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ErrorState from '../../src/components/ErrorState';
import { sizes } from '../../src/theme';

function render(/** @type {any} */ element) {
  /** @type {any} */
  let tree;
  act(() => {
    tree = renderer.create(element);
  });
  return tree;
}

describe('ErrorState', () => {
  test('announces itself as an alert with an explanation', () => {
    const tree = render(
      <ErrorState
        title="Server unreachable"
        description="Check your connection"
        onAction={() => {}}
        testID="error-state"
      />,
    );

    const container = tree.root.find(
      (/** @type {any} */ node) => typeof node.type === 'string' && node.props.testID === 'error-state',
    );
    expect(container.props.accessibilityRole).toBe('alert');
    expect(container.props.accessibilityLiveRegion).toBe('assertive');

    const texts = tree.root.findAll((/** @type {any} */ node) => node.type === 'Text').map((/** @type {any} */ node) => node.props.children);
    expect(texts).toContain('Server unreachable');
    expect(texts).toContain('Check your connection');
  });

  test('exposes a recovery action that clears the minimum touch target', () => {
    const onAction = jest.fn();
    const tree = render(
      <ErrorState
        title="Server unreachable"
        actionLabel="Retry"
        actionHint="Tries again"
        onAction={onAction}
        testID="error-state"
      />,
    );

    const action = tree.root.find((/** @type {any} */ node) => node.props.testID === 'error-state-action');
    expect(action.props.accessibilityRole).toBe('button');
    expect(action.props.accessibilityLabel).toBe('Retry');
    expect(action.props.accessibilityHint).toBe('Tries again');
    const style = action.props.style({ pressed: false }).find((/** @type {any} */ entry) => entry?.minHeight);
    expect(style.minHeight).toBe(sizes.minTouchTarget);

    act(() => {
      action.props.onPress();
    });
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test('hides the action when no handler is supplied', () => {
    const tree = render(<ErrorState title="Server unreachable" testID="error-state" />);
    expect(tree.root.findAll((/** @type {any} */ node) => node.props.testID === 'error-state-action')).toHaveLength(0);
  });

  test('renders nothing without a title', () => {
    const tree = render(<ErrorState description="orphan" />);
    expect(tree.toJSON()).toBeNull();
  });
});
