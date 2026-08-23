import React from 'react';
import renderer, { act } from 'react-test-renderer';
import MediaViewer, { resolveMediaGesture } from '../../src/components/MediaViewer';

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

function render(props: any) {
  let tree: any;
  act(() => {
    tree = renderer.create(<MediaViewer {...props} />);
  });
  return tree;
}

describe('MediaViewer', () => {
  beforeEach(() => {
    mockLoadVideoComponent.mockReset();
    mockLoadVideoComponent.mockReturnValue(null);
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
    const pannable = tree.root.findAll((node: any) => typeof node.props?.onMoveShouldSetResponder === 'function')[0];
    const scaleOf = (node: any) =>
      []
        .concat(node.props.style)
        .flat()
        .map((entry: any) => entry?.transform?.find?.((item: any) => 'scale' in item)?.scale)
        .find((value: any) => typeof value === 'number');

    const tap = () =>
      act(() => {
        pannable.props.onResponderRelease({ nativeEvent: { touches: [] } }, { dx: 0, dy: 0 });
      });

    expect(scaleOf(pannable)).toBe(1);
    tap();
    tap();
    expect(scaleOf(pannable)).toBeGreaterThan(1);
    tap();
    tap();
    expect(scaleOf(pannable)).toBe(1);
  });

  test('reports an attachment that can no longer be loaded instead of showing a blank frame', () => {
    const tree = render({ items: [IMAGE], visible: true });

    act(() => {
      findByTestId(tree, 'media-viewer-image').props.onError();
    });

    expect(findByTestId(tree, 'media-viewer-error')).not.toBeNull();
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
