import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

/** Trailing window for persisting a composer draft while the user is typing. */
const DRAFT_PERSIST_DEBOUNCE_MS = 750;

export type UseDraftPersistenceParams = {
  /** The draft restored from storage when the screen mounts, if any. */
  initialText: string;
  /** The message the composer is currently replying to, saved alongside the text. */
  replyToId: string | null;
  /** Writes the draft through to storage. May change identity freely. */
  onSaveDraft?: (text: string, replyToId: string | null) => void;
};

export type DraftPersistence = {
  /** The composer's text. */
  draft: string;
  /** Updates the composer's text; persistence follows automatically. */
  setDraft: (text: string) => void;
  /**
   * Write the draft through right now, cancelling any pending debounce. Stable
   * for the lifetime of the hook.
   */
  persistDraftNow: () => void;
  /**
   * Record synchronously that there is no longer a draft to save, for the send
   * path: unmounting in the same commit as the send would otherwise persist the
   * sent text back. Stable for the lifetime of the hook.
   */
  markDraftCleared: () => void;
};

/**
 * Owns the composer draft and everything that writes it through.
 *
 * The draft is persisted when the user *leaves* (screen closed, app
 * backgrounded), never per keystroke: writing on every character would push a
 * state update through the chat provider on each key, re-rendering the whole
 * conversation.
 *
 * Every touchpoint of the debounce timer lives in this one file — the
 * `setTimeout` that schedules it, the debounce effect's own cleanup, the
 * `AppState` flush, and the unmount flush. That is the point of the hook: the
 * previous arrangement had the timer cleared from three places spread through a
 * 977-line component, including an aggregate unmount effect several hundred
 * lines away, which is the shape of the defect fixed in #263. The `AppState`
 * subscription is likewise created and removed by a single effect here.
 *
 * @param params
 */
export default function useDraftPersistence({
  initialText,
  replyToId,
  onSaveDraft,
}: UseDraftPersistenceParams): DraftPersistence {
  const [draft, setDraft] = useState(() => initialText);
  const draftPersistTimerRef = useRef((undefined as ReturnType<typeof setTimeout> | undefined));
  // The first render must not schedule a save: restoring a draft into the
  // composer is not the user editing it.
  const didMountDraftPersistRef = useRef(false);
  // What gets written, read at flush time rather than captured, so the flush
  // callback can stay referentially stable.
  const draftStateRef = useRef({ text: initialText, replyToId });

  useEffect(() => {
    draftStateRef.current = { text: draft, replyToId };
  }, [draft, replyToId]);

  const onSaveDraftRef = useRef(onSaveDraft);
  useEffect(() => {
    onSaveDraftRef.current = onSaveDraft;
  }, [onSaveDraft]);

  const persistDraftNow = useCallback(() => {
    clearTimeout(draftPersistTimerRef.current);
    draftPersistTimerRef.current = undefined;
    const { text, replyToId: pendingReplyToId } = draftStateRef.current;
    onSaveDraftRef.current?.(text, pendingReplyToId);
  }, []);

  const markDraftCleared = useCallback(() => {
    draftStateRef.current = { text: '', replyToId: null };
  }, []);

  useEffect(() => {
    if (!didMountDraftPersistRef.current) {
      didMountDraftPersistRef.current = true;
      return undefined;
    }
    clearTimeout(draftPersistTimerRef.current);
    draftPersistTimerRef.current = setTimeout(persistDraftNow, DRAFT_PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(draftPersistTimerRef.current);
  }, [draft, persistDraftNow, replyToId]);

  useEffect(() => {
    const subscription = AppState.addEventListener?.('change', nextState => {
      if (nextState !== 'active') persistDraftNow();
    });
    return () => {
      subscription?.remove?.();
      // Also the unmount flush: `persistDraftNow` clears the pending timer, so
      // no scheduled save can outlive this component.
      persistDraftNow();
    };
  }, [persistDraftNow]);

  return { draft, setDraft, persistDraftNow, markDraftCleared };
}
