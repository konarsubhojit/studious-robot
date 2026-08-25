import { act } from 'react-test-renderer';
import renderer from 'react-test-renderer';
import React from 'react';
import { Text } from 'react-native';
import useCallElapsedSeconds from '../../src/hooks/useCallElapsedSeconds';

const CONNECTED_AT_MS = 1_700_000_000_000;

function Probe({ connectedAtMs }: { connectedAtMs: number | null; }) {
  const elapsed = useCallElapsedSeconds(connectedAtMs);
  return <Text testID="elapsed">{String(elapsed)}</Text>;
}

function readElapsed(tree: any): number {
  const node = tree.root.findAll(
    (candidate: any) => typeof candidate.type === 'string' && candidate.props?.testID === 'elapsed',
  )[0];
  return Number(node.children.join(''));
}

describe('useCallElapsedSeconds', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(CONNECTED_AT_MS);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('reports zero when no call is connected', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<Probe connectedAtMs={null} />);
    });
    expect(readElapsed(tree)).toBe(0);

    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(readElapsed(tree)).toBe(0);
  });

  test('counts whole seconds since the call connected', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<Probe connectedAtMs={CONNECTED_AT_MS} />);
    });
    expect(readElapsed(tree)).toBe(0);

    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(readElapsed(tree)).toBe(3);
  });

  test('starts from the true elapsed time when mounted mid-call', () => {
    // Restoring a minimized call, or rehydrating one from a push, mounts the
    // consumer long after the call connected; starting from zero would show a
    // duration that disagrees with the one the user was just looking at.
    jest.setSystemTime(CONNECTED_AT_MS + 42_000);

    let tree: any;
    act(() => {
      tree = renderer.create(<Probe connectedAtMs={CONNECTED_AT_MS} />);
    });

    expect(readElapsed(tree)).toBe(42);
  });

  test('resets to zero when the call ends', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<Probe connectedAtMs={CONNECTED_AT_MS} />);
    });
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(readElapsed(tree)).toBe(4);

    act(() => {
      tree.update(<Probe connectedAtMs={null} />);
    });
    expect(readElapsed(tree)).toBe(0);
  });

  test('never reports a negative duration when the device clock moves backwards', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<Probe connectedAtMs={CONNECTED_AT_MS + 10_000} />);
    });

    expect(readElapsed(tree)).toBe(0);
  });

  test('stops ticking once unmounted', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<Probe connectedAtMs={CONNECTED_AT_MS} />);
    });

    act(() => {
      tree.unmount();
    });

    // A leaked interval would throw an update-after-unmount warning here.
    expect(() => {
      act(() => {
        jest.advanceTimersByTime(5000);
      });
    }).not.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });
});
