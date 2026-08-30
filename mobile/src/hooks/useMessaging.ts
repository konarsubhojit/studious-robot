import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { logWarn } from '../appLogger';
import { triggerHapticUnlessSilent } from '../haptics';
import {
  dismissMessageNotification,
  markMessageSeen,
  setActiveConversation,
} from '../messageNotification';
import { saveChatSnapshot } from '../storage/chatDb';
import type { ChatDraft, ChatSnapshot } from '../storage/chatDb';
import { API_ROUTES, MESSAGE_TYPES, isAttachmentMessageType } from '../../../shared';
import { CLIENT_EVENTS } from '../signalingClient';
import { SIGNALING_VERSION } from '../socketProtocol';
import {
  conversationIdForPeer,
  totalUnread,
  withConversationRead,
  withIncomingMessage,
} from '../messaging/conversations';
import { withDraft, withoutDraft } from '../messaging/drafts';
import {
  mergeHistoryPage,
  patchMessage as patchMessageIn,
  prependMessage,
  removeMessage,
} from '../messaging/messageHistory';
import { createMessageId } from '../messaging/messageIdentity';
import {
  applyDeliveryReceipt,
  applyIncomingMessage,
  applyReactions,
  applyReadReceipt,
  applyTombstone,
  tombstoneOf,
} from '../messaging/receivePipeline';
import {
  OUTBOX_MAX_ATTEMPTS,
  asFailed,
  asQueued,
  asSent,
  asUploadFailed,
  asUploaded,
  buildOptimisticMessage,
  buildOutboxItem,
  buildUploadingMessage,
  drainOrder,
  isRetryable,
  nextDrainDelayMs,
  withAttemptRecorded,
  withAttemptsReset,
  withUploadProgress,
  withoutMessage,
} from '../messaging/sendPipeline';
import useChatSnapshotMirror from '../messaging/useChatSnapshotMirror';
import type { AttachmentRecord } from '../../../shared/signaling/schemas';
import type { CallStatus } from '../components/StatusBanner';
import type { SignalingClient } from '../signalingClient';
import type { Socket } from 'socket.io-client';
import { errorMessage } from '../errors';

/**
 * The messaging vocabulary lives in `../messaging/types`, so the pure modules
 * below can be imported without React or the socket layer. It is re-exported
 * here because that is where the rest of the app has always imported it from.
 */
export type {
  CallActivity,
  ChatMessage,
  ConversationActivity,
  ConversationSummary,
  OutboxItem,
} from '../messaging/types';
export { OUTBOX_MAX_ATTEMPTS } from '../messaging/sendPipeline';

import type { ChatMessage, ConversationSummary, OutboxItem } from '../messaging/types';
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
 * @param params
 */
export type UseMessagingParams = {
  authedFetchRef: { current: Function | null; };
  sessionIdRef: { current: string | null; };
  signalingUrl: string;
  signalingRef: { current: SignalingClient | null; };
  socketRef: { current: Socket | null; };
  userId: string;
  updateStatus: (message: string, severity?: CallStatus['severity']) => void;
};

