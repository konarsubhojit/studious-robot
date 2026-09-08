import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState } from 'react-native';
import useVoiceNoteAutoAdvance from '../../src/hooks/useVoiceNoteAutoAdvance';
import { _resetAudioPlayback, playAudio } from '../../src/audioPlayback';
import { setAudioSessionActive } from '../../src/audioSessionState';
import {
  _resetPlayedVoiceNotes,
  flushPlayedVoiceNotes,
} from '../../src/storage/playedVoiceNotes';

/**
 * Auto-advance is driven through the real `audioPlayback` module — only the
 * native player underneath it is faked — so these tests exercise the actual
 * end-of-clip signal rather than a stand-in for it.
 */
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

const NOTES = [
  { messageId: 'msg-1', uri: 'https://media.test/one.m4a', durationMs: 1000 },
  { messageId: 'msg-2', uri: 'https://media.test/two.m4a', durationMs: 2000 },
  { messageId: 'msg-3', uri: 'https://media.test/three.m4a', durationMs: 3000 },
];

function TestHook({ notes, onAdvance }: any) {
  useVoiceNoteAutoAdvance(notes, { onAdvance });
  return null;
}

async function render(notes: any[] = NOTES, onAdvance?: any) {
  let tree: any;
  await act(async () => {
    tree = renderer.create(<TestHook notes={notes} onAdvance={onAdvance} />);
  });
  return tree;
}

/** Drive the note currently playing to its end, the way the native player does. */
async function finishCurrentClip() {
  const listener = mockSound.addPlayBackListener.mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('nothing is playing');
  await act(async () => {
    listener({ currentPosition: 10_000, duration: 10_000 });
    await Promise.resolve();
  });
}

function startedSources() {
  return mockSound.startPlayer.mock.calls.map(call => call[0]);
}

function notifyAppState(nextState: string) {
  (AppState.addEventListener as jest.Mock).mock.calls
    .filter(([event]) => event === 'change')
    .forEach(([, listener]) => listener(nextState));
}

describe('useVoiceNoteAutoAdvance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    require('react-native-fs').__reset();
    _resetPlayedVoiceNotes();
    setAudioSessionActive(false);
  });

  afterEach(() => {
    _resetAudioPlayback();
    _resetPlayedVoiceNotes();
    setAudioSessionActive(false);
  });

  test('a finished note chains into the following unplayed notes', async () => {
    await render();

    await act(async () => {
      await playAudio(NOTES[0].uri, { durationMs: NOTES[0].durationMs });
    });
    await finishCurrentClip();
    expect(startedSources()).toEqual([NOTES[0].uri, NOTES[1].uri]);

    await finishCurrentClip();
    expect(startedSources()).toEqual([NOTES[0].uri, NOTES[1].uri, NOTES[2].uri]);
  });

  test('the run stops at the end rather than wrapping back into history', async () => {
    await render();

    await act(async () => {
      await playAudio(NOTES[2].uri, { durationMs: NOTES[2].durationMs });
    });
    await finishCurrentClip();

    // Nothing newer to play: the earlier, already-heard notes are never
    // restarted.
    expect(startedSources()).toEqual([NOTES[2].uri]);
  });

  test('other audio attachments do not chain into a voice note', async () => {
    await render();

    await act(async () => {
      await playAudio('https://media.test/podcast.mp3', { durationMs: 5000 });
    });
    await finishCurrentClip();

    expect(startedSources()).toEqual(['https://media.test/podcast.mp3']);
  });

  test('does not advance while a call owns the audio session', async () => {
    await render();

    await act(async () => {
      await playAudio(NOTES[0].uri, { durationMs: NOTES[0].durationMs });
    });
    setAudioSessionActive(true);
    await finishCurrentClip();

    expect(startedSources()).toEqual([NOTES[0].uri]);
  });

  test('does not advance once the app has been backgrounded', async () => {
    await render();

    await act(async () => {
      await playAudio(NOTES[0].uri, { durationMs: NOTES[0].durationMs });
    });
    await act(async () => {
      notifyAppState('background');
    });
    await finishCurrentClip();

    expect(startedSources()).toEqual([NOTES[0].uri]);
  });

  test('skips notes already played on an earlier visit', async () => {
    await render();
    await act(async () => {
      await playAudio(NOTES[1].uri, { durationMs: NOTES[1].durationMs });
    });
    await act(async () => {
      await flushPlayedVoiceNotes();
    });

    // A later visit: the in-memory set is gone, the persisted one is not.
    _resetAudioPlayback();
    _resetPlayedVoiceNotes();
    jest.clearAllMocks();
    await render();

    await act(async () => {
      await playAudio(NOTES[0].uri, { durationMs: NOTES[0].durationMs });
    });
    await finishCurrentClip();

    expect(startedSources()).toEqual([NOTES[0].uri, NOTES[2].uri]);
  });

  test("skips the user's own notes and reports the note it started", async () => {
    const onAdvance = jest.fn();
    await render(
      [NOTES[0], { ...NOTES[1], isOwn: true }, NOTES[2]],
      onAdvance,
    );

    await act(async () => {
      await playAudio(NOTES[0].uri, { durationMs: NOTES[0].durationMs });
    });
    await finishCurrentClip();

    expect(startedSources()).toEqual([NOTES[0].uri, NOTES[2].uri]);
    expect(onAdvance).toHaveBeenCalledWith(NOTES[2].messageId);
  });
});
