// @ts-check
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { logWarn } from '../appLogger';
import {
  dismissMessageNotification,
  markMessageSeen,
  setActiveConversation,
} from '../messageNotification';
import { loadChatSnapshot, saveChatSnapshot } from '../storage/chatDb';
import { API_ROUTES, MESSAGE_TYPES, isAttachmentMessageType } from '../../../shared';
import { CLIENT_EVENTS } from '../signalingClient';
import { SIGNALING_VERSION } from '../socketProtocol';

/**
 * A chat message as persisted by the server, plus the client-only fields an
 * optimistic send carries until the server acknowledges it.
 */
export type ChatMessage = Omit<import('../../../shared/signaling/schemas').MessageRecord, 'conversationId'> & { conversationId?: string | null; status?: string; peerId?: string; localId?: string; pending?: boolean; failed?: boolean; syncState?: 'pending' | 'synced' | 'failed'; deliveredTo?: string[]; readAt?: string | null; };

/**
 * A message queued for (re)delivery, with the bookkeeping the outbox drain
 * needs: which peer it belongs to, how many sends have been attempted and why
 * the last one failed.
 */
export type OutboxItem = { messageId: string; recipientId: string; conversationId?: string | null; body?: string; type?: string; attachment?: import('../../../shared/signaling/schemas').AttachmentRecord | null; replyTo?: string | null; createdAt?: string; attempts?: number; lastAttemptAt?: string | null; lastError?: string | null; };

/**
 * Newest event of a conversation: either a message or a call, as merged by the
 * server (`lastActivity`).
 */
export type CallActivity = { type: 'call'; callId: string; conversationId?: string; direction: 'incoming' | 'outgoing'; status: string; endReason?: string | null; durationSeconds?: number | null; createdAt: string; };

export type ConversationActivity = ChatMessage | CallActivity;

/**
 * One row of the chat list: the peer, the newest message and whether anything
 * in it is still unread.
 */
export type ConversationSummary = { conversationId?: string; peerId: string; lastMessage?: ChatMessage | null; lastActivity?: ConversationActivity | null; unreadCount?: number; };

/**
 * Safety-net timeout for a peer's typing indicator: cleared automatically
 * this long after the last `isTyping: true` event, in case the corresponding
 * `isTyping: false` event is dropped (e.g. the peer's app is killed mid-type).
 */
const TYPING_INDICATOR_TIMEOUT_MS = 6000;

/** How often `sendTypingIndicator(peerId, true)` may be emitted while the
 * user keeps typing, so every keystroke doesn't trigger a socket emit. */
const TYPING_INDICATOR_THROTTLE_MS = 2000;

/**
 * @param {unknown} error
 * @returns {string|undefined} the error message, when there is one.
 */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/**
 * Identity of a timeline entry: a message id, or a call id for the call
 * records the unified timeline interleaves with the messages.
 *
 * @param {{ messageId?: string, callId?: string }} entry
 * @returns {string | undefined}
 */
function timelineEntryId(entry: { messageId?: string; callId?: string; }): string | undefined {
  return entry?.messageId ?? entry?.callId;
}

/** How many send attempts a queued message gets before it is marked failed
 * and left for the user to retry or delete explicitly. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** First outbox drain retry delay; doubles per attempt up to the cap. */
const OUTBOX_BASE_RETRY_MS = 1000;
/** Ceiling for the exponential backoff between outbox drains. */
const OUTBOX_MAX_RETRY_MS = 60_000;

/**
 * The tombstone a deleted message becomes: the content is gone, the row stays
 * so a reply quoting it still resolves and renders "Message deleted".
 *
 * @param {ChatMessage} message - the local copy being replaced.
 * @param {Partial<ChatMessage>} [serverTombstone] - the server's version, when it sent one.
 * @returns {Partial<ChatMessage>}
 */
function tombstoneOf(message: ChatMessage, serverTombstone?: Partial<ChatMessage>): Partial<ChatMessage> {
  return {
    ...(serverTombstone ?? {}),
    body: '',
    attachment: null,
    reactions: {},
    deletedAt: serverTombstone?.deletedAt ?? message?.deletedAt ?? new Date().toISOString(),
  };
}

/**
 * True while a queued message may still be sent automatically.
 *
 * @param {OutboxItem} item
 * @returns {boolean}
 */
function isRetryable(item: OutboxItem): boolean {
  return (item?.attempts ?? 0) < OUTBOX_MAX_ATTEMPTS;
}

/**
 * Newest-first ordering, matching the server's message ordering.
 *
 * @param {{ createdAt?: string }} a
 * @param {{ createdAt?: string }} b
 * @returns {number}
 */
function byNewestFirst(a: { createdAt?: string; }, b: { createdAt?: string; }): number {
  return Date.parse(b?.createdAt ?? '') - Date.parse(a?.createdAt ?? '');
}

/**
 * Oldest-first ordering, so queued sends are flushed in composition order.
 *
 * @param {{ createdAt?: string }} a
 * @param {{ createdAt?: string }} b
 * @returns {number}
 */
function byOldestFirst(a: { createdAt?: string; }, b: { createdAt?: string; }): number {
  return Date.parse(a?.createdAt ?? '') - Date.parse(b?.createdAt ?? '');
}

