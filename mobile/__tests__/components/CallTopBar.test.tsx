import React from 'react';
import renderer, { act } from 'react-test-renderer';
import CallTopBar from '../../src/components/CallTopBar';

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
});
