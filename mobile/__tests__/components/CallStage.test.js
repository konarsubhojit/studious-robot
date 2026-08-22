// @ts-check
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import CallStage from '../../src/components/CallStage';

jest.mock(
  '../../src/SafeRTCView',
  () => (/** @type {any} */ props) => require('react').createElement('SafeRTCView', props),
);
jest.mock(
  '../../src/components/DraggablePip',
  () => (/** @type {any} */ props) => require('react').createElement('DraggablePip', props),
);

/**
 * Test props are deliberately partial; the component under test is exercised
 * through the rendered output rather than its prop types.
 *
 * @returns {any}
 */
function createProps(overrides = {}) {
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

describe('CallStage', () => {
  test('renders main stream and DraggablePip in normal mode', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(<CallStage {...createProps()} />);
    });

    expect(tree.root.findAllByType('SafeRTCView')).toHaveLength(1);
    expect(tree.root.findAllByType('DraggablePip')).toHaveLength(1);
  });

  test('renders main stream but hides DraggablePip in compact PiP mode', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(<CallStage {...createProps({ isCompact: true })} />);
    });

    expect(tree.root.findAllByType('SafeRTCView')).toHaveLength(1);
    expect(tree.root.findAllByType('DraggablePip')).toHaveLength(0);
  });

  test('does not render DraggablePip when hasPipStream is false', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(<CallStage {...createProps({ hasPipStream: false })} />);
    });

    expect(tree.root.findAllByType('DraggablePip')).toHaveLength(0);
  });

  test('renders waiting placeholder when hasMainStream is false', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(<CallStage {...createProps({ hasMainStream: false })} />);
    });

    expect(tree.root.findAllByType('SafeRTCView')).toHaveLength(0);
    const { Text } = require('react-native');
    const texts = tree.root.findAllByType(Text);
    expect(texts.some((/** @type {any} */ t) => t.props.children === 'Waiting for someone to join…')).toBe(true);
  });

  test('forwards isMuted and isVideoEnabled to DraggablePip', () => {
    /** @type {any} */
    let tree;
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
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(<CallStage {...props} />);
    });

    const pip = tree.root.findAllByType('DraggablePip')[0];
    expect(pip.props.isMuted).toBe(false);
    expect(pip.props.isVideoEnabled).toBe(true);
  });

  test('passes mirrorMain to the main SafeRTCView', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(<CallStage {...createProps({ mirrorMain: true })} />);
    });

    const rtcView = tree.root.findAllByType('SafeRTCView')[0];
    expect(rtcView.props.mirror).toBe(true);
  });

  test('main SafeRTCView is not mirrored by default', () => {
    /** @type {any} */
    let tree;
    act(() => {
      tree = renderer.create(<CallStage {...createProps()} />);
    });

    const rtcView = tree.root.findAllByType('SafeRTCView')[0];
    expect(rtcView.props.mirror).toBe(false);
  });
});
