import React from 'react';
import { Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import SwipeableRow from '../../src/components/SwipeableRow';

jest.mock('../../src/haptics', () => ({
  triggerHaptic: jest.fn(),
}));

function render(/** @type {any} */ actions: any) {
  /** @type {any} */
  let tree: any;
  act(() => {
    tree = renderer.create(
      <SwipeableRow actions={actions}>
        <Text>row content</Text>
      </SwipeableRow>,
    );
  });
  return tree;
}

/** The animated row is the only node carrying accessibility actions. */
function findActionableRow(/** @type {any} */ tree: any) {
  return tree.root.findAll((/** @type {any} */ node: any) => Array.isArray(node.props?.accessibilityActions))[0];
}

describe('SwipeableRow', () => {
  test('renders its child untouched when there is nothing to swipe for', () => {
    const tree = render([]);
    expect(tree.root.findAll((/** @type {any} */ node: any) => Array.isArray(node.props?.accessibilityActions))).toHaveLength(
      0,
    );
  });

  test('exposes every swipe action as an accessibility action', () => {
    const onPress = jest.fn();
    const tree = render([
      { key: 'delete', label: 'Delete', accessibilityLabel: 'Delete message', onPress },
    ]);

    const row = findActionableRow(tree);
    expect(row.props.accessibilityActions).toEqual([{ name: 'delete', label: 'Delete message' }]);

    act(() => {
      row.props.onAccessibilityAction({ nativeEvent: { actionName: 'delete' } });
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test('ignores an accessibility action that does not belong to this row', () => {
    const onPress = jest.fn();
    const tree = render([{ key: 'reply', label: 'Reply', onPress }]);

    act(() => {
      findActionableRow(tree).props.onAccessibilityAction({
        nativeEvent: { actionName: 'magicTap' },
      });
    });
    expect(onPress).not.toHaveBeenCalled();
  });

});
