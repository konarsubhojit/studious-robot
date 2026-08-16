import React from 'react';
import renderer, { act } from 'react-test-renderer';
import InCallBanner from '../../src/components/InCallBanner';

function findByTestId(tree, testID) {
  return tree.root.findAll(node => node.props?.testID === testID)[0] ?? null;
}

function render(props) {
  let tree;
  act(() => {
    tree = renderer.create(
      <InCallBanner
        participantLabel="Call with user-bob"
        elapsedCallSeconds={65}
        onExpand={jest.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

describe('InCallBanner', () => {
  test('renders the participant label and formatted duration', () => {
    const tree = render();
    const label = tree.root.findAll(n => n.props?.children === 'Call with user-bob');
    expect(label.length).toBeGreaterThan(0);
    const duration = tree.root.findAll(n => n.props?.children === '01:05');
    expect(duration.length).toBeGreaterThan(0);
  });

  test('falls back to a generic label when participantLabel is null', () => {
    const tree = render({ participantLabel: null });
    const label = tree.root.findAll(n => n.props?.children === 'Call in progress');
    expect(label.length).toBeGreaterThan(0);
  });

  test('tapping the banner calls onExpand', () => {
    const onExpand = jest.fn();
    const tree = render({ onExpand });
    act(() => {
      findByTestId(tree, 'in-call-banner').props.onPress();
    });
    expect(onExpand).toHaveBeenCalled();
  });

  test('exposes an accessible label naming the party being called', () => {
    const tree = render({ participantLabel: 'Call with user-bob' });
    const banner = findByTestId(tree, 'in-call-banner');
    expect(banner.props.accessibilityLabel).toBe('Return to call: Call with user-bob');
  });

  test('exposes a generic accessible label when there is no participant', () => {
    const tree = render({ participantLabel: null });
    const banner = findByTestId(tree, 'in-call-banner');
    expect(banner.props.accessibilityLabel).toBe('Return to call');
  });
});
