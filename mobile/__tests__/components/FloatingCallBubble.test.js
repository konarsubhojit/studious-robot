import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { PanResponder } from 'react-native';
import FloatingCallBubble from '../../src/components/FloatingCallBubble';

jest.mock('../../src/components/IconButton', () => (props) =>
  require('react').createElement('IconButton', props),
);

function findByTestId(tree, testID) {
  return tree.root.findAll((node) => node.props?.testID === testID)[0] ?? null;
}

/**
 * The most recent config object passed to `PanResponder.create(config)`,
 * captured via a spy so drag gestures can be exercised deterministically
 * (grant/move/release with fabricated gestureState), without needing to
 * simulate raw native touch events.
 */
function getPanResponderConfig() {
  const calls = PanResponder.create.mock.calls;
  return calls[calls.length - 1][0];
}

/** Reads the current (x, y) translation applied to the bubble's Animated.View. */
function readBubbleTranslate(tree) {
  const bubble = findByTestId(tree, 'floating-call-bubble');
  const transformStyle = bubble.props.style.find((s) => s && s.transform)?.transform;
  return {
    x: transformStyle[0].translateX.__getValue(),
    y: transformStyle[1].translateY.__getValue(),
  };
}

function render(props) {
  let tree;
  act(() => {
    tree = renderer.create(
      <FloatingCallBubble
        participantLabel="Call with user-bob"
        elapsedCallSeconds={65}
        isMuted={false}
        isScreenSharing={false}
        onExpand={jest.fn()}
        onMuteToggle={jest.fn()}
        onEndCall={jest.fn()}
        onStopScreenShare={jest.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

describe('FloatingCallBubble', () => {
  beforeEach(() => {
    jest.spyOn(PanResponder, 'create');
  });

  afterEach(() => {
    PanResponder.create.mockRestore();
  });

  test('renders the participant label and formatted duration', () => {
    const tree = render();
    const text = tree.root.findAll((n) => n.props?.children === '01:05');
    expect(text.length).toBeGreaterThan(0);
    const label = tree.root.findAll((n) => n.props?.children === 'Call with user-bob');
    expect(label.length).toBeGreaterThan(0);
  });

  test('falls back to a generic label when participantLabel is null', () => {
    const tree = render({ participantLabel: null });
    const label = tree.root.findAll((n) => n.props?.children === 'Call in progress');
    expect(label.length).toBeGreaterThan(0);
  });

  test('tapping the bubble body calls onExpand', () => {
    const onExpand = jest.fn();
    const tree = render({ onExpand });
    act(() => {
      findByTestId(tree, 'floating-call-bubble-expand').props.onPress();
    });
    expect(onExpand).toHaveBeenCalled();
  });

  test('tapping mute calls onMuteToggle', () => {
    const onMuteToggle = jest.fn();
    const tree = render({ onMuteToggle });
    act(() => {
      findByTestId(tree, 'floating-call-bubble-mute').props.onPress();
    });
    expect(onMuteToggle).toHaveBeenCalled();
  });

  test('tapping end call calls onEndCall', () => {
    const onEndCall = jest.fn();
    const tree = render({ onEndCall });
    act(() => {
      findByTestId(tree, 'floating-call-bubble-end').props.onPress();
    });
    expect(onEndCall).toHaveBeenCalled();
  });

  test('stop-share button only renders when isScreenSharing is true', () => {
    const notSharing = render({ isScreenSharing: false });
    expect(findByTestId(notSharing, 'floating-call-bubble-stop-share')).toBeNull();

    const onStopScreenShare = jest.fn();
    const sharing = render({ isScreenSharing: true, onStopScreenShare });
    const stopShareButton = findByTestId(sharing, 'floating-call-bubble-stop-share');
    expect(stopShareButton).not.toBeNull();
    act(() => {
      stopShareButton.props.onPress();
    });
    expect(onStopScreenShare).toHaveBeenCalled();
  });

  // ── drag-to-reposition (FloatingCallBubble minimize regression coverage) ──

  test('starts anchored to the bottom-right corner of the screen', () => {
    const tree = render();
    // Default test-environment window is 750x1334; bubble is 180x72 with a
    // 12px margin, so it should start clamped to the bottom-right corner.
    expect(readBubbleTranslate(tree)).toEqual({ x: 558, y: 1250 });
  });

  test('onMoveShouldSetPanResponder only claims the gesture past a small movement threshold', () => {
    render();
    const config = getPanResponderConfig();
    expect(config.onMoveShouldSetPanResponder({}, { dx: 1, dy: 1 })).toBe(false);
    expect(config.onMoveShouldSetPanResponder({}, { dx: 5, dy: 0 })).toBe(true);
    expect(config.onMoveShouldSetPanResponder({}, { dx: 0, dy: -5 })).toBe(true);
  });

  test('dragging repositions the bubble by the gesture delta', () => {
    const tree = render();
    const config = getPanResponderConfig();

    act(() => {
      config.onPanResponderGrant({}, { dx: 0, dy: 0 });
      config.onPanResponderRelease({}, { dx: -40, dy: -30 });
    });
    act(() => {
      tree.update(
        <FloatingCallBubble
          participantLabel="Call with user-bob"
          elapsedCallSeconds={65}
          onExpand={jest.fn()}
          onMuteToggle={jest.fn()}
          onEndCall={jest.fn()}
          onStopScreenShare={jest.fn()}
        />,
      );
    });

    // Starting at (558, 1250), dragged up-and-left by (40, 30).
    expect(readBubbleTranslate(tree)).toEqual({ x: 518, y: 1220 });
  });

  test('dragging clamps the bubble within the screen bounds instead of letting it go off-screen', () => {
    const tree = render();
    const config = getPanResponderConfig();

    act(() => {
      config.onPanResponderGrant({}, { dx: 0, dy: 0 });
      // A drag far larger than the screen, in both directions.
      config.onPanResponderRelease({}, { dx: -10000, dy: -10000 });
    });

    const afterFirstDrag = readBubbleTranslate(tree);
    expect(afterFirstDrag.x).toBe(12); // BUBBLE_MARGIN
    expect(afterFirstDrag.y).toBe(12); // BUBBLE_MARGIN

    act(() => {
      config.onPanResponderGrant({}, { dx: 0, dy: 0 });
      config.onPanResponderRelease({}, { dx: 10000, dy: 10000 });
    });

    const afterSecondDrag = readBubbleTranslate(tree);
    expect(afterSecondDrag.x).toBe(558); // maxX
    expect(afterSecondDrag.y).toBe(1250); // maxY
  });

  test('tab-switch (re-render with the same props) preserves the dragged position', () => {
    const tree = render();
    const config = getPanResponderConfig();

    act(() => {
      config.onPanResponderGrant({}, { dx: 0, dy: 0 });
      config.onPanResponderRelease({}, { dx: -100, dy: -50 });
    });
    const afterDrag = readBubbleTranslate(tree);

    // Simulate the parent re-rendering this same bubble (e.g. after switching
    // tabs and back) with fresh callback identities but no position props.
    act(() => {
      tree.update(
        <FloatingCallBubble
          participantLabel="Call with user-bob"
          elapsedCallSeconds={70}
          onExpand={jest.fn()}
          onMuteToggle={jest.fn()}
          onEndCall={jest.fn()}
          onStopScreenShare={jest.fn()}
        />,
      );
    });

    expect(readBubbleTranslate(tree)).toEqual(afterDrag);
  });
});