export default function useMessaging({
  authedFetchRef,
  sessionIdRef,
  signalingRef,
  signalingUrl,
  socketRef,
  userId,
  updateStatus,
}: UseMessagingParams) {
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
  // Keyed by peerId → the composer text (and reply target) the user has typed
  // but not sent. Held here rather than in the composer's own state so it
  // survives switching conversations, backgrounding and process death.
  const [drafts, setDrafts] = useState(({} as Record<string, ChatDraft>));
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
  const attachmentUploadMetaRef = useRef(({} as Record<string, { conversationId?: string | null; createdAt: string; }>));
  const conversationsRef = useRef(([] as ConversationSummary[]));

  useEffect(() => {
    activeChatPeerIdRef.current = activeChatPeerId;
  }, [activeChatPeerId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // ─── Hydrate-then-fetch ──────────────────────────────────────────────────
  // Render whatever was cached locally straight away, then let the network
  // refresh it. The mirror back into the local store — trailing-debounced and
  // force-flushed on background and unmount — lives in the same module.
  const applySnapshot = useCallback((snapshot: ChatSnapshot) => {
    outboxRef.current = snapshot.outbox;
    setPendingSendCount(snapshot.outbox.length);
    // Only fill in what the network hasn't already provided: a response that
    // beat the disk read is newer than the cache.
    setConversations(prev => (prev.length ? prev : snapshot.conversations));
    setMessagesByPeer(prev => ({ ...snapshot.messagesByPeer, ...prev }));
    // Drafts only ever come from disk: nothing else can have typed for the
    // user between mount and here.
    setDrafts(snapshot.drafts ?? {});
    // Anything still queued from a previous run goes out as soon as the socket
    // allows it — this is what makes a force-quit mid-send safe.
    if (snapshot.outbox.some(isRetryable)) drainOutboxRef.current();
  }, []);

  useChatSnapshotMirror({
    conversations,
    messagesByPeer,
    drafts,
    onHydrate: applySnapshot,
  });

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
      const response = await authedFetchRef.current?.((sid: string) => ({
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
   * @returns the fetched page (empty on failure)
   */
  const fetchMessagesForPeer = useCallback(
    async (peerId: string, { before }: { before?: string; } = {}) => {
      const trimmedPeerId = (peerId ?? '').trim();
      const sessionId = sessionIdRef.current;
      if (!sessionId || !trimmedPeerId) return [];
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.((sid: string) => {
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
        setMessagesByPeer(prev => ({
          ...prev,
          [trimmedPeerId]: mergeHistoryPage(prev[trimmedPeerId] ?? [], messages, { before }),
        }));
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
   */
  const markConversationRead = useCallback(
    /** @param peerId */
    async (peerId: string) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId) return;
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.((sid: string) => ({
          url: `${trimmedUrl}${API_ROUTES.MESSAGES_READ}`,
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, peerId: trimmedPeerId }),
          },
        }));
        if (!response?.ok) return;
        setConversations(prev => withConversationRead(prev, trimmedPeerId));
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
   */
  const searchMessages = useCallback(
    async (query: string, { limit = 20, signal }: { limit?: number; signal?: AbortSignal; } = {}) => {
      const term = (query ?? '').trim();
      const sessionId = sessionIdRef.current;
      if (!term || !sessionId) return [];
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.((sid: string) => {
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
   */
  const patchMessage = useCallback(
    (peerId: string, messageId: string, update: (message: ChatMessage) => ChatMessage) => {
      setMessagesByPeer(prev => patchMessageIn(prev, peerId, messageId, update));
    },
    [],
  );

  /**
   * Replace the outbox and mirror it into the local store, so a queued send
   * outlives the process that composed it.
   */
  const persistOutbox = useCallback(/** @param next */ (next: OutboxItem[]) => {
    outboxRef.current = next;
    setPendingSendCount(next.length);
    saveChatSnapshot({ outbox: next });
  }, []);

  /** Schedule the next drain with bounded exponential backoff plus jitter. */
  const scheduleDrain = useCallback(() => {
    if (drainTimerRef.current) return;
    const attempt = drainAttemptRef.current;
    drainAttemptRef.current = attempt + 1;
    drainTimerRef.current = setTimeout(() => {
      drainTimerRef.current = null;
      drainOutboxRef.current();
    }, nextDrainDelayMs(attempt));
  }, []);

  /**
   * Attempt one queued send.  Resolves to whether the message is now the
   * server's problem rather than ours.
   *
   * @param item outbox row
   */
  const sendOutboxItem = useCallback(
    /** @param item */
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
        patchMessage(item.recipientId, item.messageId, entry => asSent(entry, confirmed));
        persistOutbox(withoutMessage(outboxRef.current, item.messageId));
        return true;
      } catch (error) {
        logWarn('[Messaging] sendMessage failed', { message: errorMessage(error) });
        const attempts = (item.attempts ?? 0) + 1;
        persistOutbox(
          withAttemptRecorded(outboxRef.current, item.messageId, {
            attempts,
            lastAttemptAt: new Date().toISOString(),
            lastError: errorMessage(error) ?? null,
          }),
        );
        if (attempts >= OUTBOX_MAX_ATTEMPTS) {
          // Out of automatic retries: surface it so the user can retry or
          // delete the message explicitly.
          patchMessage(item.recipientId, item.messageId, asFailed);
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
   */
  const drainOutbox = useCallback(async () => {
    if (isDrainingRef.current) return;
    const queue = drainOrder(outboxRef.current);
    if (!queue.length) return;
    if (!socketRef.current?.connected || !signalingRef?.current) {
      scheduleDrain();
      return;
    }

    isDrainingRef.current = true;
    let allSent = true;
    try {
      for (const item of queue) {
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
      // The message the user just sent is now the server's problem, and they
      // are told without having to look at the screen. Only a single-item
      // drain buzzes: a reconnect that replays a backlog would otherwise
      // rattle once per queued message, which is noise, not feedback.
      if (queue.length === 1) {
        triggerHapticUnlessSilent('messageSent');
      }
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
   *   Rich-message fields. An attachment message (`image`/`file`/`voice`) may
   *   have an empty body: the caption is optional, the attachment is the
   *   content. `attachment.url` must be an already-uploaded `/chatblobs` URL —
   *   the upload itself happens before the send, so a queued attachment
   *   message is just another durable outbox entry.
   */
  const sendMessage = useCallback(
    async (peerId: string, body: string, options: { type?: string; attachment?: AttachmentRecord | null; replyTo?: string | null; } = {}) => {
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
      const conversationId = conversationIdForPeer(conversationsRef.current, trimmedPeerId);
      const draft = {
        messageId,
        conversationId,
        senderId: userId,
        recipientId: trimmedPeerId,
        createdAt,
        body: trimmedBody,
        type,
        attachment,
        replyTo,
      };

      setMessagesByPeer(prev =>
        prependMessage(prev, trimmedPeerId, buildOptimisticMessage(draft)),
      );
      persistOutbox([...outboxRef.current, buildOutboxItem(draft)]);

      await drainOutbox();
    },
    [drainOutbox, persistOutbox, userId],
  );

  const beginAttachmentUpload = useCallback(
    (peerId: string, type: string, attachment: Partial<AttachmentRecord> | null) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !isAttachmentMessageType(type) || !attachment?.url) return null;

      const messageId = createMessageId();
      const createdAt = new Date().toISOString();
      const conversationId = conversationIdForPeer(conversationsRef.current, trimmedPeerId);
      const optimisticMessage = buildUploadingMessage({
        messageId,
        conversationId,
        senderId: userId,
        recipientId: trimmedPeerId,
        createdAt,
        type,
        attachment: attachment as AttachmentRecord,
      });

      setMessagesByPeer(prev => prependMessage(prev, trimmedPeerId, optimisticMessage));
      attachmentUploadMetaRef.current[messageId] = { conversationId, createdAt };
      return messageId;
    },
    [userId],
  );

  const updateAttachmentUploadProgress = useCallback(
    (peerId: string, messageId: string, progress: number) => {
      patchMessage(peerId, messageId, entry => withUploadProgress(entry, progress));
    },
    [patchMessage],
  );

  const finishAttachmentUpload = useCallback(
    async (peerId: string, messageId: string, type: string, attachment: AttachmentRecord) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !messageId || !attachment?.url) return;
      const meta = attachmentUploadMetaRef.current[messageId];
      const conversationId =
        meta?.conversationId ?? conversationIdForPeer(conversationsRef.current, trimmedPeerId);
      const createdAt = meta?.createdAt ?? new Date().toISOString();

      patchMessage(trimmedPeerId, messageId, entry => asUploaded(entry, attachment));

      const nextItem = buildOutboxItem({
        messageId,
        conversationId,
        recipientId: trimmedPeerId,
        createdAt,
        type,
        attachment,
      });
      // Replayed under the original message identity, so a retry can never
      // duplicate the send it is retrying.
      persistOutbox([...withoutMessage(outboxRef.current, messageId), nextItem]);
      delete attachmentUploadMetaRef.current[messageId];
      await drainOutbox();
    },
    [drainOutbox, patchMessage, persistOutbox],
  );

  const failAttachmentUpload = useCallback(
    (peerId: string, messageId: string, error: string | null = null) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !messageId) return;
      persistOutbox(withoutMessage(outboxRef.current, messageId));
      delete attachmentUploadMetaRef.current[messageId];
      // The bubble stays, in a failed state: a cancelled or failed upload must
      // never silently vanish.
      patchMessage(trimmedPeerId, messageId, entry => asUploadFailed(entry, error));
    },
    [patchMessage, persistOutbox],
  );

  /**
   * Re-queue a message whose automatic retries were exhausted, putting it back
   * into `pending` and draining immediately.
   */
  const retryMessage = useCallback(
    async (peerId: string, messageId: string) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !messageId) return;

      const queued = outboxRef.current.some(item => item.messageId === messageId);
      // The retry keeps the original message identity, so a late-succeeding
      // original send cannot land alongside it as a duplicate.
      persistOutbox(queued ? withAttemptsReset(outboxRef.current, messageId) : outboxRef.current);
      if (!queued) return;

      patchMessage(trimmedPeerId, messageId, asQueued);
      drainAttemptRef.current = 0;
      clearTimeout(drainTimerRef.current ?? undefined);
      drainTimerRef.current = null;
      await drainOutbox();
    },
    [drainOutbox, patchMessage, persistOutbox],
  );

  /**
   * Remove one message from the local history, wherever it lives.
   */
  const removeMessageLocally = useCallback(
    (peerId: string, messageId: string) => {
      setMessagesByPeer(prev => removeMessage(prev, peerId, messageId));
    },
    [],
  );

  /**
   * Drop a message that never made it to the server: it leaves both the local
   * history and the outbox, so it is never replayed.
   */
  const discardMessage = useCallback(
    (peerId: string, messageId: string) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !messageId) return;
      persistOutbox(withoutMessage(outboxRef.current, messageId));
      removeMessageLocally(trimmedPeerId, messageId);
    },
    [persistOutbox, removeMessageLocally],
  );

  /**
   * Delete a message the local user sent.  Unsent messages (still in the
   * outbox) are simply discarded locally; a message the server already stored
   * is deleted there too, so it disappears for the recipient as well.
   *
   * @returns whether the message is gone
   */
  const deleteMessage = useCallback(
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
   */
  const sendTypingIndicator = useCallback(
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
  const unreadTotal = useMemo(() => totalUnread(conversations), [conversations]);

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

      setMessagesByPeer(prev => applyIncomingMessage(prev, message));

      if (activeChatPeerIdRef.current === senderId) {
        // The conversation is currently open: auto-mark-read, no unread bump,
        // and clear any notification a push already posted for it.
        if (message.conversationId) dismissMessageNotification(message.conversationId);
        markConversationRead(senderId).catch(() => {});
        return;
      }

      setConversations(prev => {
        const next = withIncomingMessage(prev, message);
        if (!next) {
          // Brand-new conversation: refetch the authoritative list.
          fetchConversations();
          return prev;
        }
        return next;
      });
    },
    [fetchConversations, markConversationRead],
  );

  const handleMessageDelivered = useCallback(/** @param message */ (message: ChatMessage) => {
    if (!message?.recipientId) return;
    setMessagesByPeer(prev => applyDeliveryReceipt(prev, message));
  }, []);

  const handleMessageRead = useCallback(
    /** @param payload */
    ({ readerId, readAt }: { readerId?: string; readAt?: string; }) => {
      if (!readerId) return;
      setMessagesByPeer(prev =>
        applyReadReceipt(prev, { readerId, readAt, currentUserId: userId }),
      );
    },
    [userId],
  );

  const handleTypingEvent = useCallback(
    /** @param payload */
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
   * @param payload
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
      setMessagesByPeer(prev => applyTombstone(prev, messageId, payload?.message ?? undefined));
    },
    [],
  );

  /**
   * A reaction was added or removed on a message in one of the user's
   * conversations, by either participant — including this user on another
   * device, which is what makes the local optimistic update converge.
   */
  const handleMessageReaction = useCallback(
    (payload: { messageId?: string; reactions?: Record<string, string[]> }) => {
      const messageId = payload?.messageId;
      if (!messageId) return;
      const reactions = payload?.reactions ?? {};
      setMessagesByPeer(prev => applyReactions(prev, messageId, reactions));
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
   * @returns whether the reaction was stored
   */
  const reactToMessage = useCallback(
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

  /**
   * Record (or clear) the unsent composer entry for a conversation.
   *
   * Passing empty text removes the draft outright, so an emptied composer does
   * not leave a phantom "draft" marker in the conversation list.
   */
  const saveDraft = useCallback((peerId: string, text: string, replyToId?: string | null) => {
    if (!peerId) return;
    setDrafts(prev => withDraft(prev, peerId, text, replyToId ?? null));
  }, []);

  /** Drop the draft for a conversation (on send, or when it is emptied). */
  const clearDraft = useCallback((peerId: string) => {
    if (!peerId) return;
    setDrafts(prev => withoutDraft(prev, peerId));
  }, []);

  return {
    conversations,
    messagesByPeer,
    drafts,
    saveDraft,
    clearDraft,
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
    beginAttachmentUpload,
    updateAttachmentUploadProgress,
    finishAttachmentUpload,
    failAttachmentUpload,
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
