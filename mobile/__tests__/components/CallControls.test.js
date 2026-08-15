import React from 'react';
import renderer, { act } from 'react-test-renderer';
import CallControls from '../../src/components/CallControls';

jest.mock(
  '../../src/components/AudioOutputMenu',
  () => props => require('react').createElement('AudioOutputMenu', props),
);

function createProps(overrides = {}) {
  return {
    isMuted: false,
    isVideoEnabled: true,
    hasLocalStream: true,
    audioDevices: { available: [], selected: null },
    isSpeakerEnabled: true,
    onMuteToggle: () => {},
    onVideoToggle: () => {},
    onChooseAudioOutput: () => {},
    onCameraSwitch: () => {},
    onLeave: () => {},
    ...overrides,
  };
}

function render(props) {
  let tree;
  act(() => {
    tree = renderer.create(<CallControls {...props} />);
  });
  return tree;
}

function findByTestId(tree, testID) {
  return tree.root.findAll(node => node.props?.testID === testID)[0] ?? null;
}

describe('CallControls screen sharing', () => {
  test('hides the screen-share controls when no handler is provided', () => {
    const tree = render(createProps());

    expect(findByTestId(tree, 'control-screen-share')).toBeNull();
    expect(findByTestId(tree, 'control-screen-audio')).toBeNull();
  });

  test('renders screen-share and screen-audio toggles when handlers are provided', () => {
    const onScreenShareToggle = jest.fn();
    const onScreenAudioToggle = jest.fn();
    const tree = render(createProps({ onScreenShareToggle, onScreenAudioToggle }));

    const shareButton = findByTestId(tree, 'control-screen-share');
    const audioButton = findByTestId(tree, 'control-screen-audio');

    expect(shareButton.props.accessibilityLabel).toBe('Share your screen');
    expect(audioButton.props.accessibilityLabel).toBe('Include screen audio when sharing');
  });

  test('disables the toggles when screen sharing is unsupported', () => {
    const tree = render(
      createProps({
        onScreenShareToggle: jest.fn(),
        onScreenAudioToggle: jest.fn(),
        isScreenShareSupported: false,
      }),
    );

    expect(findByTestId(tree, 'control-screen-share').props.disabled).toBe(true);
    expect(findByTestId(tree, 'control-screen-audio').props.disabled).toBe(true);
  });

  test('shows the sharing indicator and blocks camera switching while sharing', () => {
    const tree = render(
      createProps({
        onScreenShareToggle: jest.fn(),
        onScreenAudioToggle: jest.fn(),
        isScreenSharing: true,
        isScreenAudioShared: true,
      }),
    );

    expect(findByTestId(tree, 'screen-share-indicator').props.children).toBe(
      'Sharing screen with audio',
    );
    expect(findByTestId(tree, 'control-screen-share').props.accessibilityLabel).toBe(
      'Stop sharing your screen',
    );
    expect(findByTestId(tree, 'control-swap-camera').props.disabled).toBe(true);
    expect(findByTestId(tree, 'control-video').props.disabled).toBe(true);
  });
});

describe('CallControls primary action labels', () => {
  test('shows visible text labels for mute, video, and leave, reflecting current state', () => {
    const tree = render(createProps({ isMuted: false, isVideoEnabled: true }));

    expect(tree.root.findAll(n => n.props?.children === 'Mute').length).toBeGreaterThan(0);
    expect(tree.root.findAll(n => n.props?.children === 'Stop video').length).toBeGreaterThan(0);
    expect(tree.root.findAll(n => n.props?.children === 'Leave').length).toBeGreaterThan(0);
  });

  test('flips mute/video labels when muted and video is off', () => {
    const tree = render(createProps({ isMuted: true, isVideoEnabled: false }));

    expect(tree.root.findAll(n => n.props?.children === 'Unmute').length).toBeGreaterThan(0);
    expect(tree.root.findAll(n => n.props?.children === 'Start video').length).toBeGreaterThan(0);
  });
});