/**
 * Client-generated message id. The server upserts on
 * `{ conversationId, messageId }`, so this is what makes a replayed send
 * idempotent rather than a duplicate.
 *
 * Not a security token — it only has to be unique — so a `Math.random()`
 * fallback is fine where the runtime has no `crypto.randomUUID`.
 *
 * @returns {string}
 */
function createMessageId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  const randomHex = (/** @type {number} */ length: number) =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const variant = '89ab'[Math.floor(Math.random() * 4)];
  return (
    `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-` +
    `${variant}${randomHex(3)}-${randomHex(12)}`
  );
}

/**
 * Owns text chat: the conversation list, per-peer message history, optimistic
 * sending, read receipts, and typing indicators.
 *
 * Offline-first: the conversation list and history are hydrated from the local
 * {@link module:storage/chatDb} store on mount and rendered immediately, then
 * reconciled with the server in the background (always by `messageId`, never
 * by array position). Sends go through a durable outbox that is written before
 * the socket emit, so a message composed offline — or one caught by the app
 * being killed mid-send — is replayed on the next connect or launch. Replay is
 * safe because the server upserts on the client-supplied `messageId`.
 *
 * The socket lifecycle itself lives in `useCallFlow`; it forwards the raw
 * `message.*` socket events to the `handle*` methods returned here instead of
 * mutating this hook's state directly, so the messaging state machine stays
 * encapsulated in one place. Extracted out of `useCallFlow` so this concern
 * stays isolated from that hook's call-lifecycle/session/WebRTC
 * responsibilities.
 *
 * @param {{
 *   authedFetchRef: { current: Function | null },
 *   sessionIdRef: { current: string | null },
 *   signalingUrl: string,
 *   signalingRef: { current: import('../signalingClient').SignalingClient | null },
 *   socketRef: { current: import('socket.io-client').Socket | null },
 *   userId: string,
 *   updateStatus: (message: string, severity?: import('../components/StatusBanner').CallStatus['severity']) => void,
 * }} params
 */
