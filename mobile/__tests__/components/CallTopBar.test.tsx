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
   * The verification badge is the only in-call surface for the call's short
   * authentication string, so what it may claim — and when it offers to record
   * a confirmation — is the whole honesty guarantee.
   */
  describe('call verification', () => {
    const readableCall = {
      status: 'unverified' as const,
      words: ['acorn', 'basil', 'cobra', 'domino'],
      fingerprints: { local: 'sha-256 AA', remote: 'sha-256 BB' },
      change: 'first-contact' as const,
    };

    function findByTestID(tree: any, testID: string) {
      return tree.root.findAll((n: any) => n.props?.testID === testID);
    }

    test('shows no badge at all outside a call', () => {
      expect(findByTestID(render(), 'call-security-badge')).toHaveLength(0);
    });

    test('opens and closes the code panel on tap', () => {
      const tree = render({ callSecurity: readableCall });
      expect(findByTestID(tree, 'call-security-panel')).toHaveLength(0);

      act(() => {
        findByTestID(tree, 'call-security-badge')[0].props.onPress();
      });
      expect(textNodeWith(tree, 'acorn basil cobra domino')).not.toBeNull();

      act(() => {
        findByTestID(tree, 'call-security-badge')[0].props.onPress();
      });
      expect(findByTestID(tree, 'call-security-panel')).toHaveLength(0);
    });

    test('records a confirmation the user actually taps', () => {
      const onConfirmCallSecurity = jest.fn();
      const tree = render({ callSecurity: readableCall, onConfirmCallSecurity });

      act(() => {
        findByTestID(tree, 'call-security-badge')[0].props.onPress();
      });
      act(() => {
        findByTestID(tree, 'call-security-confirm')[0].props.onPress();
      });

      expect(onConfirmCallSecurity).toHaveBeenCalledTimes(1);
    });

    test('offers no confirmation for a call whose fingerprints were unreadable', () => {
      const tree = render({
        callSecurity: { status: 'unavailable', words: null, fingerprints: null, change: null },
        onConfirmCallSecurity: jest.fn(),
      });

      expect(textNodeWith(tree, 'Code unavailable')).not.toBeNull();
      act(() => {
        findByTestID(tree, 'call-security-badge')[0].props.onPress();
      });
      expect(findByTestID(tree, 'call-security-words')).toHaveLength(0);
      expect(findByTestID(tree, 'call-security-confirm')).toHaveLength(0);
    });

    test('names a changed peer key in the badge', () => {
      const tree = render({
        callSecurity: { ...readableCall, status: 'changed', change: 'remote-changed' },
      });

      expect(textNodeWith(tree, 'Key changed')).not.toBeNull();
    });

    test('does not re-offer confirmation for an already verified pair', () => {
      const tree = render({
        callSecurity: { ...readableCall, status: 'verified', change: 'unchanged' },
        onConfirmCallSecurity: jest.fn(),
      });

      act(() => {
        findByTestID(tree, 'call-security-badge')[0].props.onPress();
      });

      expect(findByTestID(tree, 'call-security-confirm')).toHaveLength(0);
    });
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
