// @ts-check
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import OutgoingCallScreen from '../../src/components/OutgoingCallScreen';

jest.mock(
  '../../src/components/IconButton',
  () => (/** @type {any} */ props) => require('react').createElement('IconButton', props),
);
jest.mock(
  '../../src/components/StatusBanner',
  () => (/** @type {any} */ props) => require('react').createElement('StatusBanner', props),
);

/** @type {any} */
const DEFAULT_STATUS = { message: 'Ringing…', severity: 'info' };

/**
 * Test props are deliberately partial; the component under test is exercised
 * through the rendered output rather than its prop types.
 *
 * @returns {any}
 */
function makeCall(overrides = {}) {
  return {
    callId: 'call-1',
    callerId: 'alice',
    calleeId: 'bob',
    status: 'ringing',
    ringTimeoutAt: new Date(Date.now() + 30_000).toISOString(),
    ...overrides,
  };
}

describe('OutgoingCallScreen', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('renders without throwing', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          calleeId="bob"
          activeCall={makeCall()}
          status={DEFAULT_STATUS}
          onCancel={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(1);
  });

  test('displays the callee ID', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          calleeId="charlie"
          activeCall={makeCall({ calleeId: 'charlie' })}
          status={DEFAULT_STATUS}
          onCancel={jest.fn()}
        />,
      );
    });
    const nodes = tree.root.findAll((/** @type {any} */ n) => n.props.testID === 'outgoing-callee-id');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].props.children).toBe('charlie');
  });

  test('derives avatar initials from multi-part callee IDs', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          calleeId="charlie_brown"
          activeCall={makeCall({ calleeId: 'charlie_brown' })}
          status={DEFAULT_STATUS}
          onCancel={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAll((/** @type {any} */ node) => node.props.children === 'CB').length).toBeGreaterThanOrEqual(
      1,
    );
  });

  test('renders Cancel icon button', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          calleeId="bob"
          activeCall={makeCall()}
          status={DEFAULT_STATUS}
          onCancel={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAllByType('IconButton')).toHaveLength(1);
    expect(tree.root.findAllByType('IconButton')[0].props.testID).toBe('outgoing-cancel');
  });

  test('calls onCancel when Cancel button is pressed', () => {
    const onCancel = jest.fn();
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          calleeId="bob"
          activeCall={makeCall()}
          status={DEFAULT_STATUS}
          onCancel={onCancel}
        />,
      );
    });
    act(() => {
      tree.root.findAllByType('IconButton')[0].props.onPress();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('shows countdown when ringTimeoutAt is provided', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          calleeId="bob"
          activeCall={makeCall()}
          status={DEFAULT_STATUS}
          onCancel={jest.fn()}
        />,
      );
    });
    const nodes = tree.root.findAll((/** @type {any} */ n) => n.props.testID === 'outgoing-countdown');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
  });

  test('renders a two-minute ring window as m:ss', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          activeCall={makeCall({ ringTimeoutAt: new Date(Date.now() + 119_000).toISOString() })}
          status={DEFAULT_STATUS}
          onCancel={jest.fn()}
        />,
      );
    });
    const [node] = tree.root.findAll((/** @type {any} */ n) => n.props.testID === 'outgoing-countdown');
    expect(String(node.props.children)).toMatch(/^1:5\d$/);
  });

  test('hides countdown when ringTimeoutAt is absent', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          calleeId="bob"
          activeCall={makeCall({ ringTimeoutAt: null })}
          status={DEFAULT_STATUS}
          onCancel={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAll((/** @type {any} */ n) => n.props.testID === 'outgoing-countdown')).toHaveLength(0);
  });

  test('falls back to "Unknown" when calleeId is empty', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          calleeId=""
          activeCall={null}
          status={DEFAULT_STATUS}
          onCancel={jest.fn()}
        />,
      );
    });
    const nodes = tree.root.findAll((/** @type {any} */ n) => n.props.testID === 'outgoing-callee-id');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].props.children).toBe('Unknown');
  });
});
