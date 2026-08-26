import React from 'react';
import { Text } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import renderer, { act } from 'react-test-renderer';
import SwipeableRow from '../../src/components/SwipeableRow';
import { triggerHaptic } from '../../src/haptics';

jest.mock('../../src/haptics', () => ({
  triggerHaptic: jest.fn(),
}));

/**
 * Captures the pan gesture the component builds so a swipe can be driven
 * without a real touch stream.  The shared gesture-handler mock records each
 * callback on the builder it returns.
 */
let lastPan: any;
const realPan = Gesture.Pan;
beforeEach(() => {
  jest.clearAllMocks();
  (Gesture as any).Pan = () => {
    lastPan = realPan();
    return lastPan;
  };
});
afterAll(() => {
  (Gesture as any).Pan = realPan;
});

/** Reads the translateX currently applied to the animated row. */
function readTranslate(tree: any) {
  tree.rerender();
  const styles = ([] as any[]).concat(findActionableRow(tree).props.style);
  return styles.find(style => style?.transform)?.transform[0].translateX;
}

function swipe(distance: number) {
  act(() => {
    lastPan.handlers.onStart();
    lastPan.handlers.onUpdate({ translationX: distance });
    lastPan.handlers.onEnd();
  });
}

function render(actions: any) {
  const element = () => (
    <SwipeableRow actions={actions}>
      <Text>row content</Text>
    </SwipeableRow>
  );
  let tree: any;
  act(() => {
    tree = renderer.create(element());
  });
  // Shared values live outside React state, so a re-render is what publishes
  // the latest `useAnimatedStyle` output to the test renderer's tree — on a
  // device that job belongs to the UI thread instead.  The element has to be
  // rebuilt each time: React skips a re-render of a referentially identical
  // element, which would keep the stale transform on screen.
  tree.rerender = () => act(() => tree.update(element()));
  return tree;
}

/** The animated row is the only node carrying accessibility actions. */
function findActionableRow(tree: any) {
  return tree.root.findAll((node: any) => Array.isArray(node.props?.accessibilityActions))[0];
}

describe('SwipeableRow', () => {
  test('renders its child untouched when there is nothing to swipe for', () => {
    const tree = render([]);
    expect(tree.root.findAll((node: any) => Array.isArray(node.props?.accessibilityActions))).toHaveLength(
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

  test('latches the tray open past the halfway point and confirms with a tap', () => {
    // One action means an 88dp tray (84 + 4 margin), so the halfway point is 44dp.
    const tree = render([{ key: 'delete', label: 'Delete', onPress: jest.fn() }]);

    swipe(-60);

    expect(readTranslate(tree)).toBe(-88);
    expect(triggerHaptic).toHaveBeenCalledWith('tap');
  });

  test('springs shut when the drag stops short of the halfway point', () => {
    const tree = render([{ key: 'delete', label: 'Delete', onPress: jest.fn() }]);

    swipe(-20);

    expect(readTranslate(tree)).toBe(0);
    expect(triggerHaptic).not.toHaveBeenCalled();
  });

  test('clamps the drag to the tray so the row cannot be pulled off its actions', () => {
    const tree = render([{ key: 'delete', label: 'Delete', onPress: jest.fn() }]);

    act(() => {
      lastPan.handlers.onStart();
      lastPan.handlers.onUpdate({ translationX: -400 });
    });
    expect(readTranslate(tree)).toBe(-88);

    // A rightward drag past the closed position must not lift the row either.
    act(() => {
      lastPan.handlers.onUpdate({ translationX: 400 });
    });
    expect(readTranslate(tree)).toBe(0);
  });

  test('does not re-tick the haptic when an already-open tray is swiped again', () => {
    render([{ key: 'delete', label: 'Delete', onPress: jest.fn() }]);

    swipe(-60);
    expect(triggerHaptic).toHaveBeenCalledTimes(1);

    // Starting from the open position and staying open is not a new latch.
    swipe(-10);
    expect(triggerHaptic).toHaveBeenCalledTimes(1);
  });

  test('closes the tray when an action is pressed', () => {
    const onPress = jest.fn();
    const tree = render([{ key: 'delete', label: 'Delete', testID: 'row-delete', onPress }]);

    swipe(-60);
    expect(readTranslate(tree)).toBe(-88);

    act(() => {
      tree.root.findAll((node: any) => node.props?.testID === 'row-delete')[0].props.onPress();
    });

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(readTranslate(tree)).toBe(0);
  });
});

describe('SwipeableRow — tray width regression', () => {
  const { ACTION_SLOT_WIDTH } = require('../../src/components/SwipeableRow');

  test.each([1, 2, 3])(
    'open translation equals full rendered tray width for %i action(s)',
    count => {
      const actions = Array.from({ length: count }, (_, i) => ({
        key: `action-${i}`,
        label: `A${i}`,
        onPress: jest.fn(),
      }));
      const tree = render(actions);
      const expectedTrayWidth = count * ACTION_SLOT_WIDTH;

      // Swipe far enough to latch open
      swipe(-expectedTrayWidth);

      expect(readTranslate(tree)).toBe(-expectedTrayWidth);
    },
  );

  test('every action in a multi-action tray is individually reachable and invokes the right callback', () => {
    const callbacks = [jest.fn(), jest.fn(), jest.fn()];
    const actions = callbacks.map((fn, i) => ({
      key: `act-${i}`,
      label: `Act ${i}`,
      testID: `tray-action-${i}`,
      onPress: fn,
    }));
    const tree = render(actions);

    // Open the tray
    swipe(-actions.length * ACTION_SLOT_WIDTH);

    // Press each action individually
    for (let i = 0; i < actions.length; i++) {
      act(() => {
        tree.root
          .findAll((node: any) => node.props?.testID === `tray-action-${i}`)[0]
          .props.onPress();
      });
    }

    for (let i = 0; i < callbacks.length; i++) {
      expect(callbacks[i]).toHaveBeenCalledTimes(1);
    }
  });
});
