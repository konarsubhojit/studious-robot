import React from 'react';
import renderer, { act } from 'react-test-renderer';
import IncomingCallScreen from '../../src/components/IncomingCallScreen';

jest.mock(
  '../../src/components/IconButton',
  () => props => require('react').createElement('IconButton', props),
);
jest.mock(
  '../../src/components/StatusBanner',
  () => props => require('react').createElement('StatusBanner', props),
);

const DEFAULT_STATUS = { message: 'Incoming call from alice', severity: 'info' };

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

describe('IncomingCallScreen', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('renders without throwing', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(1);
  });

  test('displays the caller ID', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <IncomingCallScreen
          incomingCall={makeCall({ callerId: 'charlie' })}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    const nodes = tree.root.findAll(n => n.props.testID === 'incoming-caller-id');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].props.children).toBe('charlie');
  });

  test('derives avatar initials from multi-part caller IDs', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <IncomingCallScreen
          incomingCall={makeCall({ callerId: 'charlie-brown' })}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAll(node => node.props.children === 'CB').length).toBeGreaterThanOrEqual(
      1,
    );
  });

  test('renders Accept and Decline icon buttons', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    const buttons = tree.root.findAllByType('IconButton');
    expect(buttons).toHaveLength(2);
    const testIDs = buttons.map(b => b.props.testID);
    expect(testIDs).toContain('incoming-decline');
    expect(testIDs).toContain('incoming-accept');
  });

  test('calls onAccept when Accept button is pressed', () => {
    const onAccept = jest.fn();
    let tree;
    act(() => {
      tree = renderer.create(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={DEFAULT_STATUS}
          onAccept={onAccept}
          onDecline={jest.fn()}
        />,
      );
    });
    act(() => {
      const acceptBtn = tree.root
        .findAllByType('IconButton')
        .find(b => b.props.testID === 'incoming-accept');
      acceptBtn.props.onPress();
    });
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  test('calls onDecline when Decline button is pressed', () => {
    const onDecline = jest.fn();
    let tree;
    act(() => {
      tree = renderer.create(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={onDecline}
        />,
      );
    });
    act(() => {
      const declineBtn = tree.root
        .findAllByType('IconButton')
        .find(b => b.props.testID === 'incoming-decline');
      declineBtn.props.onPress();
    });
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  test('shows countdown when ringTimeoutAt is provided', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    const nodes = tree.root.findAll(n => n.props.testID === 'incoming-countdown');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
  });

  test('hides countdown when ringTimeoutAt is absent', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <IncomingCallScreen
          incomingCall={makeCall({ ringTimeoutAt: null })}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAll(n => n.props.testID === 'incoming-countdown')).toHaveLength(0);
  });

  test('falls back to "Unknown" caller ID when incomingCall is null', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <IncomingCallScreen
          incomingCall={null}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    const nodes = tree.root.findAll(n => n.props.testID === 'incoming-caller-id');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].props.children).toBe('Unknown');
  });
});
