import React from 'react';
import renderer, { act } from 'react-test-renderer';
import CallTopBar from '../../src/components/CallTopBar';
import { fontScaleCaps } from '../../src/theme';

jest.mock('../../src/vectorIcons', () => ({
  ICONS: { minimize: { icon: 'chevron-down', emoji: '⌄' } },
  loadVectorIcons: jest.fn(() => null),
}));

describe('CallTopBar', () => {
  const baseProps = {
    elapsedCallSeconds: 12,
    connectionQuality: { bars: 2, label: 'Good' },
    participantLabel: 'Call with alice',
  };

  function render(props: Record<string, unknown> = {}) {
    let tree: any;
    act(() => {
      tree = renderer.create(<CallTopBar {...baseProps} {...(props as any)} />);
    });
    return tree;
  }

  /** Host `Text` nodes carry the rendered props; the composite does not. */
  function textNodeWith(tree: any, content: string) {
    return (
      tree.root.findAll((n: any) => n.type === 'Text' && n.props?.children === content)[0] ?? null
    );
  }

  test('shows a relay badge only when TURN relay is forced', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<CallTopBar {...baseProps} iceTransportPolicy="all" />);
    });
    expect(
      tree.root.findAll((n: any) => n.type === 'Text' && n.props.testID === 'call-ice-policy-badge'),
    ).toHaveLength(0);

    act(() => {
      tree.update(<CallTopBar {...baseProps} iceTransportPolicy="relay" />);
    });
    expect(
      tree.root.findAll((n: any) => n.type === 'Text' && n.props.testID === 'call-ice-policy-badge'),
    ).toHaveLength(1);
  });

  /**
   * The bar lives in `CallScreen`'s `StyleSheet.absoluteFill` overlay, so it is
   * exactly as wide as the screen and nothing in it can push anything anywhere.
   * Everything with a fixed shape is capped; the participant name — the one
   * flexible member of the row — deliberately is not.
   */
  describe('dynamic type', () => {
    test('caps the elapsed-time readout, which has no reflow of its own', () => {
      const timer = textNodeWith(render(), '00:12');

      expect(timer.props.maxFontSizeMultiplier).toBe(fontScaleCaps.control);
    });

    test('caps the relay badge: a pill drawn with overflow hidden clips its text', () => {
      const badge = textNodeWith(render({ iceTransportPolicy: 'relay' }), 'TURN relay');

      expect(badge.props.maxFontSizeMultiplier).toBe(fontScaleCaps.control);
    });

    test('caps the minimize fallback glyph inside its 28dp circle', () => {
      const glyph = textNodeWith(render({ onMinimize: () => {} }), '⌄');

      expect(glyph.props.maxFontSizeMultiplier).toBe(fontScaleCaps.badge);
    });

    test('leaves the participant label uncapped: it shrinks and truncates already', () => {
      const label = textNodeWith(render(), 'Call with alice');

      expect(label.props.maxFontSizeMultiplier).toBeUndefined();
      expect(label.props.numberOfLines).toBe(1);
    });
  });
});
