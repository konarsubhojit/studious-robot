import React from 'react';
import renderer, { act } from 'react-test-renderer';
import CallScreen from '../../src/components/CallScreen';

jest.mock('../../src/components/CallTopBar', () => (props) =>
  require('react').createElement('CallTopBar', props),
);
jest.mock('../../src/components/ReconnectBanner', () => (props) =>
  require('react').createElement('ReconnectBanner', props),
);
jest.mock('../../src/components/CallStage', () => (props) =>
  require('react').createElement('CallStage', props),
);
jest.mock('../../src/components/CallControls', () => (props) =>
  require('react').createElement('CallControls', props),
);
jest.mock('../../src/components/DraggableCallControls', () => (props) =>
  require('react').createElement('DraggableCallControls', props),
);
jest.mock('../../src/components/StatusBanner', () => (props) =>
  require('react').createElement('StatusBanner', props),
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
    status: { message: 'Connected', severity: 'success' },
    ...overrides,
  };
}

describe('CallScreen', () => {
  test('renders full in-call chrome when not compact', () => {
    let tree;
    act(() => {
      tree = renderer.create(<CallScreen {...createProps()} />);
    });

    expect(tree.root.findAllByType('CallTopBar')).toHaveLength(1);
    expect(tree.root.findAllByType('DraggableCallControls')).toHaveLength(1);
    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(1);
    expect(tree.root.findAllByType('CallStage')[0].props.isCompact).toBe(false);
  });

  test('hides top chrome in compact PiP mode but keeps stage visible', () => {
    let tree;
    act(() => {
      tree = renderer.create(<CallScreen {...createProps({ isCompact: true, isReconnecting: true })} />);
    });

    expect(tree.root.findAllByType('CallTopBar')).toHaveLength(0);
    expect(tree.root.findAllByType('ReconnectBanner')).toHaveLength(0);
    expect(tree.root.findAllByType('DraggableCallControls')).toHaveLength(0);
    expect(tree.root.findAllByType('StatusBanner')).toHaveLength(0);
    expect(tree.root.findAllByType('CallStage')[0].props.isCompact).toBe(true);
  });
});
