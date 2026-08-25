import React from 'react';
import { Gesture } from 'react-native-gesture-handler';
import renderer, { act } from 'react-test-renderer';
import MediaViewer, { resolveMediaGesture } from '../../src/components/MediaViewer';
import { setAudioSessionActive } from '../../src/audioSessionState';

const mockLoadVideoComponent = jest.fn();
jest.mock('../../src/videoPlayback', () => ({
  loadVideoComponent: (...args: any[]) => mockLoadVideoComponent(...args),
}));

jest.mock(
  '../../src/components/IconButton',
  () => (props: any) => require('react').createElement('IconButton', props),
);

const IMAGE = {
  key: 'm1',
  url: 'https://media.test/chatblobs/c/one.jpg',
  mimeType: 'image/jpeg',
  name: 'one.jpg',
  kind: 'image' as const,
};
const SECOND_IMAGE = { ...IMAGE, key: 'm2', url: 'https://media.test/chatblobs/c/two.jpg', name: 'two.jpg' };
const VIDEO = {
  key: 'm3',
  url: 'https://media.test/chatblobs/c/clip.mp4',
  mimeType: 'video/mp4',
  name: 'clip.mp4',
  kind: 'video' as const,
};

function findByTestId(tree: any, testID: string) {
  return tree.root.findAll((node: any) => node.props?.testID === testID)[0] ?? null;
}

/**
 * Captures the gesture builders the viewer composes, so a drag, a pinch or a
 * double tap can be driven without synthesising a touch stream.
 */
const captured: { pan?: any; pinch?: any; tap?: any; } = {};
const realGestures = { Pan: Gesture.Pan, Pinch: Gesture.Pinch, Tap: Gesture.Tap };
beforeAll(() => {
  for (const [name, key] of [['Pan', 'pan'], ['Pinch', 'pinch'], ['Tap', 'tap']] as const) {
    (Gesture as any)[name] = () => {
      captured[key] = (realGestures as any)[name]();
      return captured[key];
    };
  }
});
afterAll(() => {
  Object.assign(Gesture, realGestures);
});

function render(props: any) {
  const element = () => <MediaViewer {...props} />;
  let tree: any;
  act(() => {
    tree = renderer.create(element());
  });
  // Shared values live outside React state, so the tree has to be re-rendered
  // (from a fresh element, or React bails out) to publish the latest
  // `useAnimatedStyle` output — the UI thread's job on a device.
  tree.rerender = () => act(() => tree.update(element()));
  return tree;
}

/** Reads the transform currently applied to the media wrapper. */
function readTransform(tree: any) {
  tree.rerender();
  const wrapper = findByTestId(tree, 'media-viewer-image').parent;
  const entries = ([] as any[]).concat(wrapper.props.style).flat();
  const transform = entries.find(entry => entry?.transform)?.transform ?? [];
  return Object.assign({}, ...transform);
}

