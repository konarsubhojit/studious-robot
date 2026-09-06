import React from 'react';
import renderer, { act } from 'react-test-renderer';
import StatusToast, { alertStatus } from '../../src/components/StatusToast';
import { TOAST_DURATION_MS } from '../../src/components/primitives/Toast';

/** @param status */
function render(status?: any) {
  let tree: any;
  act(() => {
    tree = renderer.create(<StatusToast status={status} />);
  });
  return tree;
}

/**
 * The bar, if it is actually on screen.
 *
 * `StatusToast` keeps its testID whether or not it renders anything, so only
 * host fibers distinguish "showing" from "not showing".
 */
const bar = (tree: any) =>
  tree.root
    .findAll((n: any) => n.props?.testID === 'status-toast')
    .filter((n: any) => typeof n.type === 'string');

const messages = (tree: any) =>
  tree.root
    .findAll((n: any) => typeof n.type === 'string' && n.type === 'Text')
    .flatMap((n: any) =>
      (Array.isArray(n.props?.children) ? n.props.children : [n.props?.children]).filter(
        (child: unknown) => typeof child === 'string',
      ),
    );

describe('StatusToast', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('surfaces an error', () => {
    const tree = render({ message: 'Authentication failed', severity: 'error' });

    expect(bar(tree)).not.toHaveLength(0);
    expect(messages(tree)).toContain('Authentication failed');
  });

  test('surfaces a warning', () => {
    expect(bar(render({ message: 'Rate limited', severity: 'warning' }))).not.toHaveLength(0);
  });

  test.each([['info'], ['success'], [undefined]])(
    'ignores %s severity, which belongs to the screen that caused it',
    severity => {
      expect(bar(render({ message: 'Camera switched', severity }))).toHaveLength(0);
    },
  );

  test('ignores a status with no message', () => {
    expect(bar(render({ message: '', severity: 'error' }))).toHaveLength(0);
    expect(bar(render(undefined))).toHaveLength(0);
  });

  test('dismisses itself so it cannot sit over the list forever', () => {
    const tree = render({ message: 'Rate limited', severity: 'error' });

    act(() => {
      jest.advanceTimersByTime(TOAST_DURATION_MS);
    });

    expect(bar(tree)).toHaveLength(0);
  });

  // The status slot is not cleared when a toast fades, so a dismissal must be
  // remembered against that specific message - otherwise re-rendering for any
  // unrelated reason brings the same stale failure straight back.
  test('stays dismissed while the same status is still set', () => {
    const status = { message: 'Rate limited', severity: 'error' } as const;
    const tree = render(status);

    act(() => {
      jest.advanceTimersByTime(TOAST_DURATION_MS);
    });
    act(() => {
      tree.update(<StatusToast status={{ ...status }} />);
    });

    expect(bar(tree)).toHaveLength(0);
  });

  test('re-arms for the next failure', () => {
    const tree = render({ message: 'Rate limited', severity: 'error' });

    act(() => {
      jest.advanceTimersByTime(TOAST_DURATION_MS);
    });
    act(() => {
      tree.update(<StatusToast status={{ message: 'Authentication failed', severity: 'error' }} />);
    });

    expect(bar(tree)).not.toHaveLength(0);
    expect(messages(tree)).toContain('Authentication failed');
  });
});

describe('alertStatus', () => {
  it('passes through the severities the bar shows', () => {
    const warning = { message: 'Rate limited', severity: 'warning' as const };
    const error = { message: 'Auth failed', severity: 'error' as const };
    expect(alertStatus(warning)).toBe(warning);
    expect(alertStatus(error)).toBe(error);
  });

  it('drops the severities that belong to the screen that caused them', () => {
    expect(alertStatus({ message: 'Calling bob…', severity: 'info' })).toBeUndefined();
    expect(alertStatus({ message: 'Connected', severity: 'success' })).toBeUndefined();
    expect(alertStatus(undefined)).toBeUndefined();
  });

  it('drops an alert with no message to say', () => {
    expect(alertStatus({ message: '', severity: 'error' })).toBeUndefined();
  });
});
