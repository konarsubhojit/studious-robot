import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Banner } from '../../src/components/primitives';

function render(props: any) {
  let tree: any;
  act(() => {
    tree = renderer.create(<Banner {...props} />);
  });
  return tree;
}

/**
 * The host node, not the composite: `Banner` itself receives `testID` as a
 * prop, so the first match is the component and carries none of the rendered
 * accessibility attributes.
 */
function findByTestId(tree: any, testID: string) {
  return (
    tree.root.findAll(
      (node: any) => node.props?.testID === testID && typeof node.type === 'string',
    )[0] ?? null
  );
}

function pressByTestID(tree: any, testID: string) {
  const node = tree.root.findAll(
    (n: any) => n.props?.testID === testID && typeof n.props?.onPress === 'function',
  )[0];
  if (!node) throw new Error(`No pressable node with testID "${testID}"`);
  act(() => {
    node.props.onPress();
  });
}

function textsOf(tree: any): string[] {
  return tree.root
    .findAll((n: any) => typeof n.type === 'string')
    .flatMap((n: any) =>
      (Array.isArray(n.props?.children) ? n.props.children : [n.props?.children]).filter(
        (child: unknown) => typeof child === 'string',
      ),
    );
}

describe('Banner', () => {
  test('states the condition and announces it politely', () => {
    const tree = render({ message: 'Offline — messages will send', testID: 'b' });

    expect(textsOf(tree)).toContain('Offline — messages will send');
    expect(findByTestId(tree, 'b').props.accessibilityLiveRegion).toBe('polite');
  });

  test('renders no action and no dismiss by default', () => {
    const tree = render({ message: 'Offline', testID: 'b' });

    expect(findByTestId(tree, 'b-action')).toBeNull();
    expect(findByTestId(tree, 'b-dismiss')).toBeNull();
  });

  test('derives the action testID from the banner testID, as ErrorState does', () => {
    const onAction = jest.fn();
    const tree = render({
      message: 'Offline',
      actionLabel: 'Retry',
      onAction,
      testID: 'offline-banner',
    });

    pressByTestID(tree, 'offline-banner-action');

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test('an action label with no handler renders nothing pressable', () => {
    const tree = render({ message: 'Offline', actionLabel: 'Retry', testID: 'b' });

    expect(findByTestId(tree, 'b-action')).toBeNull();
  });

  test('dismisses through the derived dismiss testID', () => {
    const onDismiss = jest.fn();
    const tree = render({
      message: 'Replying to: hello',
      onDismiss,
      dismissLabel: 'Cancel reply',
      testID: 'reply',
    });

    pressByTestID(tree, 'reply-dismiss');

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('explicit testIDs win over the derived ones', () => {
    const tree = render({
      message: 'Offline',
      actionLabel: 'Retry',
      onAction: jest.fn(),
      actionTestID: 'custom-action',
      testID: 'b',
    });

    expect(findByTestId(tree, 'custom-action')).not.toBeNull();
    expect(findByTestId(tree, 'b-action')).toBeNull();
  });

  test('carries the accessibility role and value a progress banner needs', () => {
    const tree = render({
      message: 'Uploading… 40%',
      accessibilityRole: 'progressbar',
      accessibilityValue: { now: 40, min: 0, max: 100 },
      testID: 'upload',
    });

    const banner = findByTestId(tree, 'upload');
    expect(banner.props.accessibilityRole).toBe('progressbar');
    expect(banner.props.accessibilityValue).toEqual({ now: 40, min: 0, max: 100 });
  });

  test('tints its icon to match the sentence, in every tone', () => {
    for (const tone of ['neutral', 'warning', 'negative', 'accent'] as const) {
      const tree = render({ message: 'Condition', tone, testID: 'b' });
      const icons = tree.root.findAll(
        (n: any) => typeof n.props?.color === 'string' && typeof n.props?.size === 'number',
      );
      expect(icons.length).toBeGreaterThan(0);
      expect(icons[0].props.color).toBeTruthy();
    }
  });

  test('lets its message reflow rather than clipping it at a fixed line count', () => {
    const message =
      'Calling may not work reliably: Microphone permission is denied; Notifications are disabled';
    const tree = render({ message, testID: 'b' });

    // A banner is padding-only and every caller stacks it in a column that
    // grows, so at 200% the sentence has somewhere to go. The two-line clamp
    // this used to carry truncated the condition mid-sentence instead.
    const text = tree.root.findAll((n: any) => n.type === 'Text' && n.props?.children === message);
    expect(text).toHaveLength(1);
    expect(text[0].props.numberOfLines).toBeUndefined();
    expect(text[0].props.maxFontSizeMultiplier).toBeUndefined();
  });
});
