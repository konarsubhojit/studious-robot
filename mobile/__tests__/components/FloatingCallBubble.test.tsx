import React from 'react';
import renderer, { act } from 'react-test-renderer';
import FloatingCallBubble from '../../src/components/FloatingCallBubble';
import { triggerHaptic } from '../../src/haptics';
import { fontScaleCaps } from '../../src/theme';

/** Pan-gesture callbacks captured from the mocked gesture builder. */
const mockPanCallbacks: { onStart?: any; onUpdate?: any; onEnd?: any; } = {};

jest.mock('react-native-gesture-handler', () => ({
  __esModule: true,
  GestureDetector: ({ children }: any) => children,
  Gesture: {
    Pan: () => ({
      minDistance: function () {
        return this;
      },
      onStart: function (callback: any) {
        mockPanCallbacks.onStart = callback;
        return this;
      },
      onUpdate: function (callback: any) {
        mockPanCallbacks.onUpdate = callback;
        return this;
      },
      onEnd: function (callback: any) {
        mockPanCallbacks.onEnd = callback;
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
    // Backed by a ref so values survive re-renders, like real shared values.
    useSharedValue: (init: any) => {
      const ref = require('react').useRef((null as any));
      if (ref.current === null) {
        ref.current = { value: init };
      }
      return ref.current;
    },
    useAnimatedStyle: (fn: any) => fn(),
    // Animations resolve instantly so assertions can read the settled value;
    // completion callbacks are invoked as if the animation finished.
    withSpring: (toValue: any) => toValue,
    withTiming: (toValue: any, _config: any, callback: any) => {
      callback?.(true);
      return toValue;
    },
    runOnJS: (fn: any) => fn,
    ZoomIn: { springify: () => 'zoom-in' },
    ZoomOut: 'zoom-out',
  };
});

jest.mock('../../src/haptics', () => ({
  __esModule: true,
  triggerHaptic: jest.fn(),
}));

jest.mock(
  '../../src/components/IconButton',
  () => (props: any) => require('react').createElement('IconButton', props),
);

function findByTestId(tree: any, testID: any) {
  return tree.root.findAll((node: any) => node.props?.testID === testID)[0] ?? null;
}

/** Reads the current (x, y) translation applied to the bubble's Animated.View. */
function readBubbleTranslate(tree: any) {
  const bubble = findByTestId(tree, 'floating-call-bubble');
  const transform = bubble.props.style.find((s: any) => s && s.transform)?.transform;
  return { x: transform[0].translateX, y: transform[1].translateY };
}

function bubbleElement(props: any) {
  return (
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
    />
  );
}

function render(props?: any): any {
  let tree: any;
  act(() => {
    tree = renderer.create(bubbleElement(props));
  });
  return tree;
}

/**
 * Re-renders so the mocked `useAnimatedStyle` recomputes from the shared
 * values the gesture worklets just mutated.
 */
function refresh(tree: any, props?: any) {
  act(() => {
    tree.update(bubbleElement(props));
  });
}

describe('FloatingCallBubble', () => {
  beforeEach(() => {
    (triggerHaptic as jest.Mock).mockClear();
    mockPanCallbacks.onStart = null;
    mockPanCallbacks.onUpdate = null;
    mockPanCallbacks.onEnd = null;
  });

  test('renders the participant label and formatted duration', () => {
    const tree = render();
    const text = tree.root.findAll((n: any) => n.props?.children === '01:05');
    expect(text.length).toBeGreaterThan(0);
    const label = tree.root.findAll((n: any) => n.props?.children === 'Call with user-bob');
    expect(label.length).toBeGreaterThan(0);
  });

  test('falls back to a generic label when participantLabel is null', () => {
    const tree = render({ participantLabel: null });
    const label = tree.root.findAll((n: any) => n.props?.children === 'Call in progress');
    expect(label.length).toBeGreaterThan(0);
  });

  test('tapping the bubble body calls onExpand with a haptic', () => {
    const onExpand = jest.fn();
    const tree = render({ onExpand });
    act(() => {
      findByTestId(tree, 'floating-call-bubble-expand').props.onPress();
    });
    expect(onExpand).toHaveBeenCalled();
    expect(triggerHaptic).toHaveBeenCalledWith('tap');
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

  test('dragging repositions the bubble by the gesture delta', () => {
    const tree = render();

    act(() => {
      mockPanCallbacks.onStart?.();
      mockPanCallbacks.onUpdate?.({ translationX: -40, translationY: -30 });
    });
    refresh(tree);

    // Starting at (558, 1250), dragged up-and-left by (40, 30).
    expect(readBubbleTranslate(tree)).toEqual({ x: 518, y: 1220 });
  });

  test('dragging clamps the bubble within the screen bounds instead of letting it go off-screen', () => {
    const tree = render();

    act(() => {
      mockPanCallbacks.onStart?.();
      mockPanCallbacks.onUpdate?.({ translationX: -10000, translationY: -10000 });
    });
    refresh(tree);

    expect(readBubbleTranslate(tree)).toEqual({ x: 12, y: 12 }); // BUBBLE_MARGIN

    act(() => {
      mockPanCallbacks.onStart?.();
      mockPanCallbacks.onUpdate?.({ translationX: 10000, translationY: 10000 });
    });
    refresh(tree);

    expect(readBubbleTranslate(tree)).toEqual({ x: 558, y: 1250 }); // maxX / maxY
  });

  test('releasing near the left half springs the bubble to the left edge', () => {
    const tree = render();

    act(() => {
      mockPanCallbacks.onStart?.();
      mockPanCallbacks.onUpdate?.({ translationX: -450, translationY: -600 });
      mockPanCallbacks.onEnd?.({ velocityX: 0, velocityY: 0 });
    });
    refresh(tree);

    const { x, y } = readBubbleTranslate(tree);
    expect(x).toBe(12);
    expect(y).toBe(650);
  });

  test('releasing near the right half springs the bubble back to the right edge', () => {
    const tree = render();

    act(() => {
      mockPanCallbacks.onStart?.();
      mockPanCallbacks.onUpdate?.({ translationX: -100, translationY: -600 });
      mockPanCallbacks.onEnd?.({ velocityX: 0, velocityY: 0 });
    });
    refresh(tree);

    expect(readBubbleTranslate(tree).x).toBe(558);
  });

  test('flinging the bubble sideways dismisses it', () => {
    const onDismiss = jest.fn();
    render({ onDismiss });

    act(() => {
      mockPanCallbacks.onStart?.();
      mockPanCallbacks.onUpdate?.({ translationX: 20, translationY: 0 });
      mockPanCallbacks.onEnd?.({ velocityX: 2400, velocityY: 0 });
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(triggerHaptic).toHaveBeenCalledWith('tap');
  });

  test('a slow drag release never dismisses the bubble', () => {
    const onDismiss = jest.fn();
    render({ onDismiss });

    act(() => {
      mockPanCallbacks.onStart?.();
      mockPanCallbacks.onUpdate?.({ translationX: -200, translationY: 0 });
      mockPanCallbacks.onEnd?.({ velocityX: -200, velocityY: 0 });
    });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('a fling never dismisses the bubble when no onDismiss handler is wired up', () => {
    const tree = render({ onDismiss: undefined });

    act(() => {
      mockPanCallbacks.onStart?.();
      mockPanCallbacks.onUpdate?.({ translationX: -400, translationY: 0 });
      mockPanCallbacks.onEnd?.({ velocityX: -2400, velocityY: 0 });
    });
    refresh(tree, { onDismiss: undefined });

    // Springs back to an on-screen edge rather than animating away for good.
    expect(readBubbleTranslate(tree).x).toBe(12);
  });

  test('tab-switch (re-render with the same props) preserves the dragged position', () => {
    const tree = render();

    act(() => {
      mockPanCallbacks.onStart?.();
      mockPanCallbacks.onUpdate?.({ translationX: -100, translationY: -50 });
    });
    refresh(tree);
    const afterDrag = readBubbleTranslate(tree);

    // Simulate the parent re-rendering this same bubble (e.g. after switching
    // tabs and back) with fresh callback identities but no position props.
    refresh(tree, { elapsedCallSeconds: 70 });

    expect(readBubbleTranslate(tree)).toEqual(afterDrag);
  });

  /**
   * `BUBBLE_WIDTH`/`BUBBLE_HEIGHT` are not styling, they are the drag maths:
   * the pan worklets clamp against them and the fling exit target is derived
   * from the width. A bubble that rendered larger than its constants would
   * settle partly off-screen with no way to drag it back — so, uniquely among
   * the app's chrome, this box really cannot grow, and both of its texts are
   * capped rather than reflowed.
   */
  describe('dynamic type', () => {
    function textNodeWith(tree: any, content: string) {
      return (
        tree.root.findAll((n: any) => n.type === 'Text' && n.props?.children === content)[0] ?? null
      );
    }

    test('caps both texts, because the bubble is a fixed box the worklets measure', () => {
      const tree = render();

      expect(
        textNodeWith(tree, 'Call with user-bob').props.maxFontSizeMultiplier,
      ).toBe(fontScaleCaps.control);
      expect(textNodeWith(tree, '01:05').props.maxFontSizeMultiplier).toBe(fontScaleCaps.control);
    });
  });
});
