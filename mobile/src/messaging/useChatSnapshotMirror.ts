import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { flushChatDb, loadChatSnapshot, saveChatSnapshot } from '../storage/chatDb';
import type { ChatSnapshot } from '../storage/chatDb';
import type { Drafts } from './drafts';
import type { ConversationSummary, MessagesByPeer } from './types';

/**
 * Trailing window over which chat-state changes are coalesced into a single
 * mirror into the local store. Sized to be shorter than a user's attention
 * span but long enough to absorb a burst (a fetched history page, a run of
 * delivery/read receipts) into one prune-and-write.
 */
export const SNAPSHOT_PERSIST_DEBOUNCE_MS = 750;

/**
 * The local mirror of the rendered chat state: hydrate from the durable store
 * on mount, then write back what is on screen.
 *
 * Two properties are load-bearing and each has a test:
 *
 * - **Hydrate-then-fetch.** Whatever was cached locally renders straight away
 *   (so launching offline — or before the first response lands — shows real
 *   conversations and history instead of an empty app). Persistence is gated
 *   on that read having happened, so an empty first render cannot overwrite
 *   the cache with nothing.
 * - **The write is trailing-debounced, and force-flushed.** Mirroring on every
 *   state change (a delivery receipt, a typing-driven re-render, each message
 *   of a fetched page) would re-prune every conversation's history on the JS
 *   thread; a burst therefore costs one prune. The tail is not at risk because
 *   the state is flushed when the app leaves the foreground — the last moment
 *   the process is guaranteed to be alive — and when the hook unmounts.
 *
 * @param onHydrate applies the loaded snapshot to the caller's state. Called
 *   at most once, and never after unmount.
 */
export default function useChatSnapshotMirror({
  conversations,
  messagesByPeer,
  drafts,
  onHydrate,
}: {
  conversations: ConversationSummary[];
  messagesByPeer: MessagesByPeer;
  drafts: Drafts;
  onHydrate: (snapshot: ChatSnapshot) => void;
}) {
  // True once the local store has been read; gates persistence so an empty
  // initial render can't overwrite the cached history with nothing.
  const hydratedRef = useRef(false);
  const snapshotRef = useRef({ conversations, messagesByPeer, drafts: {} as Drafts });
  const persistTimerRef = useRef((null as ReturnType<typeof setTimeout> | null));
  const onHydrateRef = useRef(onHydrate);

  useEffect(() => {
    onHydrateRef.current = onHydrate;
  }, [onHydrate]);

  useEffect(() => {
    let cancelled = false;
    loadChatSnapshot()
      .then(snapshot => {
        if (cancelled) return;
        // Flagged hydrated before the snapshot is applied, so anything the
        // caller kicks off from it (replaying a queued send) already sees a
        // store that may be written back to.
        hydratedRef.current = true;
        onHydrateRef.current(snapshot);
      })
      .catch(() => {
        hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Write the pending mirror out now, cancelling the debounce. */
  const persistNow = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (!hydratedRef.current) return;
    saveChatSnapshot(snapshotRef.current);
  }, []);

  useEffect(() => {
    snapshotRef.current = { conversations, messagesByPeer, drafts };
    if (!hydratedRef.current) return undefined;
    if (persistTimerRef.current) return undefined;
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      saveChatSnapshot(snapshotRef.current);
    }, SNAPSHOT_PERSIST_DEBOUNCE_MS);
    return undefined;
  }, [conversations, messagesByPeer, drafts]);

  // Leaving the foreground is the last moment the process is guaranteed to be
  // alive, so the pending mirror is written out (and pushed to disk) there.
  useEffect(() => {
    const subscription = AppState.addEventListener?.('change', nextState => {
      if (nextState === 'active') return;
      persistNow();
      flushChatDb();
    });
    return () => subscription?.remove?.();
  }, [persistNow]);

  useEffect(() => () => persistNow(), [persistNow]);

  return { persistNow };
}
