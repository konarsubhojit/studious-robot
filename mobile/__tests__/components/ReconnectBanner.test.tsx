import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ReconnectBanner from '../../src/components/ReconnectBanner';

function render(props?: any): any {
  let tree: any;
  act(() => {
    tree = renderer.create(<ReconnectBanner onRetry={jest.fn()} {...props} />);
  });
  return tree;
}

function textOf(tree: any): string {
  return tree.root
    .findAll((node: any) => typeof node.props?.children === 'string')
    .map((node: any) => node.props.children)
    .join(' | ');
}

function findRetry(tree: any): any {
  return (
    tree.root.findAll(
      (node: any) =>
        node.props?.children === 'Retry' || node.props?.accessibilityLabel === 'Retry',
    )[0] ?? null
  );
}

function recovery(overrides?: any): any {
  return {
    trigger: 'ice-failed',
    attempts: 2,
    remainingMs: 8000,
    isPaused: false,
    isAttemptPending: false,
    ...overrides,
  };
}

describe('ReconnectBanner', () => {
  test('names the attempt number of the running recovery episode', () => {
    const tree = render({ recovery: recovery() });
    expect(textOf(tree)).toContain('Restoring your call… (attempt 2)');
    expect(textOf(tree)).toContain('2 attempts so far');
  });

  test('says "Reconnecting" when the socket, not the media path, dropped', () => {
    const tree = render({ recovery: recovery({ trigger: 'socket-disconnect', attempts: 1 }) });
    expect(textOf(tree)).toContain('Reconnecting… (attempt 1)');
    expect(textOf(tree)).toContain('1 attempt so far');
  });

  test('offers manual retry only while no automatic attempt is in flight', () => {
    const onRetry = jest.fn();
    const idle = render({ onRetry, recovery: recovery() });
    expect(findRetry(idle)).not.toBeNull();
    expect(textOf(idle)).toContain('retry now if you would rather not wait');

    const pending = render({ onRetry, recovery: recovery({ isAttemptPending: true }) });
    expect(findRetry(pending)).toBeNull();
    expect(textOf(pending)).toContain('an attempt is running right now');
  });

  test('holds the call, without a countdown, while the device has no network', () => {
    const tree = render({ recovery: recovery({ isPaused: true }) });
    expect(textOf(tree)).toContain('Waiting for a network…');
    expect(textOf(tree)).toContain('recovery resumes the moment one is back');
  });

  test('reports an exhausted ladder as a lost connection with no retry', () => {
    const tree = render({ recovery: recovery(), isConnectionLost: true });
    expect(textOf(tree)).toContain('Connection lost');
    expect(findRetry(tree)).toBeNull();
  });

  test('falls back to a generic message when no episode is exposed', () => {
    const tree = render();
    expect(textOf(tree)).toContain('Reconnecting…');
    expect(textOf(tree)).not.toContain('attempt 0');
    expect(findRetry(tree)).not.toBeNull();
  });
});
