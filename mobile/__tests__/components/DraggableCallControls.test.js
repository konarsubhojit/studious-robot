import React from 'react';
import renderer, { act } from 'react-test-renderer';
import DraggableCallControls from '../../src/components/DraggableCallControls';

jest.mock('react-native-gesture-handler', () => ({
  __esModule: true,
  GestureDetector: ({ children }) => children,
  Gesture: {
    Pan: () => ({
      onStart: function () { return this; },
      onUpdate: function () { return this; },
    }),
  },
}));

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (init) => ({ value: init }),
    useAnimatedStyle: (fn) => fn(),
    runOnJS: (fn) => fn,
  };
});

jest.mock('../../src/components/CallControls', () => (props) =>
  require('react').createElement('CallControls', props),
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

describe('DraggableCallControls', () => {
  test('renders with the draggable-call-controls testID', () => {
    let tree;
    act(() => {
      tree = renderer.create(<DraggableCallControls {...createProps()} />);
    });

    // findAllByProps returns one entry per fiber level (component + host);
    // assert at least one node carries the testID.
    expect(tree.root.findAllByProps({ testID: 'draggable-call-controls' }).length).toBeGreaterThanOrEqual(1);
  });

  test('forwards all control props to CallControls', () => {
    const onMuteToggle = jest.fn();
    const onLeave = jest.fn();
    let tree;
    act(() => {
      tree = renderer.create(
        <DraggableCallControls
          {...createProps({ isMuted: true, onMuteToggle, onLeave })}
        />,
      );
    });

    const controls = tree.root.findByType('CallControls');
    expect(controls.props.isMuted).toBe(true);
    expect(controls.props.onMuteToggle).toBe(onMuteToggle);
    expect(controls.props.onLeave).toBe(onLeave);
    expect(controls.props.hasLocalStream).toBe(true);
    expect(controls.props.isVideoEnabled).toBe(true);
  });

  test('renders a drag handle indicator', () => {
    let tree;
    act(() => {
      tree = renderer.create(<DraggableCallControls {...createProps()} />);
    });

    const { View } = require('react-native');
    const views = tree.root.findAllByType(View);
    const handleViews = views.filter(
      (v) =>
        v.props.accessibilityElementsHidden === true &&
        v.props.importantForAccessibility === 'no',
    );
    expect(handleViews).toHaveLength(1);
  });

  test('floating panel uses position absolute', () => {
    let tree;
    act(() => {
      tree = renderer.create(<DraggableCallControls {...createProps()} />);
    });

    const panel = tree.root.findByProps({ testID: 'draggable-call-controls' });
    const flatStyle = Array.isArray(panel.props.style)
      ? Object.assign({}, ...panel.props.style.filter(Boolean))
      : panel.props.style;
    expect(flatStyle.position).toBe('absolute');
  });
});
