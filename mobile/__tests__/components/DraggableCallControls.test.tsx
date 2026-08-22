import React from 'react';
import * as ReactNative from 'react-native';
import renderer, { act } from 'react-test-renderer';
import DraggableCallControls from '../../src/components/DraggableCallControls';

const mockPanCallbacks: { onStart?: any; onUpdate?: any; onEnd?: any; } = {};
const mockSharedValues: any = [];

jest.mock('react-native-gesture-handler', () => ({
  __esModule: true,
  GestureDetector: ({ children }: any) => children,
  Gesture: {
    Pan: () => ({
      onStart: function (callback: any) {
        mockPanCallbacks.onStart = callback;
        return this;
      },
      onUpdate: function (callback: any) {
        mockPanCallbacks.onUpdate = callback;
        return this;
      },
    }),
  },
}));

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (init: any) => {
      const sharedValue = { value: init };
      mockSharedValues.push(sharedValue);
      return sharedValue;
    },
    useAnimatedStyle: (fn: any) => fn(),
    runOnJS: (fn: any) => fn,
  };
});

jest.mock(
  '../../src/components/CallControls',
  () => (props: any) => require('react').createElement('CallControls', props),
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
  beforeEach(() => {
    mockSharedValues.length = 0;
    mockPanCallbacks.onStart = null;
    mockPanCallbacks.onUpdate = null;
    jest
      .spyOn(ReactNative, 'useWindowDimensions')
      .mockReturnValue(({ width: 400, height: 800 } as any));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('renders with the draggable-call-controls testID', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<DraggableCallControls {...createProps()} />);
    });

    // findAllByProps returns one entry per fiber level (component + host);
    // assert at least one node carries the testID.
    expect(
      tree.root.findAllByProps({ testID: 'draggable-call-controls' }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  test('forwards all control props to CallControls', () => {
    const onMuteToggle = jest.fn();
    const onLeave = jest.fn();
    let tree: any;
    act(() => {
      tree = renderer.create(
        <DraggableCallControls {...createProps({ isMuted: true, onMuteToggle, onLeave })} />,
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
    let tree: any;
    act(() => {
      tree = renderer.create(<DraggableCallControls {...createProps()} />);
    });

    const { View } = require('react-native');
    const views = tree.root.findAllByType(View);
    const handleViews = views.filter(
      (v: any) =>
        v.props.accessibilityElementsHidden === true && v.props.importantForAccessibility === 'no',
    );
    expect(handleViews).toHaveLength(1);
  });

  test('floating panel uses position absolute', () => {
    let tree: any;
    act(() => {
      tree = renderer.create(<DraggableCallControls {...createProps()} />);
    });

    const panel = tree.root.findByProps({ testID: 'draggable-call-controls' });
    const flatStyle = Array.isArray(panel.props.style)
      ? Object.assign({}, ...panel.props.style.filter(Boolean))
      : panel.props.style;
    expect(flatStyle.position).toBe('absolute');
  });

  test('clamps drag updates within the visible screen bounds', () => {
    act(() => {
      renderer.create(<DraggableCallControls {...createProps()} />);
    });

    expect(typeof mockPanCallbacks.onStart).toBe('function');
    expect(typeof mockPanCallbacks.onUpdate).toBe('function');

    act(() => {
      mockPanCallbacks.onStart?.();
      mockPanCallbacks.onUpdate?.({ translationX: -1000, translationY: -1000 });
    });

    const numericValues = mockSharedValues.map((sharedValue: any) => sharedValue.value);
    expect(numericValues.every(Number.isFinite)).toBe(true);
    expect(numericValues.some((value: any) => value === 0)).toBe(true);
    expect(numericValues.every((value: any) => value >= 0)).toBe(true);
  });
});
