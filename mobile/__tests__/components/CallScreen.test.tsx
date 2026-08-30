import React from 'react';
import renderer, { act } from 'react-test-renderer';
import CallScreen from '../../src/components/CallScreen';

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    FadeInDown: { duration: () => 'fade-in-down' },
    FadeInUp: { duration: () => 'fade-in-up' },
    FadeOutDown: { duration: () => 'fade-out-down' },
    FadeOutUp: { duration: () => 'fade-out-up' },
  };
});

jest.mock(
  '../../src/components/CallTopBar',
  () => (props: any) => require('react').createElement('CallTopBar', props),
);
jest.mock(
  '../../src/components/ReconnectBanner',
  () => (props: any) => require('react').createElement('ReconnectBanner', props),
);
jest.mock(
  '../../src/components/CallStage',
  () => (props: any) => require('react').createElement('CallStage', props),
);
jest.mock(
  '../../src/components/CallControls',
  () => (props: any) => require('react').createElement('CallControls', props),
);
jest.mock(
  '../../src/components/StatusBanner',
  () => (props: any) => require('react').createElement('StatusBanner', props),
);

/**
 * Test props are deliberately partial; the component under test is exercised
 * through the rendered output rather than its prop types.
 */
function createProps(overrides = {}): any {
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
  let tree: any;

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


  test('shows the recovery banner for a media-only failure, not just socket loss', () => {
    // ICE down, socket up — the common TURN-path case. The banner used to be
    // gated on `isReconnecting`, which is set only on socket disconnect, so the
    // user watched a frozen picture with no indication anything was wrong.
    act(() => {
      tree = renderer.create(
        <CallScreen
          {...createProps({
            isReconnecting: false,
            recoveryStatus: {
              trigger: 'ice-disconnected',
              attempts: 2,
              remainingMs: 18_000,
              isPaused: false,
              pauseReason: null,
            },
          })}
        />,
      );
    });

    const banners = tree.root.findAllByType('ReconnectBanner');
    expect(banners).toHaveLength(1);
    expect(banners[0].props.recovery).toMatchObject({ trigger: 'ice-disconnected', attempts: 2 });
  });

  test('hides the recovery banner once the episode closes', () => {
    act(() => {
      tree = renderer.create(
        <CallScreen
          {...createProps({
            recoveryStatus: {
              trigger: 'network-change',
              attempts: 1,
              remainingMs: 25_000,
              isPaused: true,
              pauseReason: 'no-connectivity',
            },
          })}
        />,
      );
    });
    expect(tree.root.findAllByType('ReconnectBanner')).toHaveLength(1);

    act(() => {
      tree.update(<CallScreen {...createProps({ recoveryStatus: null })} />);
    });
    expect(tree.root.findAllByType('ReconnectBanner')).toHaveLength(0);
  });

  test('forwards the ICE transport policy to the top bar', () => {
    act(() => {
      tree = renderer.create(<CallScreen {...createProps({ iceTransportPolicy: 'relay' })} />);
    });

    expect(tree.root.findAllByType('CallTopBar')[0].props.iceTransportPolicy).toBe('relay');
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
    const errorState = tree.root.findAll((n: any) => n.props.testID === 'call-error-state');
    expect(errorState.length).toBeGreaterThanOrEqual(1);
    const retry = tree.root.find((n: any) => n.props.testID === 'call-error-state-action');
    act(() => {
      retry.props.onPress();
    });
    expect(onRetry).toHaveBeenCalled();
    expect(tree.root.findAllByType('CallTopBar')).toHaveLength(1);
  });

  test('never auto-hides the chrome on an audio call, which has nothing underneath', () => {
    jest.useFakeTimers();

    act(() => {
      tree = renderer.create(
        <CallScreen {...createProps({ isAudioOnly: true, status: undefined })} />,
      );
    });

    act(() => {
      jest.advanceTimersByTime(10000);
    });

    expect(tree.root.findAllByType('CallControls')).toHaveLength(1);
    expect(tree.root.findAllByType('CallTopBar')).toHaveLength(1);
  });

  test('restores chrome dismissed by a tap once the call becomes audio-only', () => {
    act(() => {
      tree = renderer.create(<CallScreen {...createProps()} />);
    });

    act(() => {
      tree.root.findByProps({ testID: 'call-screen-root' }).props.onPress();
    });
    expect(tree.root.findAllByType('CallControls')).toHaveLength(0);

    act(() => {
      tree.update(<CallScreen {...createProps({ isAudioOnly: true })} />);
    });

    expect(tree.root.findAllByType('CallControls')).toHaveLength(1);
  });

  test('never auto-hides the chrome while a recovery is in flight', () => {
    jest.useFakeTimers();

    act(() => {
      tree = renderer.create(
        <CallScreen {...createProps({ isReconnecting: true, status: undefined })} />,
      );
    });

    act(() => {
      jest.advanceTimersByTime(10000);
    });

    expect(tree.root.findAllByType('ReconnectBanner')).toHaveLength(1);
    expect(tree.root.findAllByType('CallControls')).toHaveLength(1);
  });

  test('reports the height of both chrome groups so the self-view can avoid them', () => {
    const onTopChromeLayout = jest.fn();
    const onBottomChromeLayout = jest.fn();

    act(() => {
      tree = renderer.create(
        <CallScreen {...createProps({ onTopChromeLayout, onBottomChromeLayout })} />,
      );
    });

    expect(
      tree.root.findAll(node => node.props.onLayout === onTopChromeLayout).length,
    ).toBeGreaterThan(0);
    expect(
      tree.root.findAll(node => node.props.onLayout === onBottomChromeLayout).length,
    ).toBeGreaterThan(0);
  });

  test('forwards isAudioOnly to the stage and the control deck', () => {
    act(() => {
      tree = renderer.create(<CallScreen {...createProps({ isAudioOnly: true })} />);
    });

    expect(tree.root.findAllByType('CallStage')[0].props.isAudioOnly).toBe(true);
    expect(tree.root.findAllByType('CallControls')[0].props.isAudioOnly).toBe(true);
  });

  test('labels the ambient stage with the running duration, or the recovery state', () => {
    act(() => {
      tree = renderer.create(
        <CallScreen {...createProps({ isAudioOnly: true, elapsedCallSeconds: 65 })} />,
      );
    });
    expect(tree.root.findAllByType('CallStage')[0].props.audioStatusLabel).toBe('01:05');

    act(() => {
      tree.update(
        <CallScreen
          {...createProps({ isAudioOnly: true, elapsedCallSeconds: 65, isReconnecting: true })}
        />,
      );
    });
    expect(tree.root.findAllByType('CallStage')[0].props.audioStatusLabel).toBe('Reconnecting…');
  });
});
