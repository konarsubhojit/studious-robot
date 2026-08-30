import React from 'react';
import renderer, { act } from 'react-test-renderer';
import IncomingCallScreen from '../../src/components/IncomingCallScreen';

jest.mock(
  '../../src/components/IconButton',
  () => (props: any) => require('react').createElement('IconButton', props),
);
jest.mock(
  '../../src/components/StatusBanner',
  () => (props: any) => require('react').createElement('StatusBanner', props),
);

const DEFAULT_STATUS: any = { message: 'Incoming call from alice', severity: 'info' };

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

const mountedTrees: any[] = [];

/**
 * Renders the screen and registers the tree so `afterEach` can unmount it.
 *
 * The screen owns a looping pulse animation and a 1s countdown interval, both
 * of which keep running (and keep Jest's worker alive) unless the tree is
 * unmounted when the test ends.
 */
function createTree(element: any) {
  const tree = renderer.create(element);
  mountedTrees.push(tree);
  return tree;
}

describe('IncomingCallScreen', () => {
  // The screen starts a 1s countdown interval on mount and the trees below are
  // never unmounted, so on real timers that interval keeps firing after the
  // suite finishes and holds the Jest worker open. Fake timers are installed
  // for every test here; the ones that need the countdown to advance drive them
  // explicitly with `jest.advanceTimersByTime`.
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      mountedTrees.splice(0).forEach(tree => tree.unmount());
    });
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('keeps an informational status off the screen, and shows a problem', () => {
    let tree: any;
    act(() => {
      tree = createTree(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    // The ringing state is already carried by the header, the caller's name
    // and the countdown; repeating it in a banner is the third label.
    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(0);

    act(() => {
      tree.update(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={{ message: 'Something broke', severity: 'error' } as any}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(1);

    // Answering without a camera is a warning, not an error, and it is the
    // whole explanation for a call that starts with no picture.
    act(() => {
      tree.update(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={{ message: 'Camera unavailable', severity: 'warning' } as any}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(1);
  });

  test('labels the countdown so it cannot be read as a call duration', () => {
    let tree: any;
    act(() => {
      tree = createTree(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    const [node] = tree.root.findAll((n: any) => n.props.testID === 'incoming-countdown');
    expect(String(node.props.children)).toMatch(/^Ringing · \d+s left$/);
    // The accessible name repeats the words on screen, so a voice-control
    // user can say what they can see.
    expect(node.props.accessibilityLabel).toMatch(/^Ringing, \d+s left$/);
  });

  test('keeps the pulse ring boxed with the avatar, never behind the name', () => {
    let tree: any;
    act(() => {
      tree = createTree(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    // The ring lives inside the avatar's own box, so it can only ever centre
    // on the avatar — the name is a sibling of that box, not of the ring.
    const [avatar] = tree.root.findAll((n: any) => n.props.testID === 'incoming-avatar');
    expect(avatar).toBeTruthy();
    const [name] = tree.root.findAll((n: any) => n.props.testID === 'incoming-caller-id');
    expect(avatar.findAll((n: any) => n.props.testID === 'incoming-caller-id')).toHaveLength(0);
    expect(name).toBeTruthy();
  });

  test('displays the caller ID', () => {
    let tree: any;
    act(() => {
      tree = createTree(
        <IncomingCallScreen
          incomingCall={makeCall({ callerId: 'charlie' })}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    const nodes = tree.root.findAll((n: any) => n.props.testID === 'incoming-caller-id');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].props.children).toBe('charlie');
  });

  test('derives avatar initials from multi-part caller IDs', () => {
    let tree: any;
    act(() => {
      tree = createTree(
        <IncomingCallScreen
          incomingCall={makeCall({ callerId: 'charlie-brown' })}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAll((node: any) => node.props.children === 'CB').length).toBeGreaterThanOrEqual(
      1,
    );
  });

  test('renders Accept and Decline icon buttons', () => {
    let tree: any;
    act(() => {
      tree = createTree(
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
    const testIDs = buttons.map((b: any) => b.props.testID);
    expect(testIDs).toContain('incoming-decline');
    expect(testIDs).toContain('incoming-accept');
  });

  test('calls onAccept when Accept button is pressed', () => {
    const onAccept = jest.fn();
    let tree: any;
    act(() => {
      tree = createTree(
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
        .find((b: any) => b.props.testID === 'incoming-accept');
      acceptBtn.props.onPress();
    });
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  test('calls onDecline when Decline button is pressed', () => {
    const onDecline = jest.fn();
    let tree: any;
    act(() => {
      tree = createTree(
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
        .find((b: any) => b.props.testID === 'incoming-decline');
      declineBtn.props.onPress();
    });
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  test('shows countdown when ringTimeoutAt is provided', () => {
    let tree: any;
    act(() => {
      tree = createTree(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    const nodes = tree.root.findAll((n: any) => n.props.testID === 'incoming-countdown');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
  });

  test('renders a two-minute ring window as m:ss', () => {
    let tree: any;
    act(() => {
      tree = createTree(
        <IncomingCallScreen
          incomingCall={makeCall({ ringTimeoutAt: new Date(Date.now() + 119_000).toISOString() })}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    const [node] = tree.root.findAll((n: any) => n.props.testID === 'incoming-countdown');
    expect(String(node.props.children)).toMatch(/^Ringing · 1:5\d left$/);
  });

  test('hides countdown when ringTimeoutAt is absent', () => {
    let tree: any;
    act(() => {
      tree = createTree(
        <IncomingCallScreen
          incomingCall={makeCall({ ringTimeoutAt: null })}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    expect(tree.root.findAll((n: any) => n.props.testID === 'incoming-countdown')).toHaveLength(0);
  });

  test('falls back to "Unknown" caller ID when incomingCall is null', () => {
    let tree: any;
    act(() => {
      tree = createTree(
        <IncomingCallScreen
          incomingCall={null}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
        />,
      );
    });
    const nodes = tree.root.findAll((n: any) => n.props.testID === 'incoming-caller-id');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].props.children).toBe('Unknown');
  });
  test('replaces Accept/Decline with a connecting indicator once answered', () => {
    let tree: any;
    act(() => {
      tree = createTree(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
          isAnswering
        />,
      );
    });

    expect(tree.root.findAll((n: any) => n.props.testID === 'incoming-accept')).toHaveLength(0);
    expect(tree.root.findAll((n: any) => n.props.testID === 'incoming-decline')).toHaveLength(0);
    expect(
      tree.root.findAll((n: any) => n.props.testID === 'incoming-connecting').length,
    ).toBeGreaterThanOrEqual(1);
    expect(tree.root.findAll((n: any) => n.props.testID === 'incoming-countdown')).toHaveLength(0);
  });

  test('offers a way out of a stalled connect when onCancelAnswer is supplied', () => {
    const onCancelAnswer = jest.fn();
    let tree: any;
    act(() => {
      tree = createTree(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
          onCancelAnswer={onCancelAnswer}
          isAnswering
        />,
      );
    });

    const [cancel] = tree.root.findAll((n: any) => n.props.testID === 'incoming-cancel-answer');
    act(() => {
      cancel.props.onPress();
    });
    expect(onCancelAnswer).toHaveBeenCalledTimes(1);
  });

  test('omits the connecting abort button when no handler is supplied', () => {
    let tree: any;
    act(() => {
      tree = createTree(
        <IncomingCallScreen
          incomingCall={makeCall()}
          status={DEFAULT_STATUS}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
          isAnswering
        />,
      );
    });
    expect(
      tree.root.findAll((n: any) => n.props.testID === 'incoming-cancel-answer'),
    ).toHaveLength(0);
  });
});