export default function useMessaging({
  authedFetchRef,
  sessionIdRef,
  signalingRef,
  signalingUrl,
  socketRef,
  userId,
  updateStatus,
}: {
        authedFetchRef: { current: Function | null; };
        sessionIdRef: { current: string | null; };
        signalingUrl: string;
        signalingRef: { current: import('../signalingClient').SignalingClient | null; };
        socketRef: { current: import('socket.io-client').Socket | null; };
        userId: string;
        updateStatus: (message: string, severity?: import('../components/StatusBanner').CallStatus['severity']) => void;
    }) {
  // One entry per conversation the user participates in: { conversationId,
  // peerId, lastMessage, lastActivity, unreadCount }, newest-activity first.
  // `lastActivity` is whichever of the last message and the last call is
  // newer, so the chat list preview never shows a stale message for a
  // conversation whose latest event was a call.
  const [conversations, setConversations] = useState(
    ([] as ConversationSummary[]),
  );
  // Keyed by peerId → array of message objects, newest-first (matches the
  // server's ordering). Optimistic (pending/failed) sends are tagged inline.
  const [messagesByPeer, setMessagesByPeer] = useState(
    ({} as Record<string, ChatMessage[]>),
  );
  // peerId of the conversation currently open in the UI, or null. Drives
  // auto-mark-read for incoming messages from that peer.
  const [activeChatPeerId, setActiveChatPeerId] = useState((null as string | null));
  // Keyed by peerId → boolean. True while that peer is actively typing in the
  // open conversation (relayed via the ephemeral `message.typing` socket
  // event). Cleared on receipt of isTyping:false or after a short timeout, in
  // case a "stopped typing" event is dropped.
  const [typingByPeer, setTypingByPeer] = useState(({} as Record<string, boolean>));
  const typingTimeoutsRef = useRef(
    ({} as Record<string, ReturnType<typeof setTimeout>>),
  );
  const typingSentAtRef = useRef(({} as Record<string, number>));
  // Mirrors activeChatPeerId so the message.received socket handler never
  // reads a stale value through a captured closure.
  const activeChatPeerIdRef = useRef((null as string | null));

  // ─── Offline-first state ─────────────────────────────────────────────────
  // Durable queue of sends awaiting an ack, mirrored into the local store on
  // every mutation so it survives process death. Held in a ref (not state) so
  // the drain loop always reads the latest queue.
  const outboxRef = useRef(([] as OutboxItem[]));
  const [pendingSendCount, setPendingSendCount] = useState(0);
  // null until the socket reports either way, so the UI doesn't flash an
  // "offline" banner during the first connect.
  const [isSocketConnected, setIsSocketConnected] = useState(
    (null as boolean | null),
  );
  const drainTimerRef = useRef((null as ReturnType<typeof setTimeout> | null));
  const drainAttemptRef = useRef(0);
  const isDrainingRef = useRef(false);
  const drainOutboxRef = useRef(() => {});
  // True once the local store has been read; gates persistence so an empty
  // initial render can't overwrite the cached history with nothing.
  const hydratedRef = useRef(false);
  const conversationsRef = useRef(([] as ConversationSummary[]));

  useEffect(() => {
    activeChatPeerIdRef.current = activeChatPeerId;
  }, [activeChatPeerId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // ─── Hydrate-then-fetch ──────────────────────────────────────────────────
  // Render whatever was cached locally straight away (so launching offline —
  // or before the first response lands — shows real conversations and history
  // instead of an empty app), then let the network refresh it.
  useEffect(() => {
    let cancelled = false;
    loadChatSnapshot()
      .then(snapshot => {
        if (cancelled) return;
        outboxRef.current = snapshot.outbox;
        setPendingSendCount(snapshot.outbox.length);
        // Only fill in what the network hasn't already provided: a response
        // that beat the disk read is newer than the cache.
        setConversations(prev => (prev.length ? prev : snapshot.conversations));
        setMessagesByPeer(prev => {
          const next = { ...snapshot.messagesByPeer, ...prev };
          return next;
        });
        hydratedRef.current = true;
        // Anything still queued from a previous run goes out as soon as the
        // socket allows it — this is what makes a force-quit mid-send safe.
        if (snapshot.outbox.some(isRetryable)) drainOutboxRef.current();
      })
      .catch(() => {
        hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Mirror the rendered chat state into the local store, so the next launch
  // has something to hydrate from.
  useEffect(() => {
    if (!hydratedRef.current) return;
    saveChatSnapshot({ conversations, messagesByPeer });
  }, [conversations, messagesByPeer]);

  // Mirror the open conversation into the push layer, so a message push for
  // the conversation the user is looking at is suppressed instead of being
  // announced by the OS on top of the message they can already see, and any
  // notification left over for it is cleared.
  useEffect(() => {
    if (!activeChatPeerId) {
      setActiveConversation(null);
      return;
    }
    const conversationId =
      conversations.find(c => c.peerId === activeChatPeerId)?.conversationId ?? null;
    setActiveConversation({ peerId: activeChatPeerId, conversationId });
    if (conversationId) dismissMessageNotification(conversationId);
  }, [activeChatPeerId, conversations]);

  /**
   * Fetch the authenticated user's conversation list (`GET /conversations`)
   * and populate `conversations`.  Safe to call repeatedly; silently
   * swallows network errors, mirroring `fetchCallHistory`.
   */
  const fetchConversations = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    try {
      const trimmedUrl = signalingUrl.trim();
      const response = await authedFetchRef.current?.((/** @type {string} */ sid: string) => ({
        url: `${trimmedUrl}${API_ROUTES.CONVERSATIONS}?sessionId=${encodeURIComponent(sid)}`,
      }));
      if (!response?.ok) return;
      const data = await response.json();
      if (!Array.isArray(data.conversations)) return;
      setConversations(data.conversations);
    } catch (error) {
      logWarn('[Messaging] fetchConversations failed', {
        message: errorMessage(error),
      });
    }
  }, [authedFetchRef, sessionIdRef, signalingUrl]);

  /**
   * Fetch a page of conversation history with `peerId` (`GET /messages`) and
   * merge it into `messagesByPeer`.  Pass `{ before }` (an ISO cursor, the
   * oldest held entry's `createdAt`) to page further back; omit it for the
   * first page, which replaces any existing entry for that peer.
   *
   * Requests the unified timeline (`include=calls`), so the page interleaves
   * text messages (`type: 'text'`) with call records (`type: 'call'`) and a
   * conversation shows that the two people also called each other.
   *
   * @param {string} peerId
   * @param {{ before?: string }} [options]
   * @returns {Promise<ChatMessage[]>} the fetched page (empty on failure)
   */
  const fetchMessagesForPeer = useCallback(
    /**
     * @param {string} peerId
     * @param {{ before?: string }} [options]
     */
    async (peerId: string, { before }: { before?: string; } = {}) => {
      const trimmedPeerId = (peerId ?? '').trim();
      const sessionId = sessionIdRef.current;
      if (!sessionId || !trimmedPeerId) return [];
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.((/** @type {string} */ sid: string) => {
          const params = new URLSearchParams({
            sessionId: sid,
            peerId: trimmedPeerId,
          });
          if (before) params.set('before', before);
          params.set('include', 'calls');
          return { url: `${trimmedUrl}${API_ROUTES.MESSAGES}?${params.toString()}` };
        });
        if (!response?.ok) return [];
        const data = await response.json();
        const messages = Array.isArray(data.messages) ? data.messages : [];
        setMessagesByPeer(prev => {
          const existing = prev[trimmedPeerId] ?? [];
          const serverIds = new Set(messages.map(timelineEntryId));
          if (!before) {
            // First page: the server is authoritative for everything it knows
            // about, but entries it has never seen — sends still queued in the
            // outbox — are kept and merged by id, never by position, so an
            // optimistic entry is replaced rather than duplicated.
            const unsent = existing.filter(
              entry =>
                (entry.syncState === 'pending' || entry.syncState === 'failed') &&
                !serverIds.has(timelineEntryId(entry)),
            );
            const merged = unsent.length ? [...unsent, ...messages].sort(byNewestFirst) : messages;
            return { ...prev, [trimmedPeerId]: merged };
          }
          // Pagination: append older entries, deduping by their own id (a
          // call entry carries a `callId` rather than a `messageId`).
          const existingIds = new Set(existing.map(timelineEntryId));
          const merged = [
            ...existing,
            ...messages.filter(
              (/** @type {ChatMessage} */ entry: ChatMessage) => !existingIds.has(timelineEntryId(entry)),
            ),
          ];
          return { ...prev, [trimmedPeerId]: merged };
        });
        return messages;
      } catch (error) {
        logWarn('[Messaging] fetchMessagesForPeer failed', {
          message: errorMessage(error),
        });
        return [];
      }
    },
    [authedFetchRef, sessionIdRef, signalingUrl],
  );

  /**
   * Mark every message from `peerId` as read (`POST /messages/read`) and
   * locally zero out that conversation's unread badge without waiting for a
   * refetch.
   *
   * @param {string} peerId
   */
  const markConversationRead = useCallback(
    /** @param {string} peerId */
    async (peerId: string) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId) return;
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.((/** @type {string} */ sid: string) => ({
          url: `${trimmedUrl}${API_ROUTES.MESSAGES_READ}`,
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, peerId: trimmedPeerId }),
          },
        }));
        if (!response?.ok) return;
        setConversations(prev =>
          prev.map(c => (c.peerId === trimmedPeerId ? { ...c, unreadCount: 0 } : c)),
        );
      } catch (error) {
        logWarn('[Messaging] markConversationRead failed', {
          message: errorMessage(error),
        });
      }
    },
    [authedFetchRef, signalingUrl],
  );

  /**
   * Search the authenticated user's message history
   * (`GET /messages/search`).  Returns the matching messages, newest first,
   * each carrying the `peerId` of the conversation it belongs to so a result
   * can deep-link into that conversation.  Returns an empty array when the
   * request fails, so an unreachable server degrades to local-only results
   * rather than an error.
   *
   * @param {string} query
   * @param {{ limit?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<Array<object>>}
   */
  const searchMessages = useCallback(
    /**
     * @param {string} query
     * @param {{ limit?: number, signal?: AbortSignal }} [options]
     */
    async (query: string, { limit = 20, signal }: { limit?: number; signal?: AbortSignal; } = {}) => {
      const term = (query ?? '').trim();
      const sessionId = sessionIdRef.current;
      if (!term || !sessionId) return [];
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.((/** @type {string} */ sid: string) => {
          const params = new URLSearchParams({
            sessionId: sid,
            q: term,
            limit: String(limit),
          });
          return {
            url: `${trimmedUrl}${API_ROUTES.MESSAGES_SEARCH}?${params.toString()}`,
            options: signal ? { signal } : undefined,
          };
        });
        if (!response?.ok) return [];
        const data = await response.json();
        return Array.isArray(data.results) ? data.results : [];
      } catch (error) {
        // An aborted request is the expected outcome of a newer keystroke, not
        // a failure worth logging.
        if (!(error instanceof Error) || error.name !== 'AbortError') {
          logWarn('[Messaging] searchMessages failed', { message: errorMessage(error) });
        }
        return [];
      }
    },
    [authedFetchRef, sessionIdRef, signalingUrl],
  );

  /**
   * Update one local message in `peerId`'s history, by id.
   *
   * @param {string} peerId
   * @param {string} messageId
   * @param {(message: ChatMessage) => ChatMessage} update
   */
  const patchMessage = useCallback(
    /**
     * @param {string} peerId
     * @param {string} messageId
     * @param {(message: ChatMessage) => ChatMessage} update
     */
    (peerId: string, messageId: string, update: (message: ChatMessage) => ChatMessage) => {
    setMessagesByPeer(prev => {
      const existing = prev[peerId];
      if (!existing) return prev;
      let changed = false;
      const next = existing.map(entry => {
        if (entry.messageId !== messageId) return entry;
        changed = true;
        return update(entry);
      });
      return changed ? { ...prev, [peerId]: next } : prev;
    });
  }, []);

  /**
   * Replace the outbox and mirror it into the local store, so a queued send
   * outlives the process that composed it.
   *
   * @param {OutboxItem[]} next
   */
  const persistOutbox = useCallback(/** @param {OutboxItem[]} next */ (next: OutboxItem[]) => {
    outboxRef.current = next;
    setPendingSendCount(next.length);
    saveChatSnapshot({ outbox: next });
  }, []);

  /** Schedule the next drain with bounded exponential backoff plus jitter. */
  const scheduleDrain = useCallback(() => {
    if (drainTimerRef.current) return;
    const attempt = drainAttemptRef.current;
    drainAttemptRef.current = attempt + 1;
    const ceiling = Math.min(OUTBOX_BASE_RETRY_MS * 2 ** attempt, OUTBOX_MAX_RETRY_MS);
    // Jitter across the second half of the window so many clients coming back
    // online together don't retry in lockstep.
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    drainTimerRef.current = setTimeout(() => {
      drainTimerRef.current = null;
      drainOutboxRef.current();
    }, delay);
  }, []);

  /**
   * Attempt one queued send.  Resolves to whether the message is now the
   * server's problem rather than ours.
   *
   * @param {OutboxItem} item outbox row
   * @returns {Promise<boolean>}
   */
  const sendOutboxItem = useCallback(
    /** @param {OutboxItem} item */
    async (item: OutboxItem) => {
      const signaling = signalingRef?.current;
      if (!signaling || !socketRef.current?.connected) return false;

      try {
        const ack = await signaling.request(CLIENT_EVENTS.MESSAGE_SEND, {
          version: SIGNALING_VERSION,
          recipientId: item.recipientId,
          body: item.body,
          // Rich fields ride along with the queued send, so an attachment
          // composed offline is replayed exactly like a text message.
          ...(item.type && item.type !== MESSAGE_TYPES.TEXT ? { type: item.type } : {}),
          ...(item.attachment ? { attachment: item.attachment } : {}),
          ...(item.replyTo ? { replyTo: item.replyTo } : {}),
          // The server upserts on this id, so a replay of this exact send
          // resolves to the same message instead of a duplicate.
          messageId: item.messageId,
        });
        const confirmed = (ack as { message?: ChatMessage } | undefined)?.message;
        patchMessage(item.recipientId, item.messageId, entry => ({
          ...entry,
          ...(confirmed ?? {}),
          pending: false,
          failed: false,
          syncState: 'synced',
        }));
        persistOutbox(outboxRef.current.filter(queued => queued.messageId !== item.messageId));
        return true;
      } catch (error) {
        logWarn('[Messaging] sendMessage failed', { message: errorMessage(error) });
        const attempts = (item.attempts ?? 0) + 1;
        persistOutbox(
          outboxRef.current.map(queued =>
            queued.messageId === item.messageId
              ? {
                  ...queued,
                  attempts,
                  lastAttemptAt: new Date().toISOString(),
                  lastError: errorMessage(error) ?? null,
                }
              : queued,
          ),
        );
        if (attempts >= OUTBOX_MAX_ATTEMPTS) {
          // Out of automatic retries: surface it so the user can retry or
          // delete the message explicitly.
          patchMessage(item.recipientId, item.messageId, entry => ({
            ...entry,
            pending: false,
            failed: true,
            syncState: 'failed',
          }));
          updateStatus('Message failed to send', 'error');
        }
        return false;
      }
    },
    [patchMessage, persistOutbox, signalingRef, socketRef, updateStatus],
  );

  /**
   * Flush the durable outbox, oldest first.  A no-op while offline (the queue
   * is simply left for the next connect) and re-armed with backoff whenever a
   * send does not get through.
   *
   * @returns {Promise<void>}
   */
  const drainOutbox = useCallback(async () => {
    if (isDrainingRef.current) return;
    const queue = outboxRef.current.filter(isRetryable);
    if (!queue.length) return;
    if (!socketRef.current?.connected || !signalingRef?.current) {
      scheduleDrain();
      return;
    }

    isDrainingRef.current = true;
    let allSent = true;
    try {
      for (const item of [...queue].sort(byOldestFirst)) {
        // Stop at the first failure so queued messages keep their order.
          const sent = await sendOutboxItem(item);
        if (!sent) {
          allSent = false;
          break;
        }
      }
    } finally {
      isDrainingRef.current = false;
    }

    if (allSent) {
      drainAttemptRef.current = 0;
    } else if (outboxRef.current.some(isRetryable)) {
      scheduleDrain();
    }
  }, [scheduleDrain, sendOutboxItem, signalingRef, socketRef]);

  useEffect(() => {
    drainOutboxRef.current = drainOutbox;
  }, [drainOutbox]);

  // Drain on foreground: a send queued while the app was backgrounded (or
  // before it was killed) goes out as soon as the user comes back.
  useEffect(() => {
    const subscription = AppState.addEventListener?.('change', nextState => {
      if (nextState !== 'active') return;
      drainAttemptRef.current = 0;
      drainOutboxRef.current();
    });
    return () => subscription?.remove?.();
  }, []);

  useEffect(
    () => () => {
      clearTimeout(drainTimerRef.current ?? undefined);
      drainTimerRef.current = null;
    },
    [],
  );

  /**
   * Send a chat message to `peerId`.
   *
   * The message is written to the local history (as `pending`) and to the
   * durable outbox *before* anything is emitted, so it is never lost to a dead
   * socket or a killed process: whatever is still queued is replayed on the
   * next connect, foreground, or launch.
   *
   * @param {string} peerId
   * @param {string} body
   * @param {{ type?: string, attachment?: object|null, replyTo?: string|null }} [options]
   *   Rich-message fields. An attachment message (`image`/`file`/`voice`) may
   *   have an empty body: the caption is optional, the attachment is the
   *   content. `attachment.url` must be an already-uploaded `/chatblobs` URL —
   *   the upload itself happens before the send, so a queued attachment
   *   message is just another durable outbox entry.
   */
  const sendMessage = useCallback(
    /**
     * @param {string} peerId
     * @param {string} body
     * @param {{ type?: string, attachment?: import('../../../shared/signaling/schemas').AttachmentRecord|null, replyTo?: string|null }} [options]
     */
    async (peerId: string, body: string, options: { type?: string; attachment?: import('../../../shared/signaling/schemas').AttachmentRecord | null; replyTo?: string | null; } = {}) => {
      const trimmedPeerId = (peerId ?? '').trim();
      const trimmedBody = (body ?? '').trim();
      const type = options.type ?? MESSAGE_TYPES.TEXT;
      const attachment = isAttachmentMessageType(type) ? (options.attachment ?? null) : null;
      const replyTo = options.replyTo ?? null;
      if (!trimmedPeerId) return;
      // Text needs words; an attachment message needs an attachment.
      if (attachment ? !attachment.url : !trimmedBody) return;

      const messageId = createMessageId();
      const createdAt = new Date().toISOString();
      const conversationId =
        conversationsRef.current.find(c => c.peerId === trimmedPeerId)?.conversationId ?? null;
      /** @type {ChatMessage} */
      const optimisticMessage: ChatMessage = {
        messageId,
        conversationId,
        senderId: userId,
        recipientId: trimmedPeerId,
        body: trimmedBody,
        type,
        attachment,
        replyTo,
        reactions: {},
        deletedAt: null,
        createdAt,
        deliveredTo: [],
        readAt: null,
        pending: true,
        syncState: 'pending',
      };

      setMessagesByPeer(prev => ({
        ...prev,
        [trimmedPeerId]: [optimisticMessage, ...(prev[trimmedPeerId] ?? [])],
      }));
      persistOutbox([
        ...outboxRef.current,
        {
          messageId,
          conversationId,
          recipientId: trimmedPeerId,
          body: trimmedBody,
          type,
          attachment,
          replyTo,
          createdAt,
          attempts: 0,
          lastAttemptAt: null,
          lastError: null,
        },
      ]);

      await drainOutbox();
    },
    [drainOutbox, persistOutbox, userId],
  );

  /**
   * Re-queue a message whose automatic retries were exhausted, putting it back
   * into `pending` and draining immediately.
   *
   * @param {string} peerId
   * @param {string} messageId
   */
  const retryMessage = useCallback(
    /**
     * @param {string} peerId
     * @param {string} messageId
     */
    async (peerId: string, messageId: string) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !messageId) return;

      const queued = outboxRef.current.find(item => item.messageId === messageId);
      const next = queued
        ? outboxRef.current.map(item =>
            item.messageId === messageId ? { ...item, attempts: 0, lastError: null } : item,
          )
        : outboxRef.current;
      persistOutbox(next);
      if (!queued) return;

      patchMessage(trimmedPeerId, messageId, entry => ({
        ...entry,
        pending: true,
        failed: false,
        syncState: 'pending',
      }));
      drainAttemptRef.current = 0;
      clearTimeout(drainTimerRef.current ?? undefined);
      drainTimerRef.current = null;
      await drainOutbox();
    },
    [drainOutbox, patchMessage, persistOutbox],
  );

  /**
   * Remove one message from the local history, wherever it lives.
   *
   * @param {string} peerId
   * @param {string} messageId
   */
  const removeMessageLocally = useCallback(
    /**
     * @param {string} peerId
     * @param {string} messageId
     */
    (peerId: string, messageId: string) => {
    setMessagesByPeer(prev => {
      const existing = prev[peerId];
      if (!existing) return prev;
      const next = existing.filter(m => m.messageId !== messageId);
      return next.length === existing.length ? prev : { ...prev, [peerId]: next };
    });
  }, []);

  /**
   * Drop a message that never made it to the server: it leaves both the local
   * history and the outbox, so it is never replayed.
   *
   * @param {string} peerId
   * @param {string} messageId
   */
  const discardMessage = useCallback(
    /**
     * @param {string} peerId
     * @param {string} messageId
     */
    (peerId: string, messageId: string) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !messageId) return;
      persistOutbox(outboxRef.current.filter(item => item.messageId !== messageId));
      removeMessageLocally(trimmedPeerId, messageId);
    },
    [persistOutbox, removeMessageLocally],
  );

  /**
   * Delete a message the local user sent.  Unsent messages (still in the
   * outbox) are simply discarded locally; a message the server already stored
   * is deleted there too, so it disappears for the recipient as well.
   *
   * @param {string} peerId
   * @param {string} messageId
   * @returns {Promise<boolean>} whether the message is gone
   */
  const deleteMessage = useCallback(
    /**
     * @param {string} peerId
     * @param {string} messageId
     */
    async (peerId: string, messageId: string) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !messageId) return false;

      // Never delivered: nothing on the server to delete.
      if (outboxRef.current.some(item => item.messageId === messageId)) {
        discardMessage(trimmedPeerId, messageId);
        return true;
      }

      const signaling = signalingRef?.current;
      if (!signaling || !socketRef.current?.connected) {
        updateStatus('Cannot delete while offline', 'error');
        return false;
      }

      try {
        await signaling.request(CLIENT_EVENTS.MESSAGE_DELETE, {
          version: SIGNALING_VERSION,
          peerId: trimmedPeerId,
          messageId,
        });
      } catch (error) {
        logWarn('[Messaging] deleteMessage failed', { message: errorMessage(error) });
        updateStatus('Could not delete message', 'error');
        return false;
      }

      // Delete for everyone leaves a tombstone rather than a hole, matching
      // what the server stored and what the peer is about to be told.
      patchMessage(trimmedPeerId, messageId, entry => ({ ...entry, ...tombstoneOf(entry) }));
      return true;
    },
    [discardMessage, patchMessage, signalingRef, socketRef, updateStatus],
  );

  /**
   * Notify `peerId` that the local user is (or has stopped) typing  /**
   * Notify `peerId` that the local user is (or has stopped) typing in their
   * conversation, via the ephemeral `message.typing` socket event. Silently a
   * no-op when there is no connected socket — typing indicators are a
   * best-effort UI nicety, never worth surfacing an error for.
   *
   * Emits are throttled to at most once per {@link TYPING_INDICATOR_THROTTLE_MS}
   * per peer while `isTyping` stays true, so a fast typist doesn't flood the
   * socket; the final `isTyping: false` (composer cleared/blurred) always
   * goes out immediately so the peer's indicator doesn't linger.
   *
   * @param {string} peerId
   * @param {boolean} isTyping
   */
  const sendTypingIndicator = useCallback(
    /**
     * @param {string} peerId
     * @param {boolean} isTyping
     */
    (peerId: string, isTyping: boolean) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId) return;
      const signaling = signalingRef?.current;
      if (!signaling || !socketRef.current?.connected) return;

      const now = Date.now();
      if (isTyping) {
        const lastSentAt = typingSentAtRef.current[trimmedPeerId] ?? 0;
        if (now - lastSentAt < TYPING_INDICATOR_THROTTLE_MS) return;
      }
      typingSentAtRef.current[trimmedPeerId] = now;

      signaling.emit(CLIENT_EVENTS.MESSAGE_TYPING, {
        version: SIGNALING_VERSION,
        recipientId: trimmedPeerId,
        isTyping: Boolean(isTyping),
      });
    },
    [signalingRef, socketRef],
  );

  /** Sum of unreadCount across every conversation; drives the tab badge. */
  const unreadTotal = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0),
    [conversations],
  );

  /**
   * Clear all pending typing-indicator safety-net timers. Called when the
   * socket is torn down so a reconnect doesn't fire stale timeouts.
   */
  const resetTypingState = useCallback(() => {
    Object.values(typingTimeoutsRef.current).forEach(clearTimeout);
    typingTimeoutsRef.current = {};
  }, []);

  // ─── Socket-event adapters ────────────────────────────────────────────────
  // These encapsulate exactly how each raw `message.*` socket event mutates
  // this hook's state, so `useCallFlow`'s socket handlers stay thin.

  const handleMessageReceived = useCallback(
      (message: ChatMessage) => {
      if (!message?.senderId) return;
      const senderId = message.senderId;

      // The same message can also arrive as a push; record it so the push
      // handler does not post a notification for a message already delivered
      // here.
      markMessageSeen(message.messageId);

      setMessagesByPeer(prev => {
        const existing = prev[senderId] ?? [];
        // Dedupe by id, so a message that arrives over both the socket and a
        // background push converges on one entry.
        if (existing.some(m => m.messageId === message.messageId)) {
          return prev;
        }
        return { ...prev, [senderId]: [{ ...message, syncState: 'synced' }, ...existing] };
      });

      if (activeChatPeerIdRef.current === senderId) {
        // The conversation is currently open: auto-mark-read, no unread bump,
        // and clear any notification a push already posted for it.
        if (message.conversationId) dismissMessageNotification(message.conversationId);
        markConversationRead(senderId).catch(() => {});
        return;
      }

      setConversations(prev => {
        const index = prev.findIndex(c => c.peerId === senderId);
        if (index === -1) {
          // Brand-new conversation: refetch the authoritative list.
          fetchConversations();
          return prev;
        }
        const next = [...prev];
        next[index] = {
          ...next[index],
          lastMessage: message,
          lastActivity: { ...message, type: 'text' },
          unreadCount: (next[index].unreadCount || 0) + 1,
        };
        return next;
      });
    },
    [fetchConversations, markConversationRead],
  );

  const handleMessageDelivered = useCallback(/** @param {ChatMessage} message */ (message: ChatMessage) => {
    if (!message?.recipientId) return;
    const peerId = message.recipientId;
    setMessagesByPeer(prev => {
      const existing = prev[peerId] ?? [];
      const index = existing.findIndex(m => m.messageId === message.messageId);
      if (index === -1) {
        return { ...prev, [peerId]: [message, ...existing] };
      }
      // Already held (the send ack raced ahead of this event): merge the
      // server's copy in so the delivery receipt (`deliveredTo`) flips the
      // message's status tick from "sent" to "delivered".
      const next = [...existing];
      next[index] = { ...next[index], ...message };
      return { ...prev, [peerId]: next };
    });
  }, []);

  const handleMessageRead = useCallback(
    /** @param {{ readerId?: string, readAt?: string }} payload */
    ({ readerId, readAt }: { readerId?: string; readAt?: string; }) => {
      if (!readerId) return;
      // `readerId` is the peer who just read our messages; messagesByPeer
      // is keyed by the other participant regardless of send direction, so
      // it doubles as the lookup key here.
      setMessagesByPeer(prev => {
        const existing = prev[readerId];
        if (!existing) return prev;
        let changed = false;
        const updated = existing.map(m => {
          if (m.senderId === userId && !m.readAt) {
            changed = true;
            return { ...m, readAt: readAt ?? new Date().toISOString() };
          }
          return m;
        });
        return changed ? { ...prev, [readerId]: updated } : prev;
      });
    },
    [userId],
  );

  const handleTypingEvent = useCallback(
    /** @param {{ senderId?: string, isTyping?: boolean }} payload */
    ({ senderId, isTyping }: { senderId?: string; isTyping?: boolean; }) => {
    if (!senderId) return;
      clearTimeout(typingTimeoutsRef.current[senderId]);
      setTypingByPeer(prev => ({ ...prev, [senderId]: Boolean(isTyping) }));
      if (isTyping) {
        // Safety net: auto-clear if a "stopped typing" event never arrives.
        typingTimeoutsRef.current[senderId] = setTimeout(() => {
          setTypingByPeer(prev => ({ ...prev, [senderId]: false }));
        }, TYPING_INDICATOR_TIMEOUT_MS);
      }
    },
    [],
  );

  /**
   * A participant deleted a message: replace it with the server's tombstone so
   * both sides converge on "Message deleted" rather than on a hole — a reply
   * that quotes the message must still resolve to something.
   *
   * @param {{ conversationId?: string, messageId?: string, deletedBy?: string,
   *   message?: Partial<ChatMessage>|null }} payload
   */
  const handleMessageDeleted = useCallback(
    (payload: {
      conversationId?: string;
      messageId?: string;
      deletedBy?: string;
      message?: Partial<ChatMessage> | null;
    }) => {
    const messageId = payload?.messageId;
    if (!messageId) return;
      setMessagesByPeer(prev => {
        let changed = false;
        /** @type {Record<string, ChatMessage[]>} */
        const next: Record<string, ChatMessage[]> = {};
        Object.entries(prev).forEach(([peerId, messages]) => {
          next[peerId] = messages.map(m => {
            if (m.messageId !== messageId) return m;
            changed = true;
            return { ...m, ...tombstoneOf(m, payload?.message ?? undefined) };
          });
        });
        return changed ? next : prev;
      });
    },
    [],
  );

  /**
   * A reaction was added or removed on a message in one of the user's
   * conversations, by either participant — including this user on another
   * device, which is what makes the local optimistic update converge.
   *
   * @param {{ messageId?: string, reactions?: Record<string, string[]> }} payload
   */
  const handleMessageReaction = useCallback(
    (payload: { messageId?: string; reactions?: Record<string, string[]> }) => {
    const messageId = payload?.messageId;
    if (!messageId) return;
      const reactions = payload?.reactions ?? {};
      setMessagesByPeer(prev => {
        let changed = false;
        /** @type {Record<string, ChatMessage[]>} */
        const next: Record<string, ChatMessage[]> = {};
        Object.entries(prev).forEach(([peerId, messages]) => {
          next[peerId] = messages.map(m => {
            if (m.messageId !== messageId) return m;
            changed = true;
            return { ...m, reactions };
          });
        });
        return changed ? next : prev;
      });
    },
    [],
  );

  /**
   * Add or remove one of the local user's emoji reactions on a message.
   *
   * The server is authoritative: the reaction set in its acknowledgement (and
   * in the `message.reaction` fan-out that reaches every other device) is what
   * the UI ends up rendering, so a lost ack cannot leave the devices disagreeing.
   *
   * @param {string} peerId
   * @param {string} messageId
   * @param {string} emoji
   * @param {'add'|'remove'} action
   * @returns {Promise<boolean>} whether the reaction was stored
   */
  const reactToMessage = useCallback(
    /**
     * @param {string} peerId
     * @param {string} messageId
     * @param {string} emoji
     * @param {'add'|'remove'} action
     */
    async (peerId: string, messageId: string, emoji: string, action: 'add' | 'remove') => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !messageId || !emoji) return false;

      const signaling = signalingRef?.current;
      if (!signaling || !socketRef.current?.connected) {
        updateStatus('Cannot react while offline', 'error');
        return false;
      }

      try {
        const ack = await signaling.request(CLIENT_EVENTS.MESSAGE_REACT, {
          version: SIGNALING_VERSION,
          peerId: trimmedPeerId,
          messageId,
          emoji,
          action,
        });
        const reactions =
          (ack as { reactions?: Record<string, string[]> } | undefined)?.reactions ?? {};
        handleMessageReaction({ messageId, reactions });
        return true;
      } catch (error) {
        logWarn('[Messaging] reactToMessage failed', { message: errorMessage(error) });
        updateStatus('Could not react to message', 'error');
        return false;
      }
    },
    [handleMessageReaction, signalingRef, socketRef, updateStatus],
  );

  /**
   * The socket came up: connectivity is restored, so reset the backoff and
   * flush anything the outbox still holds.
   */
  const handleSocketConnected = useCallback(() => {
    setIsSocketConnected(true);
    drainAttemptRef.current = 0;
    clearTimeout(drainTimerRef.current ?? undefined);
    drainTimerRef.current = null;
    drainOutboxRef.current();
  }, []);

  /** The socket went down: drive the offline banner. */
  const handleSocketDisconnected = useCallback(() => {
    setIsSocketConnected(false);
  }, []);

  return {
    conversations,
    messagesByPeer,
    activeChatPeerId,
    setActiveChatPeerId,
    typingByPeer,
    unreadTotal,
    // Only reported once the socket has told us either way, so the banner
    // never flashes during the first connect.
    isOffline: isSocketConnected === false,
    pendingSendCount,
    fetchConversations,
    fetchMessagesForPeer,
    searchMessages,
    sendMessage,
    retryMessage,
    discardMessage,
    deleteMessage,
    drainOutbox,
    markConversationRead,
    sendTypingIndicator,
    reactToMessage,
    resetTypingState,
    handleMessageReceived,
    handleMessageDeleted,
    handleMessageReaction,
    handleMessageDelivered,
    handleMessageRead,
    handleTypingEvent,
    handleSocketConnected,
    handleSocketDisconnected,
  };
}
