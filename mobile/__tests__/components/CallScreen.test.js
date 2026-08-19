import React from 'react';
import renderer, { act } from 'react-test-renderer';
import CallScreen from '../../src/components/CallScreen';

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    FadeIn: { duration: () => 'fade-in' },
    FadeOut: { duration: () => 'fade-out' },
  };
});

jest.mock(
  '../../src/components/CallTopBar',
  () => props => require('react').createElement('CallTopBar', props),
);
jest.mock(
  '../../src/components/ReconnectBanner',
  () => props => require('react').createElement('ReconnectBanner', props),
);
jest.mock(
  '../../src/components/CallStage',
  () => props => require('react').createElement('CallStage', props),
);
jest.mock(
  '../../src/components/CallControls',
  () => props => require('react').createElement('CallControls', props),
);
jest.mock(
  '../../src/components/StatusBanner',
  () => props => require('react').createElement('StatusBanner', props),
);

function createProps(overrides = {}) {
  return {
    elapsedCallSeconds: 12,
    connectionQuality: { bars: 2, label: 'Good' },
    participantLabel: 'Room room-1',
    isReconnecting: false,
    onRetry: () => {},
    onStageLayout: () => {},
    mainStreamUrl: 'main-stream',
    hasMainStream: true,
    pipStreamUrl: 'pip-stream',
    hasPipStream: true,
    mirrorPip: true,
    mirrorMain: false,
    pipGesture: {},
    animatedPipStyle: {},
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
    status: { message: 'Call started', severity: 'success' },
    ...overrides,
  };
}

describe('CallScreen', () => {
  let tree;

  afterEach(() => {
    if (tree) {
      act(() => {
        tree.unmount();
      });
      tree = null;
    }
    jest.useRealTimers();
  });

  test('renders full in-call chrome when not compact', () => {
    act(() => {
      tree = renderer.create(<CallScreen {...createProps()} />);
    });

    expect(tree.root.findAllByType('CallTopBar')).toHaveLength(1);
    expect(tree.root.findAllByType('CallControls')).toHaveLength(1);
    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(1);
    expect(tree.root.findAllByType('CallStage')[0].props.isCompact).toBe(false);
  });

  test('hides top chrome in compact PiP mode but keeps stage visible', () => {
    act(() => {
      tree = renderer.create(
        <CallScreen {...createProps({ isCompact: true, isReconnecting: true })} />,
      );
    });

    expect(tree.root.findAllByType('CallTopBar')).toHaveLength(0);
    expect(tree.root.findAllByType('ReconnectBanner')).toHaveLength(0);
    expect(tree.root.findAllByType('CallControls')).toHaveLength(0);
    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(0);
    expect(tree.root.findAllByType('CallStage')[0].props.isCompact).toBe(true);
  });

  test('toggles overlays on screen tap', () => {
    act(() => {
      tree = renderer.create(<CallScreen {...createProps()} />);
    });
    expect(tree.root.findAllByType('CallTopBar')).toHaveLength(1);

    act(() => {
      tree.root.findByProps({ testID: 'call-screen-root' }).props.onPress();
    });
    expect(tree.root.findAllByType('CallTopBar')).toHaveLength(0);

    act(() => {
      tree.root.findByProps({ testID: 'call-screen-root' }).props.onPress();
    });
    expect(tree.root.findAllByType('CallTopBar')).toHaveLength(1);
  });

  test('unmounts the whole control deck when the overlay is dismissed', () => {
    act(() => {
      tree = renderer.create(<CallScreen {...createProps()} />);
    });
    expect(tree.root.findAllByType('CallControls')).toHaveLength(1);

    act(() => {
      tree.root.findByProps({ testID: 'call-screen-root' }).props.onPress();
    });
    // Hidden means gone: controls that are only faded out keep their icons on
    // screen and stack up with the next set that is rendered.
    expect(tree.root.findAllByType('CallControls')).toHaveLength(0);
    expect(tree.root.findAllByType('CallTopBar')).toHaveLength(0);
  });

  test('restores the controls when the call leaves compact mode', () => {
    act(() => {
      tree = renderer.create(<CallScreen {...createProps({ isCompact: true })} />);
    });
    expect(tree.root.findAllByType('CallControls')).toHaveLength(0);

    act(() => {
      tree.update(<CallScreen {...createProps({ isCompact: false })} />);
    });
    expect(tree.root.findAllByType('CallControls')).toHaveLength(1);
  });

  test('never renders more than one control deck across call-state changes', () => {
    act(() => {
      tree = renderer.create(<CallScreen {...createProps()} />);
    });

    [
      { isReconnecting: true },
      { isReconnecting: false, status: { message: 'Reconnecting', severity: 'error' } },
      { isCompact: true },
      { isCompact: false, isScreenSharing: true },
    ].forEach(overrides => {
      act(() => {
        tree.update(<CallScreen {...createProps(overrides)} />);
      });
      expect(tree.root.findAllByType('CallControls').length).toBeLessThanOrEqual(1);
      expect(tree.root.findAllByType('CallTopBar').length).toBeLessThanOrEqual(1);
    });
  });

  test('forwards isMuted and isVideoEnabled to CallStage', () => {
    act(() => {
      tree = renderer.create(
        <CallScreen {...createProps({ isMuted: true, isVideoEnabled: false })} />,
      );
    });

    const stage = tree.root.findAllByType('CallStage')[0];
    expect(stage.props.isMuted).toBe(true);
    expect(stage.props.isVideoEnabled).toBe(false);
  });

  test('forwards mirrorPip and mirrorMain to CallStage', () => {
    act(() => {
      tree = renderer.create(
        <CallScreen {...createProps({ mirrorPip: false, mirrorMain: true })} />,
      );
    });

    const stage = tree.root.findAllByType('CallStage')[0];
    expect(stage.props.mirrorPip).toBe(false);
    expect(stage.props.mirrorMain).toBe(true);
  });

  test('auto-hides non-error in-call status messages', () => {
    jest.useFakeTimers();

    act(() => {
      tree = renderer.create(
        <CallScreen
          {...createProps({ status: { message: 'Waiting for peer…', severity: 'info' } })}
        />,
      );
    });

    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(1);

    act(() => {
      jest.advanceTimersByTime(3000);
    });

    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(0);
    expect(tree.root.findAllByType('CallTopBar')).toHaveLength(0);
  });

  test('keeps error statuses visible as an actionable error state', () => {
    jest.useFakeTimers();
    const onRetry = jest.fn();

    act(() => {
      tree = renderer.create(
        <CallScreen
          {...createProps({
            status: { message: 'Failed to create offer', severity: 'error' },
            onRetry,
          })}
        />,
      );
    });

    act(() => {
      jest.advanceTimersByTime(3000);
    });

    // Errors are surfaced with a recovery action instead of a bare status line.
    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(0);
    const errorState = tree.root.findAll(n => n.props.testID === 'call-error-state');
    expect(errorState.length).toBeGreaterThanOrEqual(1);
    const retry = tree.root.find(n => n.props.testID === 'call-error-state-action');
    act(() => {
      retry.props.onPress();
    });
    expect(onRetry).toHaveBeenCalled();
    expect(tree.root.findAllByType('CallTopBar')).toHaveLength(1);
  });
});
