import React from 'react';
import renderer, { act } from 'react-test-renderer';
import OutgoingCallScreen from '../../src/components/OutgoingCallScreen';

jest.mock('../../src/components/AppButton', () => (props) =>
  require('react').createElement('AppButton', props),
);
jest.mock('../../src/components/StatusBanner', () => (props) =>
  require('react').createElement('StatusBanner', props),
);

const DEFAULT_STATUS = { message: 'Ringing…', severity: 'info' };

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
    const nodes = tree.root.findAll((n) => n.props.testID === 'outgoing-callee-id');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].props.children).toBe('charlie');
  });

  test('renders Cancel button', () => {
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
    // findAllByType uses string match against mock-created elements, returning exactly 1.
    expect(tree.root.findAllByType('AppButton')).toHaveLength(1);
    expect(tree.root.findAllByType('AppButton')[0].props.testID).toBe('outgoing-cancel');
  });

  test('calls onCancel when Cancel button is pressed', () => {
    const onCancel = jest.fn();
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
      tree.root.findAllByType('AppButton')[0].props.onPress();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('shows countdown when ringTimeoutAt is provided', () => {
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
    const nodes = tree.root.findAll((n) => n.props.testID === 'outgoing-countdown');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
  });

  test('hides countdown when ringTimeoutAt is absent', () => {
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
    expect(tree.root.findAll((n) => n.props.testID === 'outgoing-countdown')).toHaveLength(0);
  });

  test('falls back to "Unknown" when calleeId is empty', () => {
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
    const nodes = tree.root.findAll((n) => n.props.testID === 'outgoing-callee-id');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].props.children).toBe('Unknown');
  });
});
