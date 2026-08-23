import React from 'react';
import renderer, { act } from 'react-test-renderer';
import AudioAttachmentPlayer from '../../src/components/AudioAttachmentPlayer';
import {
  _resetAudioPlayback,
  getAudioPlaybackState,
  subscribeAudioPlayback,
} from '../../src/audioPlayback';

const mockSound = {
  startPlayer: jest.fn().mockResolvedValue('ok'),
  pausePlayer: jest.fn().mockResolvedValue('ok'),
  resumePlayer: jest.fn().mockResolvedValue('ok'),
  stopPlayer: jest.fn().mockResolvedValue('ok'),
  seekToPlayer: jest.fn().mockResolvedValue('ok'),
  addPlayBackListener: jest.fn(),
  removePlayBackListener: jest.fn(),
};

jest.mock('react-native-nitro-sound', () => ({ default: mockSound }));

function findByTestId(tree: any, testID: string) {
  return tree.root.findAll((node: any) => node.props?.testID === testID)[0] ?? null;
}

function render(props: any) {
  let tree: any;
  act(() => {
    tree = renderer.create(<AudioAttachmentPlayer {...props} />);
  });
  return tree;
}

describe('AudioAttachmentPlayer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    _resetAudioPlayback();
  });

  test('shows the total duration before anything has played', () => {
    const tree = render({ uri: 'https://media.test/a.m4a', durationMs: 65_000 });
    expect(findByTestId(tree, 'chat-audio-player-elapsed').props.children).toBe('0:00');
    expect(findByTestId(tree, 'chat-audio-player-duration').props.children).toBe('1:05');
  });

  test('tapping play starts playback, and tapping again pauses it', async () => {
    const tree = render({ uri: 'https://media.test/a.m4a', durationMs: 4000 });

    await act(async () => {
      await findByTestId(tree, 'chat-audio-player-toggle').props.onPress();
    });
    expect(mockSound.startPlayer).toHaveBeenCalledWith('https://media.test/a.m4a');
    expect(getAudioPlaybackState()).toMatchObject({ isPlaying: true });

    await act(async () => {
      await findByTestId(tree, 'chat-audio-player-toggle').props.onPress();
    });
    expect(mockSound.pausePlayer).toHaveBeenCalled();
    expect(getAudioPlaybackState().isPlaying).toBe(false);
  });

  test('playing a second voice note stops the first, and the first returns to its idle state', async () => {
    const first = render({ uri: 'https://media.test/first.m4a', testID: 'first' });
    const second = render({ uri: 'https://media.test/second.m4a', testID: 'second' });

    await act(async () => {
      await findByTestId(first, 'first-toggle').props.onPress();
    });
    await act(async () => {
      await findByTestId(second, 'second-toggle').props.onPress();
    });

    expect(mockSound.stopPlayer).toHaveBeenCalledTimes(1);
    expect(getAudioPlaybackState().uri).toBe('https://media.test/second.m4a');
    expect(findByTestId(first, 'first-toggle').props.accessibilityLabel).toBe(
      'Play voice message',
    );
    expect(findByTestId(second, 'second-toggle').props.accessibilityLabel).toBe(
      'Pause voice message',
    );
  });

  test('tapping the scrubber seeks proportionally', async () => {
    const tree = render({ uri: 'https://media.test/a.m4a', durationMs: 10_000 });
    await act(async () => {
      await findByTestId(tree, 'chat-audio-player-toggle').props.onPress();
    });

    act(() => {
      findByTestId(tree, 'chat-audio-player-track').props.onLayout({
        nativeEvent: { layout: { width: 200 } },
      });
    });
    await act(async () => {
      findByTestId(tree, 'chat-audio-player-track').props.onPress({
        nativeEvent: { locationX: 50 },
      });
    });

    expect(mockSound.seekToPlayer).toHaveBeenCalledWith(2500);
  });

  test('an attachment that is still uploading reports why it cannot play', async () => {
    const tree = render({ uri: null, durationMs: 0 });

    await act(async () => {
      await findByTestId(tree, 'chat-audio-player-toggle').props.onPress();
    });

    expect(findByTestId(tree, 'chat-audio-player-error').props.children).toMatch(/uploading/i);
    expect(mockSound.startPlayer).not.toHaveBeenCalled();
  });

  test('renders the shared player position as it advances', async () => {
    const tree = render({ uri: 'https://media.test/a.m4a', durationMs: 10_000 });
    const seen: any[] = [];
    subscribeAudioPlayback(state => seen.push(state));

    await act(async () => {
      await findByTestId(tree, 'chat-audio-player-toggle').props.onPress();
    });
    const emit = mockSound.addPlayBackListener.mock.calls[0][0];
    act(() => {
      emit({ currentPosition: 3000, duration: 10_000 });
    });

    expect(findByTestId(tree, 'chat-audio-player-elapsed').props.children).toBe('0:03');
    expect(seen.length).toBeGreaterThan(0);
  });
});
