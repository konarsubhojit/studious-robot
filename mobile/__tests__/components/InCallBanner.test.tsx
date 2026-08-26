import React from 'react';
import renderer, { act } from 'react-test-renderer';
import InCallBanner from '../../src/components/InCallBanner';
import { fontScaleCaps } from '../../src/theme';

function findByTestId(tree: any, testID: any) {
  return tree.root.findAll((node: any) => node.props?.testID === testID)[0] ?? null;
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

function render(props?: any): any {
  let tree: any;
  act(() => {
    tree = renderer.create(
      <InCallBanner
        participantLabel="Call with user-bob"
        elapsedCallSeconds={65}
        onExpand={jest.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

describe('InCallBanner', () => {
  test('renders the participant label and formatted duration', () => {
    const tree = render();
    const label = tree.root.findAll((n: any) => n.props?.children === 'Call with user-bob');
    expect(label.length).toBeGreaterThan(0);
    const duration = tree.root.findAll((n: any) => n.props?.children === '01:05');
    expect(duration.length).toBeGreaterThan(0);
  });

  test('falls back to a generic label when participantLabel is null', () => {
    const tree = render({ participantLabel: null });
    const label = tree.root.findAll((n: any) => n.props?.children === 'Call in progress');
    expect(label.length).toBeGreaterThan(0);
  });

  test('tapping the banner calls onExpand', () => {
    const onExpand = jest.fn();
    const tree = render({ onExpand });
    act(() => {
      findByTestId(tree, 'in-call-banner').props.onPress();
    });
    expect(onExpand).toHaveBeenCalled();
  });

  test('exposes an accessible label naming the party being called', () => {
    const tree = render({ participantLabel: 'Call with user-bob' });
    const banner = findByTestId(tree, 'in-call-banner');
    expect(banner.props.accessibilityLabel).toBe('Return to call: Call with user-bob');
  });

  test('exposes a generic accessible label when there is no participant', () => {
    const tree = render({ participantLabel: null });
    const banner = findByTestId(tree, 'in-call-banner');
    expect(banner.props.accessibilityLabel).toBe('Return to call');
  });

  test('omits mute and end when no handlers are given', () => {
    const tree = render();

    expect(findByTestId(tree, 'in-call-banner-mute')).toBeNull();
    expect(findByTestId(tree, 'in-call-banner-end')).toBeNull();
  });

  test('offers mute and end without expanding the call, like the bubble does', () => {
    const onMuteToggle = jest.fn();
    const onEndCall = jest.fn();
    const tree = render({ onMuteToggle, onEndCall });

    pressByTestID(tree, 'in-call-banner-mute');
    pressByTestID(tree, 'in-call-banner-end');

    expect(onMuteToggle).toHaveBeenCalledTimes(1);
    expect(onEndCall).toHaveBeenCalledTimes(1);
  });

  test('the mute control names the action it will perform', () => {
    expect(
      findByTestId(render({ onMuteToggle: jest.fn() }), 'in-call-banner-mute').props
        .accessibilityLabel,
    ).toBe('Mute microphone');
    expect(
      findByTestId(render({ onMuteToggle: jest.fn(), isMuted: true }), 'in-call-banner-mute')
        .props.accessibilityLabel,
    ).toBe('Unmute microphone');
  });

  /**
   * The banner is a single row across the top of the shell. It grows taller
   * happily, but it can never grow wider, and the participant label is the only
   * flexible thing in it — so the fixed-shape readout beside the label is what
   * gets capped, not the label.
   */
  describe('dynamic type', () => {
    function textNodeWith(tree: any, content: string) {
      return (
        tree.root.findAll((n: any) => n.type === 'Text' && n.props?.children === content)[0] ?? null
      );
    }

    test('caps the elapsed-time readout so it cannot eat the name beside it', () => {
      expect(textNodeWith(render(), '01:05').props.maxFontSizeMultiplier).toBe(
        fontScaleCaps.control,
      );
    });

    test('leaves the participant label uncapped', () => {
      expect(
        textNodeWith(render(), 'Call with user-bob').props.maxFontSizeMultiplier,
      ).toBeUndefined();
    });
  });
});
