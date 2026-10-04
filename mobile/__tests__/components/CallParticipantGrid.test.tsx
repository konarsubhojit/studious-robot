import React from 'react';
import renderer, { act } from 'react-test-renderer';
import CallParticipantGrid from '../../src/components/CallParticipantGrid';

jest.mock('../../src/SafeRTCView', () => ({
  __esModule: true,
  default: (props: any) => require('react').createElement('SafeRTCView', props),
}));

function participants(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    userId: `user-${index + 1}`,
    name: `Participant ${index + 1}`,
    streamUrl: null,
    isMuted: index === 0,
    isVideoEnabled: false,
    connectionState: 'connected',
    quality: index === 0 ? 'good' : 'connecting',
  }));
}

describe('CallParticipantGrid', () => {
  test.each([2, 3, 6])('renders all %i participants in an adaptive grid', count => {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<CallParticipantGrid participants={participants(count)} />); });
    expect(tree.root.findByProps({ testID: 'call-participant-grid' }).props.accessibilityLabel)
      .toBe(`${count} call participants`);
    const participantIds = new Set(tree.root.findAll(node =>
      /^call-participant-user-\d+$/.test(node.props.testID ?? ''),
    ).map(node => node.props.testID));
    expect(participantIds.size).toBe(count);
    expect([...participantIds].sort()).toEqual(
      Array.from({ length: count }, (_, index) => `call-participant-user-${index + 1}`),
    );
    expect(tree.root.findAll(node => (node.type as unknown as string) === 'SafeRTCView')).toHaveLength(0);
    act(() => tree.unmount());
  });

  test('moves and emphasizes the active speaker first', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <CallParticipantGrid participants={participants(3)} activeSpeakerId="user-3" />,
      );
    });
    const tiles = tree.root.findAll(node =>
      /^call-participant-user-\d+$/.test(node.props.testID ?? '') && node.props.accessibilityLabel,
    );
    expect(tiles[0].props.testID).toBe('call-participant-user-3');
    expect(tiles[0].props.accessibilityLabel).toBe('Participant 3, speaking');
    const tileText = tree.root.findAll(node => (node.type as unknown as string) === 'Text')
      .map(node => String(node.props.children)).join(' ');
    expect(tileText).toContain('Participant 3');
    expect(tileText).toContain('Muted');
    expect(tileText).toContain('good');
    expect(tileText).toContain('connecting');
    act(() => tree.unmount());
  });

  test('compact presentation selects one active-speaker tile', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <CallParticipantGrid participants={participants(6)} activeSpeakerId="user-4" isCompact />,
      );
    });
    const participantIds = new Set(tree.root.findAll(node =>
      /^call-participant-user-\d+$/.test(node.props.testID ?? ''),
    ).map(node => node.props.testID));
    expect([...participantIds]).toEqual(['call-participant-user-4']);
    expect(tree.root.findByProps({ testID: 'call-participant-user-4' })).toBeDefined();
    act(() => tree.unmount());
  });
});
