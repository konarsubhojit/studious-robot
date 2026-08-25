import React from 'react';
import renderer, { act } from 'react-test-renderer';
import CallStage from '../../src/components/CallStage';

jest.mock(
  '../../src/SafeRTCView',
  () => (props: any) => require('react').createElement('SafeRTCView', props),
);
jest.mock(
  '../../src/components/DraggablePip',
  () => (props: any) => require('react').createElement('DraggablePip', props),
);

/**
 * Test props are deliberately partial; the component under test is exercised
 * through the rendered output rather than its prop types.
 */
function createProps(overrides = {}): any {
  return {
    onLayout: () => {},
    mainStreamUrl: 'remote-stream-url',
    hasMainStream: true,
    pipStreamUrl: 'local-stream-url',
    hasPipStream: true,
    mirrorPip: true,
    mirrorMain: false,
    pipGesture: {},
    animatedPipStyle: {},
    isMuted: false,
    isVideoEnabled: true,
    isCompact: false,
    ...overrides,
  };
}

function findByTestId(tree: any, testID: string) {
  return tree.root.findAll((node: any) => node.props?.testID === testID)[0] ?? null;
}

describe('CallStage', () => {
  test('renders main stream and DraggablePip in normal mode', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<CallStage {...createProps()} />);
    });

    expect(tree.root.findAllByType('SafeRTCView')).toHaveLength(1);
    expect(tree.root.findAllByType('DraggablePip')).toHaveLength(1);
  });

  test('renders main stream but hides DraggablePip in compact PiP mode', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<CallStage {...createProps({ isCompact: true })} />);
    });

    expect(tree.root.findAllByType('SafeRTCView')).toHaveLength(1);
    expect(tree.root.findAllByType('DraggablePip')).toHaveLength(0);
  });

  test('does not render DraggablePip when hasPipStream is false', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<CallStage {...createProps({ hasPipStream: false })} />);
    });

    expect(tree.root.findAllByType('DraggablePip')).toHaveLength(0);
  });

  test('renders waiting placeholder when hasMainStream is false', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<CallStage {...createProps({ hasMainStream: false })} />);
    });

    expect(tree.root.findAllByType('SafeRTCView')).toHaveLength(0);
    const { Text } = require('react-native');
    const texts = tree.root.findAllByType(Text);
    expect(texts.some((t: any) => t.props.children === 'Waiting for someone to join…')).toBe(true);
  });

  test('forwards isMuted and isVideoEnabled to DraggablePip', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(
        <CallStage {...createProps({ isMuted: true, isVideoEnabled: false })} />,
      );
    });

    const pip = tree.root.findAllByType('DraggablePip')[0];
    expect(pip.props.isMuted).toBe(true);
    expect(pip.props.isVideoEnabled).toBe(false);
  });

  test('forwards default isMuted=false and isVideoEnabled=true when not provided', () => {
    const props = createProps();
    delete props.isMuted;
    delete props.isVideoEnabled;
    let tree: any;
    act(() => {
      tree = renderer.create(<CallStage {...props} />);
    });

    const pip = tree.root.findAllByType('DraggablePip')[0];
    expect(pip.props.isMuted).toBe(false);
    expect(pip.props.isVideoEnabled).toBe(true);
  });

  test('passes mirrorMain to the main SafeRTCView', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<CallStage {...createProps({ mirrorMain: true })} />);
    });

    const rtcView = tree.root.findAllByType('SafeRTCView')[0];
    expect(rtcView.props.mirror).toBe(true);
  });

  test('main SafeRTCView is not mirrored by default', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<CallStage {...createProps()} />);
    });

    const rtcView = tree.root.findAllByType('SafeRTCView')[0];
    expect(rtcView.props.mirror).toBe(false);
  });

  test('draws the ambient canvas instead of video when the call is audio-only', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(
        <CallStage
          {...createProps({ isAudioOnly: true, participantLabel: 'user-bob' })}
        />,
      );
    });

    expect(findByTestId(tree, 'call-stage-ambient')).not.toBeNull();
    expect(tree.root.findAllByType('SafeRTCView').length).toBe(0);
    expect(
      tree.root.findAll((n: any) => n.props?.children === 'user-bob').length,
    ).toBeGreaterThan(0);
  });

  test('shows the audio status label under the name', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(
        <CallStage {...createProps({ isAudioOnly: true, audioStatusLabel: '02:14' })} />,
      );
    });

    expect(findByTestId(tree, 'call-stage-ambient-status').props.children).toBe('02:14');
  });

  test('omits the status line when no label is given', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<CallStage {...createProps({ isAudioOnly: true })} />);
    });

    expect(findByTestId(tree, 'call-stage-ambient-status')).toBeNull();
  });

  test('hides the self-view PiP on an audio call', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<CallStage {...createProps({ isAudioOnly: true })} />);
    });

    expect(tree.root.findAllByType('DraggablePip').length).toBe(0);
  });

  test('falls back to Unknown when there is no participant label', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(
        <CallStage {...createProps({ isAudioOnly: true, participantLabel: null })} />,
      );
    });

    expect(
      tree.root.findAll((n: any) => n.props?.children === 'Unknown').length,
    ).toBeGreaterThan(0);
  });
});
