import React from 'react';
import renderer, { act } from 'react-test-renderer';
import CallControls from '../../src/components/CallControls';

jest.mock(
  '../../src/components/AudioOutputMenu',
  () => (props: any) => require('react').createElement('AudioOutputMenu', props),
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

function render(props: any) {
  let tree: any;
  act(() => {
    tree = renderer.create(<CallControls {...props} />);
  });
  return tree;
}

function findByTestId(tree: any, testID: any) {
  return tree.root.findAll((node: any) => node.props?.testID === testID)[0] ?? null;
}

/**
 * Presses the composite that owns `onPress` for a testID. Host nodes carry the
 * testID but not the handler, so the first match is not always pressable.
 */
function pressByTestID(tree: any, testID: string) {
  const node = tree.root.findAll(
    (n: any) => n.props?.testID === testID && typeof n.props?.onPress === 'function',
  )[0];
  if (!node) throw new Error(`No pressable node with testID "${testID}"`);
  act(() => {
    node.props.onPress();
  });
}

/** Screen sharing now lives behind "More"; open it before asserting on rows. */
function openMoreSheet(tree: any) {
  pressByTestID(tree, 'control-more');
}

describe('CallControls screen sharing', () => {
  test('hides the More affordance and its controls when no handler is provided', () => {
    const tree = render(createProps());

    expect(findByTestId(tree, 'control-more')).toBeNull();
    expect(findByTestId(tree, 'control-screen-share')).toBeNull();
    expect(findByTestId(tree, 'control-screen-audio')).toBeNull();
  });

  test('keeps the screen-share controls behind More until it is opened', () => {
    const tree = render(
      createProps({ onScreenShareToggle: jest.fn(), onScreenAudioToggle: jest.fn() }),
    );

    expect(findByTestId(tree, 'control-more')).not.toBeNull();
    expect(findByTestId(tree, 'control-screen-share')).toBeNull();

    openMoreSheet(tree);

    expect(findByTestId(tree, 'control-screen-share')).not.toBeNull();
  });

  test('renders screen-share and screen-audio rows in the More sheet', () => {
    const onScreenShareToggle = jest.fn();
    const onScreenAudioToggle = jest.fn();
    const tree = render(createProps({ onScreenShareToggle, onScreenAudioToggle }));

    openMoreSheet(tree);

    expect(
      tree.root.findAll((n: any) => n.props?.children === 'Share your screen').length,
    ).toBeGreaterThan(0);
    expect(
      tree.root.findAll((n: any) => n.props?.children === 'Include screen audio').length,
    ).toBeGreaterThan(0);
  });

  test('closes the sheet and toggles sharing when the share row is pressed', () => {
    const onScreenShareToggle = jest.fn();
    const tree = render(createProps({ onScreenShareToggle }));

    openMoreSheet(tree);
    pressByTestID(tree, 'control-screen-share');

    expect(onScreenShareToggle).toHaveBeenCalledTimes(1);
    // Sharing has started: the sheet must get out of the way of the call.
    expect(findByTestId(tree, 'control-screen-share')).toBeNull();
  });

  test('disables the rows when screen sharing is unsupported', () => {
    const tree = render(
      createProps({
        onScreenShareToggle: jest.fn(),
        onScreenAudioToggle: jest.fn(),
        isScreenShareSupported: false,
      }),
    );

    openMoreSheet(tree);

    expect(findByTestId(tree, 'control-screen-share').props.accessibilityState.disabled).toBe(true);
    expect(findByTestId(tree, 'control-screen-audio').props.accessibilityState.disabled).toBe(true);
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

    openMoreSheet(tree);

    expect(
      tree.root.findAll((n: any) => n.props?.children === 'Stop sharing your screen').length,
    ).toBeGreaterThan(0);
    expect(findByTestId(tree, 'control-swap-camera').props.disabled).toBe(true);
    expect(findByTestId(tree, 'control-video').props.disabled).toBe(true);
  });

  test('leave stays on the surface, never inside the More sheet', () => {
    const tree = render(createProps({ onScreenShareToggle: jest.fn() }));

    expect(findByTestId(tree, 'control-leave')).not.toBeNull();
  });
});

describe('CallControls on an audio call', () => {
  test('disables camera switching when there is no video to flip', () => {
    const tree = render(createProps({ isAudioOnly: true }));

    expect(findByTestId(tree, 'control-swap-camera').props.disabled).toBe(true);
  });
});

describe('CallControls primary action labels', () => {
  test('shows visible text labels for mute, video, and leave, reflecting current state', () => {
    const tree = render(createProps({ isMuted: false, isVideoEnabled: true }));

    expect(tree.root.findAll((n: any) => n.props?.children === 'Mute').length).toBeGreaterThan(0);
    expect(tree.root.findAll((n: any) => n.props?.children === 'Stop video').length).toBeGreaterThan(0);
    expect(tree.root.findAll((n: any) => n.props?.children === 'Leave').length).toBeGreaterThan(0);
  });

  test('flips mute/video labels when muted and video is off', () => {
    const tree = render(createProps({ isMuted: true, isVideoEnabled: false }));

    expect(tree.root.findAll((n: any) => n.props?.children === 'Unmute').length).toBeGreaterThan(0);
    expect(tree.root.findAll((n: any) => n.props?.children === 'Start video').length).toBeGreaterThan(0);
  });
});
