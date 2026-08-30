import React from 'react';
import renderer, { act } from 'react-test-renderer';
import CallEndSummary from '../../src/components/CallEndSummary';

function render(summary?: any, onDismiss = jest.fn()): any {
  let tree: any;
  act(() => {
    tree = renderer.create(
      <CallEndSummary
        summary={{
          direction: 'outgoing',
          status: 'ended',
          endReason: 'ended',
          durationSeconds: 65,
          quality: 'good',
          peerId: 'user-bob',
          ...summary,
        }}
        onDismiss={onDismiss}
      />,
    );
  });
  return tree;
}

function textOf(tree: any): string {
  return tree.root
    .findAll((node: any) => typeof node.props?.children === 'string')
    .map((node: any) => node.props.children)
    .join(' | ');
}

describe('CallEndSummary', () => {
  test('resolves a completed call with its peer and duration', () => {
    const tree = render();
    expect(textOf(tree)).toContain('Outgoing call with user-bob · 1:05');
  });

  test('uses the timeline vocabulary for a lost connection, and marks it a failure', () => {
    const tree = render({ endReason: 'media_failed', durationSeconds: 42 });
    expect(textOf(tree)).toContain('Connection lost');
    expect(tree.root.findAll((n: any) => n.props?.testID === 'call-end-summary').length)
      .toBeGreaterThan(0);
  });

  test('omits the duration for a call that never connected', () => {
    const tree = render({
      direction: 'incoming',
      status: 'missed',
      endReason: 'timeout',
      durationSeconds: 0,
    });
    const text = textOf(tree);
    expect(text).toContain('Missed call with user-bob');
    expect(text).not.toContain('·');
  });

  test('drops the peer clause when the summary has no peer', () => {
    const tree = render({ peerId: null });
    expect(textOf(tree)).toContain('Outgoing call · 1:05');
  });

  test('can be dismissed', () => {
    const onDismiss = jest.fn();
    const tree = render(undefined, onDismiss);
    const dismiss = tree.root.findAll(
      (n: any) =>
        n.props?.accessibilityLabel === 'Dismiss call summary' &&
        typeof n.props?.onPress === 'function',
    )[0];
    act(() => {
      dismiss.props.onPress();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
