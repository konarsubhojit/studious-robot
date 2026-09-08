import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { logInfo } from '../appLogger';
import { isAudioSessionActive } from '../audioSessionState';
import {
  playAudio,
  subscribeAudioPlayback,
  subscribeAudioPlaybackCompletion,
} from '../audioPlayback';
import {
  hydratePlayedVoiceNotes,
  isVoiceNotePlayed,
  markVoiceNotePlayed,
} from '../storage/playedVoiceNotes';

/**
 * One playable voice note of the open conversation, as the conversation
 * orders them: oldest first.
 */
export type VoiceNoteTarget = {
  messageId: string;
  uri: string;
  durationMs?: number | null;
  /** The user's own note; never worth playing back to them, so it is skipped. */
  isOwn?: boolean;
};

/**
 * Whether the app is on screen. Only the two states that mean it is not are
 * treated as such: React Native reports `null` until the first transition,
 * which must not be mistaken for the app having been backgrounded.
 *
 * @param appState
 */
function isForegrounded(appState: string | null | undefined): boolean {
  return appState !== 'background' && appState !== 'inactive';
}

/**
 * Chains voice-note playback: when a note reaches its end, the next unplayed
 * note of the same conversation starts, so a run of notes can be listened to
 * without tapping each one.
 *
 * The decision lives here, in the conversation layer, because only this layer
 * knows the message order — `audioPlayback` stays a single-clip player that
 * merely reports which source ended.
 *
 * Chaining is deliberately narrow:
 *  - only notes in `voiceNotes` chain, so an audio attachment the user opened
 *    deliberately ends where it ends;
 *  - the scan only moves forward, so the run stops at the newest unplayed note
 *    rather than wrapping round into already-heard history;
 *  - a call owning the audio session, or the app no longer being foregrounded,
 *    ends the run — the same guards `audioPlayback` and the bubble apply to a
 *    tap.
 *
 * @param voiceNotes the conversation's voice notes, oldest first.
 * @param onAdvance told which note auto-advance started, so the conversation
 *   can bring it on screen instead of playing from an off-screen bubble.
 */
export default function useVoiceNoteAutoAdvance(
  voiceNotes: VoiceNoteTarget[],
  { onAdvance }: { onAdvance?: (messageId: string) => void; } = {},
): void {
  // The completion subscription is registered once, so it reads the current
  // notes (and callback) through refs rather than resubscribing per render.
  const voiceNotesRef = useRef(voiceNotes);
  voiceNotesRef.current = voiceNotes;
  const onAdvanceRef = useRef(onAdvance);
  onAdvanceRef.current = onAdvance;
  const isForegroundedRef = useRef(isForegrounded((AppState.currentState as string | null)));

  useEffect(() => {
    void hydratePlayedVoiceNotes();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      isForegroundedRef.current = isForegrounded(nextState);
    });
    return () => subscription.remove();
  }, []);

  // Playing a note at all — by tap or by chain — is what makes it "played",
  // so a note is not offered again on a later visit.
  useEffect(
    () =>
      subscribeAudioPlayback(next => {
        if (!next.uri) return;
        const note = voiceNotesRef.current.find(candidate => candidate.uri === next.uri);
        if (note) markVoiceNotePlayed(note.messageId);
      }),
    [],
  );

  const isPlayed = useCallback(
    (note: VoiceNoteTarget) => Boolean(note.isOwn) || isVoiceNotePlayed(note.messageId),
    [],
  );

  useEffect(
    () =>
      subscribeAudioPlaybackCompletion(uri => {
        const notes = voiceNotesRef.current;
        const finishedIndex = notes.findIndex(note => note.uri === uri);
        // Not one of this conversation's voice notes: an audio attachment the
        // user opened deliberately, which must not chain into anything.
        if (finishedIndex === -1) return;
        markVoiceNotePlayed(notes[finishedIndex].messageId);

        const next = notes.slice(finishedIndex + 1).find(note => !isPlayed(note) && note.uri);
        if (!next) return;

        if (isAudioSessionActive()) {
          logInfo('[VoiceNotes] auto-advance stopped: a call owns the audio session');
          return;
        }
        if (!isForegroundedRef.current) {
          logInfo('[VoiceNotes] auto-advance stopped: the app is not in the foreground');
          return;
        }

        logInfo('[VoiceNotes] auto-advancing to the next unplayed voice note');
        onAdvanceRef.current?.(next.messageId);
        void playAudio(next.uri, { durationMs: next.durationMs ?? 0 });
      }),
    [isPlayed],
  );
}