describe('MediaViewer', () => {
  beforeEach(() => {
    mockLoadVideoComponent.mockReset();
    mockLoadVideoComponent.mockReturnValue(null);
    setAudioSessionActive(false);
  });

  test('renders nothing until it is opened', () => {
    const tree = render({ items: [IMAGE], visible: false });
    expect(tree.toJSON()).toBeNull();
  });

  test('shows the image it was opened on, and dismisses through the close button', () => {
    const onClose = jest.fn();
    const tree = render({ items: [IMAGE], initialIndex: 0, visible: true, onClose });

    expect(findByTestId(tree, 'media-viewer-image').props.source).toEqual({ uri: IMAGE.url });

    act(() => {
      findByTestId(tree, 'media-viewer-close').props.onPress();
    });
    expect(onClose).toHaveBeenCalled();
  });

  test('swiping horizontally moves between media items', () => {
    const tree = render({ items: [IMAGE, SECOND_IMAGE], initialIndex: 0, visible: true });
    expect(findByTestId(tree, 'media-viewer-counter').props.children).toBe('1 / 2');

    act(() => {
      findByTestId(tree, 'media-viewer-next').props.onPress();
    });
    expect(findByTestId(tree, 'media-viewer-image').props.source).toEqual({ uri: SECOND_IMAGE.url });
    expect(findByTestId(tree, 'media-viewer-counter').props.children).toBe('2 / 2');

    act(() => {
      findByTestId(tree, 'media-viewer-previous').props.onPress();
    });
    expect(findByTestId(tree, 'media-viewer-image').props.source).toEqual({ uri: IMAGE.url });
  });

  test('a completed drag resolves to paging, dismissal, panning or nothing', () => {
    const width = 400;
    expect(resolveMediaGesture({ dx: -200, dy: 0, width })).toBe('next');
    expect(resolveMediaGesture({ dx: 200, dy: 0, width })).toBe('previous');
    expect(resolveMediaGesture({ dx: 0, dy: 300, width })).toBe('dismiss');
    // Zoomed in, a drag pans the photo instead of changing item.
    expect(resolveMediaGesture({ dx: -200, dy: 0, scale: 2.5, width })).toBe('pan');
    expect(resolveMediaGesture({ dx: 1, dy: 2, width })).toBe('tap');
    expect(resolveMediaGesture({ dx: -20, dy: 0, width })).toBe('none');
  });

  test('a double tap zooms in, and a second double tap zooms back out', () => {
    const tree = render({ items: [IMAGE], visible: true });

    expect(readTransform(tree).scale).toBe(1);

    act(() => captured.tap.handlers.onEnd());
    expect(readTransform(tree).scale).toBeGreaterThan(1);

    act(() => captured.tap.handlers.onEnd());
    expect(readTransform(tree).scale).toBe(1);
  });

  test('a pinch scales the media and stays inside its zoom limits', () => {
    const tree = render({ items: [IMAGE], visible: true });

    act(() => {
      captured.pinch.handlers.onStart();
      captured.pinch.handlers.onUpdate({ scale: 2 });
    });
    expect(readTransform(tree).scale).toBe(2);

    // Neither a runaway zoom-in nor a pinch below the natural size is allowed.
    act(() => captured.pinch.handlers.onUpdate({ scale: 100 }));
    expect(readTransform(tree).scale).toBe(4);
    act(() => captured.pinch.handlers.onUpdate({ scale: 0.01 }));
    expect(readTransform(tree).scale).toBe(1);
  });

  test('pinching back out re-centres the media instead of stranding it off-screen', () => {
    const tree = render({ items: [IMAGE], visible: true });

    act(() => {
      captured.pinch.handlers.onStart();
      captured.pinch.handlers.onUpdate({ scale: 3 });
      captured.pan.handlers.onStart();
      captured.pan.handlers.onUpdate({ translationX: -120, translationY: -80 });
      captured.pan.handlers.onEnd({ translationX: -120, translationY: -80 });
    });
    expect(readTransform(tree).translateX).toBe(-120);

    act(() => {
      captured.pinch.handlers.onUpdate({ scale: 0.1 });
      captured.pinch.handlers.onEnd();
    });
    expect(readTransform(tree)).toMatchObject({ translateX: 0, translateY: 0, scale: 1 });
  });

  test('a drag that means nothing springs the media back to where it started', () => {
    const tree = render({ items: [IMAGE], visible: true });

    act(() => {
      captured.pan.handlers.onStart();
      captured.pan.handlers.onUpdate({ translationX: -20, translationY: 0 });
      captured.pan.handlers.onEnd({ translationX: -20, translationY: 0 });
    });

    expect(readTransform(tree).translateX).toBe(0);
  });

  test('a downward drag dismisses the viewer', () => {
    const onClose = jest.fn();
    const tree = render({ items: [IMAGE], visible: true, onClose });

    act(() => {
      captured.pan.handlers.onStart();
      captured.pan.handlers.onEnd({ translationX: 0, translationY: 300 });
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(readTransform(tree)).toMatchObject({ translateX: 0, translateY: 0, scale: 1 });
  });

  test('a long horizontal drag pages to the next item', () => {
    const tree = render({ items: [IMAGE, SECOND_IMAGE], initialIndex: 0, visible: true });

    act(() => {
      captured.pan.handlers.onStart();
      captured.pan.handlers.onEnd({ translationX: -900, translationY: 0 });
    });

    expect(findByTestId(tree, 'media-viewer-counter').props.children).toBe('2 / 2');
  });

  test('reports an attachment that can no longer be loaded instead of showing a blank frame', () => {
    const tree = render({ items: [IMAGE], visible: true });

    act(() => {
      findByTestId(tree, 'media-viewer-image').props.onError();
    });

    expect(findByTestId(tree, 'media-viewer-error')).not.toBeNull();
  });

  test('does not autoplay a video while a call owns the audio session', () => {
    mockLoadVideoComponent.mockReturnValue('Video');
    setAudioSessionActive(true);
    try {
      const tree = render({ items: [VIDEO], visible: true });
      // The call flow owns the route; the video waits for an explicit tap.
      expect(findByTestId(tree, 'media-viewer-video').props.paused).toBe(true);
    } finally {
      setAudioSessionActive(false);
    }
  });

  test('plays a video with the linked player, and falls back to a download hint without it', () => {
    const Player = (props: any) => require('react').createElement('Video', props);
    mockLoadVideoComponent.mockReturnValueOnce(Player);
    const withPlayer = render({ items: [VIDEO], visible: true });
    expect(findByTestId(withPlayer, 'media-viewer-video').props.source).toEqual({ uri: VIDEO.url });
    expect(findByTestId(withPlayer, 'media-viewer-video').props.controls).toBe(true);

    mockLoadVideoComponent.mockReturnValue(null);
    const withoutPlayer = render({ items: [VIDEO], visible: true });
    expect(findByTestId(withoutPlayer, 'media-viewer-video-unavailable')).not.toBeNull();
  });

  test('offers a download action for the item on screen', () => {
    const onDownload = jest.fn();
    const tree = render({ items: [IMAGE], visible: true, onDownload });

    act(() => {
      findByTestId(tree, 'media-viewer-download').props.onPress();
    });

    expect(onDownload).toHaveBeenCalledWith(IMAGE);
  });

  test('renders a neutral message when the item is gone from the timeline', () => {
    const tree = render({ items: [], visible: true });
    expect(findByTestId(tree, 'media-viewer-empty')).not.toBeNull();
  });
});
