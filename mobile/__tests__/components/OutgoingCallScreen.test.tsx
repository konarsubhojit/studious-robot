import React from 'react';
import renderer, { act } from 'react-test-renderer';
import OutgoingCallScreen from '../../src/components/OutgoingCallScreen';

jest.mock(
  '../../src/components/IconButton',
  () => (props: any) => require('react').createElement('IconButton', props),
);
jest.mock(
  '../../src/components/StatusBanner',
  () => (props: any) => require('react').createElement('StatusBanner', props),
);

const DEFAULT_STATUS: any = { message: 'Ringing…', severity: 'info' };

/**
 * Test props are deliberately partial; the component under test is exercised
 * through the rendered output rather than its prop types.
 */
function makeCall(overrides = {}): any {
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

  test('keeps an informational status off the screen, and shows a problem', () => {
    let tree: any;
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
    // "Ringing bob…" repeats the header, the name and the countdown; only a
    // problem the user has to know about earns the banner.
    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(0);

    act(() => {
      tree.update(
        <OutgoingCallScreen
          calleeId="bob"
          activeCall={makeCall()}
          status={{ message: 'Callee is unreachable', severity: 'error' } as any}
          onCancel={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(1);
  });

  test('says the callee is ringing rather than only counting down', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          calleeId="bob"
          activeCall={makeCall()}
          delivery="ringing"
          status={DEFAULT_STATUS}
          onCancel={jest.fn()}
        />,
      );
    });
    const [node] = tree.root.findAll((n: any) => n.props.testID === 'outgoing-countdown');
    expect(String(node.props.children)).toMatch(/^Ringing on their device · /);
  });

  test('says a sleeping callee is being woken, so silence is not read as a hang', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          calleeId="bob"
          activeCall={makeCall()}
          delivery="push"
          status={DEFAULT_STATUS}
          onCancel={jest.fn()}
        />,
      );
    });
    const [node] = tree.root.findAll((n: any) => n.props.testID === 'outgoing-countdown');
    expect(String(node.props.children)).toMatch(/^Waking their phone · /);
    expect(node.props.accessibilityLabel).toBe('Waking their phone. Rings for 30s');
  });

  test('still says how the callee is being reached without a ring window', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          calleeId="bob"
          activeCall={makeCall({ ringTimeoutAt: null })}
          delivery="push"
          status={DEFAULT_STATUS}
          onCancel={jest.fn()}
        />,
      );
    });
    const [node] = tree.root.findAll((n: any) => n.props.testID === 'outgoing-delivery');
    expect(String(node.props.children)).toBe('Waking their phone');
  });

  test('keeps the pulse ring boxed with the avatar, never behind the name', () => {
    let tree: any;
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
    const [avatar] = tree.root.findAll((n: any) => n.props.testID === 'outgoing-avatar');
    expect(avatar).toBeTruthy();
    expect(avatar.findAll((n: any) => n.props.testID === 'outgoing-callee-id')).toHaveLength(0);
  });

  test('displays the callee ID', () => {
    let tree: any;
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
    const nodes = tree.root.findAll((n: any) => n.props.testID === 'outgoing-callee-id');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].props.children).toBe('charlie');
  });

  test('derives avatar initials from multi-part callee IDs', () => {
    let tree: any;
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
    expect(tree.root.findAll((node: any) => node.props.children === 'CB').length).toBeGreaterThanOrEqual(
      1,
    );
  });

  test('renders Cancel icon button', () => {
    let tree: any;
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
    let tree: any;
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
    let tree: any;
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
    const nodes = tree.root.findAll((n: any) => n.props.testID === 'outgoing-countdown');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
  });

  test('renders a two-minute ring window as m:ss', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(
        <OutgoingCallScreen
          activeCall={makeCall({ ringTimeoutAt: new Date(Date.now() + 119_000).toISOString() })}
          status={DEFAULT_STATUS}
          onCancel={jest.fn()}
        />,
      );
    });
    const [node] = tree.root.findAll((n: any) => n.props.testID === 'outgoing-countdown');
    expect(String(node.props.children)).toMatch(/^Ringing · 1:5\d left$/);
  });

  test('hides countdown when ringTimeoutAt is absent', () => {
    let tree: any;
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
    expect(tree.root.findAll((n: any) => n.props.testID === 'outgoing-countdown')).toHaveLength(0);
  });

  test('falls back to "Unknown" when calleeId is empty', () => {
    let tree: any;
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
    const nodes = tree.root.findAll((n: any) => n.props.testID === 'outgoing-callee-id');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].props.children).toBe('Unknown');
  });
});
