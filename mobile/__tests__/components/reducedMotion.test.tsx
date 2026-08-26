import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Animated } from 'react-native';
import IncomingCallScreen from '../../src/components/IncomingCallScreen';
import OutgoingCallScreen from '../../src/components/OutgoingCallScreen';

const mockReduceMotion = jest.fn(() => false);
jest.mock('../../src/hooks/useReducedMotion', () => ({
  __esModule: true,
  default: () => mockReduceMotion(),
}));

jest.mock(
  '../../src/components/StatusBanner',
  () => (props: any) => require('react').createElement('StatusBanner', props),
);

/**
 * `Animated.loop` is the only thing under test here: whether the pulse is
 * started at all. Spying on it is more direct than inspecting a driven value.
 */
function withLoopSpy(run: () => void) {
  const stop = jest.fn();
  const start = jest.fn();
  const spy = jest.spyOn(Animated, 'loop').mockReturnValue({ start, stop } as any);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return { start, stop };
}

function renderIncoming() {
  let tree: any;
  act(() => {
    tree = renderer.create(
      <IncomingCallScreen
        incomingCall={{ callerId: 'user-bob', ringTimeoutAt: null } as any}
        status={{ message: '', severity: 'info' }}
        onAccept={jest.fn()}
        onDecline={jest.fn()}
      />,
    );
  });
  return tree;
}

function renderOutgoing() {
  let tree: any;
  act(() => {
    tree = renderer.create(
      <OutgoingCallScreen
        calleeId="user-bob"
        status={{ message: '', severity: 'info' }}
        onCancel={jest.fn()}
      />,
    );
  });
  return tree;
}

describe('ring pulses honour the reduce-motion preference', () => {
  let tree: any;

  afterEach(() => {
    if (tree) {
      act(() => {
        tree.unmount();
      });
      tree = null;
    }
    mockReduceMotion.mockReturnValue(false);
  });

  test('the incoming-call pulse runs by default', () => {
    const { start } = withLoopSpy(() => {
      tree = renderIncoming();
    });

    expect(start).toHaveBeenCalled();
  });

  test('the incoming-call pulse is not started under reduce motion', () => {
    mockReduceMotion.mockReturnValue(true);

    const { start } = withLoopSpy(() => {
      tree = renderIncoming();
    });

    expect(start).not.toHaveBeenCalled();
  });

  test('the outgoing-call pulse runs by default', () => {
    const { start } = withLoopSpy(() => {
      tree = renderOutgoing();
    });

    expect(start).toHaveBeenCalled();
  });

  test('the outgoing-call pulse is not started under reduce motion', () => {
    mockReduceMotion.mockReturnValue(true);

    const { start } = withLoopSpy(() => {
      tree = renderOutgoing();
    });

    expect(start).not.toHaveBeenCalled();
  });

  test('the screens still render their content with motion switched off', () => {
    mockReduceMotion.mockReturnValue(true);

    tree = renderIncoming();

    const texts = tree.root
      .findAll((n: any) => typeof n.type === 'string')
      .flatMap((n: any) =>
        (Array.isArray(n.props?.children) ? n.props.children : [n.props?.children]).filter(
          (child: unknown) => typeof child === 'string',
        ),
      );
    expect(texts).toContain('user-bob');
  });
});
