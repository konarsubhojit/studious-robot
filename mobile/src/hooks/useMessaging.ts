import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { logWarn } from '../appLogger';
import { evictCachedAttachmentsForMessage } from '../attachmentCache';
import { triggerHapticUnlessSilent } from '../haptics';
import {
  dismissMessageNotification,
  markMessageSeen,
  setActiveConversation,
} from '../messageNotification';
import { flushChatDb, loadChatSnapshot, saveChatSnapshot } from '../storage/chatDb';
import { advanceSocketMessageCursor } from '../messaging/messageSyncCursor';
import { dataScope } from '../storage/localDatabase';
import { RequestCoalescer } from '../storage/requestCoalescer';
import type { ChatDraft, ChatSnapshot } from '../storage/chatDb';
import { API_ROUTES, MESSAGE_TYPES, isAttachmentMessageType } from '../../../shared';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../signalingClient';
import {
  createMockGroup, leaveMockGroup, mutateMockMembers, renameMockGroup, sendMockGroup,
} from '../chat/groupMockAdapter';
import type { GroupMemberAction } from '../chat/groupMockAdapter';
import useGroupCalls from '../chat/useGroupCalls';
import {
  applyGroupSnapshot, conversationAcknowledgement, GROUP_TRANSPORT, parseGroupList, remoteGroupRows,
} from '../chat/groupTransportAdapter';
import type { GroupTransport } from '../chat/groupTransportAdapter';
import { SIGNALING_VERSION } from '../socketProtocol';
import { displayMessageReceivedInApp } from '../pushNotifications';
import {
  conversationIdForPeer,
  mergePendingConversations,
  totalUnread,
  withConversationRead,
  withCallActivity,
  withIncomingMessage,
  withOutgoingMessage,
  withReconciledMessage,
} from '../messaging/conversations';
import { withDraft, withoutDraft } from '../messaging/drafts';
import {
  mergeHistoryPage,
  nextLocalCreatedAt,
  dedupeAndSort,
  patchMessage as patchMessageIn,
  prependMessage,
  removeMessage,
  upsertTimelineEntry,
} from '../messaging/messageHistory';
import { createMessageId, timelineEntryId } from '../messaging/messageIdentity';
import { mergeMessageSearchResults } from '../messaging/messageSearch';
import { resumeMessageBackfill } from '../messaging/messageBackfill';
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
  outboxSendPayload,
  restoreOutboxMessages,
  withAttemptRecorded,
  withAttemptsReset,
  withUploadProgress,
  withoutMessage,
  resolveOutboxReply,
  optimisticReplyKey,
  unavailableReplyReason,
  withResolvedReplies,
  drainQueuedMessages,
} from '../messaging/sendPipeline';
import useChatSnapshotMirror from '../messaging/useChatSnapshotMirror';
import { fetchGroupHistory, fetchHistory } from '../messaging/fetchHistory';
import type { AttachmentRecord, ConversationRecord } from '../../../shared/signaling/schemas';
import type { CallStatus } from '../components/StatusBanner';
import type { SignalingClient } from '../signalingClient';
import type { Socket } from 'socket.io-client';
import { errorMessage } from '../errors';
import { bearerAuthHeaders } from '../authHeaders';

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
  TimelineCursor,
} from '../messaging/types';
export { OUTBOX_MAX_ATTEMPTS } from '../messaging/sendPipeline';

import type { CallActivity, ChatMessage, ConversationSummary, OutboxItem, TimelineCursor } from '../messaging/types';

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
 * Delete any locally cached bytes for a message that has just been
 * tombstoned, whichever side deleted it.
 *
 * The cache is an optimisation, never a second copy of the record: a cached
 * file that outlived its tombstone would let this device open content the
 * sender has already withdrawn. Best-effort, but a failure is logged rather
 * than swallowed — bytes left behind after a deletion is a privacy-relevant
 * condition, not a silent no-op.
 */
function evictTombstonedAttachment(messageId: string) {
  evictCachedAttachmentsForMessage(messageId).catch(error => {
    logWarn('[Messaging] Failed to evict the cached attachment of a deleted message', {
      messageId,
      message: errorMessage(error),
    });
  });
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
 * What is left here is the wiring: React state, the network calls, the socket
 * emits and the effects. Everything that can be decided without mounting a
 * component lives in `../messaging/` and is unit-tested there:
 *
 *   `messageIdentity`         id minting, entry identity and ordering
 *   `messageHistory`          per-peer history transforms, page merging
 *   `sendPipeline`            optimistic sends, outbox bookkeeping, backoff,
 *                             upload and retry state transitions
 *   `receivePipeline`         inbound messages, receipts, tombstones, reactions
 *   `conversations`           the conversation list and unread accounting
 *   `drafts`                  per-conversation composer drafts
 *   `useChatSnapshotMirror`   hydrate-then-fetch and the debounced local mirror
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
  storageUserId?: string;
  groupTransport?: GroupTransport;
  updateStatus: (message: string, severity?: CallStatus['severity']) => void;
};

export default function useMessaging({
  authedFetchRef,
  sessionIdRef,
  signalingRef,
  signalingUrl,
  socketRef,
  userId,
  storageUserId = userId,
  groupTransport = GROUP_TRANSPORT,
  updateStatus,
}: UseMessagingParams) {
  const scope = dataScope(signalingUrl, storageUserId);
  const requests = useMemo(() => new RequestCoalescer(scope), [scope]);
  const [stateScope, setStateScope] = useState(scope);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
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
  const [socketCursors, setSocketCursors] = useState(({} as ChatSnapshot['socketCursors']));
  const [isBackfillingMessages, setIsBackfillingMessages] = useState(false);
  const [backfilledMessageCount, setBackfilledMessageCount] = useState(0);
  const backfillScopeRef = useRef<string | null>(null);
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
  const [groupTyping, setGroupTyping] = useState<Record<string, Record<string, boolean>>>({});
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
  const drainingScopeRef = useRef<string | null>(null);
  const drainOutboxRef = useRef(() => {});
  const attachmentUploadMetaRef = useRef(({} as Record<string, { conversationId?: string | null; createdAt: string; }>));
  const conversationsRef = useRef(([] as ConversationSummary[]));
  const conversationsFetchedRef = useRef(false);
  const messagesByPeerRef = useRef(({} as Record<string, ChatMessage[]>));
  const socketCursorsRef = useRef(({} as ChatSnapshot['socketCursors']));
  const socketCursorScopeRef = useRef(scope);
  const persistChatSnapshotRef = useRef<(snapshot?: Partial<ChatSnapshot>) => boolean>(() => false);
  const lastLocalCreatedAtMsRef = useRef(0);
  const { groupCalls, groupCallActions } = useGroupCalls({
    scope, userId, conversationsRef, signalingRef, socketRef, connected: isSocketConnected,
  });

  useEffect(() => {
    scopeRef.current = scope;
    setStateScope(scope);
    setConversations([]);
    setMessagesByPeer({});
    setSocketCursors({});
    setDrafts({});
    setActiveChatPeerId(null);
    setTypingByPeer({});
    setGroupTyping({});
    setPendingSendCount(0);
    outboxRef.current = [];
    conversationsRef.current = [];
    conversationsFetchedRef.current = false;
    messagesByPeerRef.current = {};
    socketCursorsRef.current = {};
    socketCursorScopeRef.current = scope;
    activeChatPeerIdRef.current = null;
    attachmentUploadMetaRef.current = {};
    clearTimeout(drainTimerRef.current ?? undefined);
    Object.values(typingTimeoutsRef.current).forEach(clearTimeout);
    return () => { scopeRef.current = ''; };
  }, [scope]);

  useEffect(() => {
    activeChatPeerIdRef.current = activeChatPeerId;
  }, [activeChatPeerId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    messagesByPeerRef.current = messagesByPeer;
  }, [messagesByPeer]);

  // ─── Hydrate-then-fetch ──────────────────────────────────────────────────
  // Render whatever was cached locally straight away, then let the network
  // refresh it. The mirror back into the local store — trailing-debounced and
  // force-flushed on background and unmount — lives in the same module.
  const applySnapshot = useCallback((snapshot: ChatSnapshot) => {
    outboxRef.current = snapshot.outbox;
    socketCursorsRef.current = {
      ...snapshot.socketCursors,
      ...(socketCursorScopeRef.current === scope ? socketCursorsRef.current : {}),
    };
    socketCursorScopeRef.current = scope;
    setSocketCursors(socketCursorsRef.current);
    const cachedHistories = snapshot.messagesByPeer;
    const liveHistories = messagesByPeerRef.current;
    const mergedHistories: Record<string, ChatMessage[]> = {};
    for (const peerId of new Set([...Object.keys(cachedHistories), ...Object.keys(liveHistories)])) {
      mergedHistories[peerId] = dedupeAndSort([
        ...(cachedHistories[peerId] ?? []).map(entry =>
          entry.uploadState === 'uploading' && !attachmentUploadMetaRef.current[entry.messageId] &&
          !snapshot.outbox.some(item => item.messageId === entry.messageId)
            ? asUploadFailed(entry, 'Upload interrupted. Retry the attachment upload.')
            : entry),
        ...(liveHistories[peerId] ?? []),
      ]);
    }
    messagesByPeerRef.current = restoreOutboxMessages(mergedHistories, snapshot.outbox, userId);
    let restoredConversations = snapshot.conversations;
    for (const item of snapshot.outbox) {
      if (restoredConversations.some(row => row.peerId === item.recipientId)) continue;
      const message = messagesByPeerRef.current[item.recipientId]?.find(row => row.messageId === item.messageId);
      if (message) restoredConversations = withOutgoingMessage(restoredConversations, message);
    }
    setPendingSendCount(snapshot.outbox.length);
    // Only fill in what the network hasn't already provided: a response that
    // beat the disk read is newer than the cache.
    const pendingPeers = new Set(snapshot.outbox.map(item => item.recipientId));
    const previousConversations = conversationsRef.current;
    const hydrated = conversationsFetchedRef.current
      ? previousConversations
      : [...previousConversations, ...restoredConversations.filter(row =>
        !previousConversations.some(current => current.peerId === row.peerId))];
    const nextConversations = mergePendingConversations(hydrated, restoredConversations, pendingPeers);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    setMessagesByPeer(messagesByPeerRef.current);
    // A local edit that beat the disk read wins over its older cached draft.
    setDrafts(prev => ({ ...snapshot.drafts, ...prev }));
    // Anything still queued from a previous run goes out as soon as the socket
    // allows it — this is what makes a force-quit mid-send safe.
    if (snapshot.outbox.some(isRetryable)) drainOutboxRef.current();
  }, [scope, userId]);

  const { persistNow } = useChatSnapshotMirror({
    conversations: stateScope === scope ? conversations : [],
    messagesByPeer: stateScope === scope ? messagesByPeer : {},
    socketCursors: stateScope === scope ? socketCursors : {},
    drafts: stateScope === scope ? drafts : {},
    onHydrate: applySnapshot,
    scope,
  });
  persistChatSnapshotRef.current = persistNow;

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
  const fetchConversations = useCallback(() => requests.run('conversations', async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    const initialGroups = new Map(conversationsRef.current.filter(row => row.group && !row.localMock)
      .map(row => [row.peerId, row.group!.membershipVersion]));
    try {
      const trimmedUrl = signalingUrl.trim();
      const response = await authedFetchRef.current?.((sid: string) => ({
        url: `${trimmedUrl}${API_ROUTES.CONVERSATIONS}`,
        options: { headers: bearerAuthHeaders(sid) },
      }));
      if (!response?.ok) return;
      const data = await response.json();
      if (scopeRef.current !== scope) return;
      if (!Array.isArray(data.conversations)) return;
      const parsedGroups = parseGroupList(data.groupConversations, userId);
      conversationsFetchedRef.current = true;
      const pendingPeers = new Set(outboxRef.current.map(item => item.recipientId));
      const previous = conversationsRef.current;
      const groups = remoteGroupRows(parsedGroups, previous, userId, initialGroups);
      const next = mergePendingConversations([...groups, ...data.conversations], previous, pendingPeers);
      conversationsRef.current = next;
      setConversations(next);
    } catch (error) {
      logWarn('[Messaging] fetchConversations failed', {
        message: errorMessage(error),
      });
    }
  }), [authedFetchRef, sessionIdRef, signalingUrl, scope, requests, userId]);

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
    (peerId: string, { before, cursor }: { before?: string; cursor?: TimelineCursor | null; } = {}) =>
      requests.run(JSON.stringify(['messages', peerId, cursor ?? before]), async () => {
      const trimmedPeerId = (peerId ?? '').trim();
      const group = conversationsRef.current.find(row => row.peerId === trimmedPeerId && row.group);
      if (group?.localMock || group?.left) {
        return messagesByPeerRef.current[trimmedPeerId] ?? [];
      }
      const sessionId = sessionIdRef.current;
      if (!sessionId || !trimmedPeerId) return [];
      try {
        const pageCursor = cursor ?? (before ? { before } : null);
        const messages = group
          ? await fetchGroupHistory(authedFetchRef.current, signalingUrl.trim(), group.group!.conversationId, pageCursor)
          : await fetchHistory(authedFetchRef.current, signalingUrl.trim(), trimmedPeerId,
            pageCursor, messagesByPeerRef.current[trimmedPeerId]?.length ?? 0);
        if (!messages || scopeRef.current !== scope) return [];
        messages.forEach((message: ChatMessage) => {
          if (message.deletedAt) evictTombstonedAttachment(message.messageId);
        });
        const beforeCursor = cursor?.before ?? before;
        const merged = mergeHistoryPage(
          messagesByPeerRef.current[trimmedPeerId] ?? [], messages, { before: beforeCursor },
        );
        messagesByPeerRef.current = { ...messagesByPeerRef.current, [trimmedPeerId]: merged };
        setMessagesByPeer(prev => ({
          ...prev,
          [trimmedPeerId]: mergeHistoryPage(prev[trimmedPeerId] ?? [], messages, { before: beforeCursor }),
        }));
        return messages;
      } catch (error) {
        logWarn('[Messaging] fetchMessagesForPeer failed', {
          message: errorMessage(error),
        });
        return [];
      }
    }),
    [authedFetchRef, sessionIdRef, signalingUrl, scope, requests],
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
      const group = conversationsRef.current.find(row => row.peerId === trimmedPeerId && row.group);
      if (group) {
        if (group.left || !group.group!.memberIds.includes(userId)) return;
        // The implemented read endpoint is direct-only; group counts remain local.
        const next = conversationsRef.current.map(row => row.peerId !== trimmedPeerId ? row : {
          ...row, unreadCount: 0,
          readByMember: { ...row.readByMember, [userId]: new Date().toISOString() },
        });
        conversationsRef.current = next;
        setConversations(next);
        return;
      }
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.((sid: string) => ({
          url: `${trimmedUrl}${API_ROUTES.MESSAGES_READ}`,
          options: {
            method: 'POST',
            headers: bearerAuthHeaders(sid, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ peerId: trimmedPeerId }),
          },
        }));
        if (!response?.ok || scopeRef.current !== scope) return;
        const next = withConversationRead(conversationsRef.current, trimmedPeerId);
        conversationsRef.current = next;
        setConversations(next);
      } catch (error) {
        logWarn('[Messaging] markConversationRead failed', {
          message: errorMessage(error),
        });
      }
    },
    [authedFetchRef, signalingUrl, scope, userId],
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
    async (query: string, {
      limit = 20, signal, peerId, conversationId,
    }: { limit?: number; signal?: AbortSignal; peerId?: string; conversationId?: string; } = {}) => {
      const term = (query ?? '').trim();
      const sessionId = sessionIdRef.current;
      if (!term || signal?.aborted) return [];
      const localResults = () => Object.entries(messagesByPeerRef.current)
        .filter(([messagePeerId]) => !peerId || messagePeerId === peerId)
        .flatMap(([messagePeerId, messages]) => messages
          .filter(message => !message.deletedAt && message.body?.toLowerCase().includes(term.toLowerCase()))
          .map(message => ({ ...message, peerId: messagePeerId })));
      const cachedResults = localResults();
      if (!sessionId) return cachedResults;
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.((sid: string) => {
          const params = new URLSearchParams({ q: term, limit: String(limit) });
          if (conversationId) params.set('conversationId', conversationId);
          return {
            url: `${trimmedUrl}${API_ROUTES.MESSAGES_SEARCH}?${params.toString()}`,
            options: { headers: bearerAuthHeaders(sid), ...(signal ? { signal } : {}) },
          };
        });
        if (!response?.ok) return cachedResults;
        const data = await response.json();
        if (scopeRef.current !== scope || signal?.aborted) return [];
        const remoteResults = Array.isArray(data.results) ? data.results.filter((message: ChatMessage) =>
          !peerId || message.peerId === peerId) : [];
        return mergeMessageSearchResults(cachedResults, remoteResults, limit);
      } catch (error) {
        // An aborted request is the expected outcome of a newer keystroke, not
        // a failure worth logging.
        if (!(error instanceof Error) || error.name !== 'AbortError') {
          logWarn('[Messaging] searchMessages failed', { message: errorMessage(error) });
        }
        return scopeRef.current === scope && !signal?.aborted ? cachedResults : [];
      }
    },
    [authedFetchRef, sessionIdRef, signalingUrl, scope],
  );

  const searchLocalMessages = useCallback(
    (query: string, { limit = 20, peerId }: { limit?: number; peerId?: string; } = {}) => {
      const term = (query ?? '').trim().toLowerCase();
      if (!term) return [];
      const localResults = Object.entries(messagesByPeerRef.current)
        .filter(([messagePeerId]) => !peerId || messagePeerId === peerId)
        .flatMap(([messagePeerId, messages]) => messages
          .filter(message => !message.deletedAt && message.body?.toLowerCase().includes(term))
          .map(message => ({ ...message, peerId: messagePeerId })));
      return mergeMessageSearchResults(localResults, [], limit);
    },
    [],
  );

  const backfillMessages = useCallback(async () => {
    if (!scope || !userId || !sessionIdRef.current || backfillScopeRef.current === scope) return;
    backfillScopeRef.current = scope;
    try {
      await resumeMessageBackfill({
        scope,
        userId,
        signalingUrl,
        getSessionId: () => sessionIdRef.current,
        authedFetch: authedFetchRef.current,
        isCurrentScope: () => scopeRef.current === scope,
        getMessages: () => messagesByPeerRef.current,
        setMessages: next => {
          messagesByPeerRef.current = next;
          setMessagesByPeer(next);
        },
        onStart: () => setIsBackfillingMessages(true),
        onProgress: setBackfilledMessageCount,
        onDeleted: evictTombstonedAttachment,
      });
    } catch (error) {
      logWarn('[Messaging] history backfill paused', { message: errorMessage(error) });
    } finally {
      if (backfillScopeRef.current === scope) {
        backfillScopeRef.current = null;
        setIsBackfillingMessages(false);
      }
    }
  }, [authedFetchRef, scope, sessionIdRef, signalingUrl, userId]);

  /**
   * Update one local message in `peerId`'s history, by id.
   */
  const patchMessage = useCallback(
    (peerId: string, messageId: string, update: (message: ChatMessage) => ChatMessage) => {
      messagesByPeerRef.current = patchMessageIn(messagesByPeerRef.current, peerId, messageId, update, userId);
      setMessagesByPeer(prev => patchMessageIn(prev, peerId, messageId, update, userId));
    },
    [userId],
  );

  const recordCallActivity = useCallback((peerId: string, activity: CallActivity) => {
    const trimmedPeerId = (peerId ?? '').trim();
    if (!trimmedPeerId || !activity?.callId) return;
    const nextMessages = upsertTimelineEntry(
      messagesByPeerRef.current, trimmedPeerId, activity as unknown as ChatMessage,
    );
    messagesByPeerRef.current = nextMessages;
    setMessagesByPeer(nextMessages);
    const nextConversations = withCallActivity(conversationsRef.current, trimmedPeerId, activity);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
  }, []);

  /**
   * Replace the outbox and mirror it into the local store, so a queued send
   * outlives the process that composed it.
   */
  const persistOutbox = useCallback(/** @param next */ (next: OutboxItem[]) => {
    if (!scope || scopeRef.current !== scope) return;
    outboxRef.current = next;
    setPendingSendCount(next.length);
    saveChatSnapshot({
      outbox: next, messagesByPeer: messagesByPeerRef.current, conversations: conversationsRef.current,
    }, scope);
  }, [scope]);

  const groupActions = useMemo(() => {
    const commit = async (row: ConversationSummary) => {
      if (!scope || scopeRef.current !== scope) throw new Error('Sign in before managing groups');
      await loadChatSnapshot(scope);
      if (scopeRef.current !== scope) throw new Error('Account changed');
      const next = [row, ...conversationsRef.current.filter(entry => entry.peerId !== row.peerId)];
      const previous = conversationsRef.current;
      conversationsRef.current = next;
      setConversations(next);
      saveChatSnapshot({ conversations: next }, scope);
      try {
        await flushChatDb(scope);
      } catch (error) {
        if (scopeRef.current === scope && conversationsRef.current === next) {
          conversationsRef.current = previous;
          setConversations(previous);
          saveChatSnapshot({ conversations: previous }, scope);
        }
        throw error;
      }
      if (scopeRef.current !== scope) throw new Error('Account changed');
    };
    const find = (id: string) => {
      const row = conversationsRef.current.find(entry => entry.peerId === id && entry.group);
      if (!row || row.left || !row.group!.memberIds.includes(userId)) throw new Error('You are not a member');
      return row;
    };
    const live = async (event: string, payload: object) => {
      if (!scope || scopeRef.current !== scope) throw new Error('Account changed');
      if (!socketRef.current?.connected || !signalingRef.current) throw new Error('Connect before managing a live group');
      const ack = await signalingRef.current.request(event, { version: SIGNALING_VERSION, ...payload });
      if (scopeRef.current !== scope) throw new Error('Account changed');
      const group = conversationAcknowledgement(ack, userId);
      const expectedId = (payload as { conversationId?: string }).conversationId;
      if (expectedId && group.conversationId !== expectedId) throw new Error('Server acknowledged a different group');
      const next = applyGroupSnapshot(conversationsRef.current, group, userId);
      conversationsRef.current = next;
      setConversations(next);
      saveChatSnapshot({ conversations: next }, scope);
      try { await flushChatDb(scope); }
      catch {
        if (scopeRef.current === scope) updateStatus('Group updated on the server, but its offline cache could not be saved.', 'error');
      }
      if (scopeRef.current !== scope) throw new Error('Account changed');
      return group;
    };
    return {
      mode: groupTransport,
      create: async (name: string, inviteeIds: string[]) => {
        const id = `mock-group-${createMessageId()}`;
        const mock = createMockGroup(userId, name, inviteeIds, id);
        if (mock.group!.memberIds.length > 16) throw new Error('Select no more than 15 other people');
        if (groupTransport === 'live') {
          const group = await live(CLIENT_EVENTS.CONVERSATION_CREATE, {
            name: mock.group!.name, inviteeIds: mock.group!.memberIds.filter(memberId => memberId !== userId),
          });
          return group.conversationId;
        }
        await commit(mock);
        return id;
      },
      members: async (id: string, action: GroupMemberAction) => {
        const row = find(id);
        if (row.localMock) {
          await commit(mutateMockMembers(row, userId, action));
        } else if (action.type === 'add') {
          await live(CLIENT_EVENTS.CONVERSATION_MEMBER_ADD, {
            conversationId: row.conversationId,
            userIds: action.userIds,
          });
        } else {
          await live(CLIENT_EVENTS.CONVERSATION_MEMBER_REMOVE, {
            conversationId: row.conversationId,
            userId: action.userId,
          });
        }
      },
      rename: async (id: string, name: string) => {
        const row = find(id);
        const updated = renameMockGroup(row, userId, name);
        if (row.localMock) await commit(updated);
        else {
          await live(CLIENT_EVENTS.CONVERSATION_UPDATE, { conversationId: row.conversationId, name: name.trim() });
        }
      },
      leave: async (id: string) => {
        const row = find(id);
        if (!row.localMock) {
          const group = await live(CLIENT_EVENTS.CONVERSATION_LEAVE, { conversationId: row.conversationId });
          if (group.memberIds.includes(userId)) throw new Error('Server did not confirm departure');
        } else {
          await commit(leaveMockGroup(row, userId));
        }
        // Keep unsent bubbles recoverable, but never replay after leaving.
        const messages = {
          ...messagesByPeerRef.current,
          [id]: (messagesByPeerRef.current[id] ?? []).map(entry => entry.pending ? asFailed(entry) : entry),
        };
        messagesByPeerRef.current = messages;
        setMessagesByPeer(messages);
        persistOutbox(outboxRef.current.map(item => item.recipientId === id
          ? { ...item, attempts: OUTBOX_MAX_ATTEMPTS, lastError: 'Left group' } : item));
        // The departure has already happened; a failed cache write must not be
        // reported as a failed leave, or the screen stays on a group the user left.
        try { await flushChatDb(scope); }
        catch {
          if (scopeRef.current === scope) updateStatus('You left the group, but its offline cache could not be saved.', 'error');
        }
      },
    };
  }, [scope, userId, persistOutbox, socketRef, signalingRef, groupTransport, updateStatus]);

  /**
   * The local-preview simulation surface, kept out of {@link groupActions} so
   * only the screens that render the mock harness can reach it — and so a live
   * build cannot inject fabricated peer activity at all.
   */
  const groupPreviewActions = useMemo(() => {
    if (groupTransport === 'live') return null;
    return {
      activity: (id: string, memberId: string, action: 'typing' | 'read' | 'message') => {
        const row = conversationsRef.current.find(entry => entry.peerId === id && entry.group);
        if (!row || row.left || !row.group!.memberIds.includes(userId)) throw new Error('You are not a member');
        if (!row.localMock || memberId === userId || !row.group!.memberIds.includes(memberId)) {
          throw new Error('Simulation is available only for other local preview members');
        }
        const now = new Date().toISOString();
        if (action === 'read') {
          const next = conversationsRef.current.map(entry => entry.peerId !== id ? entry : {
            ...entry, readByMember: { ...entry.readByMember, [memberId]: now },
          });
          conversationsRef.current = next;
          setConversations(next);
        } else if (action === 'typing') {
          const key = JSON.stringify([id, memberId]);
          clearTimeout(typingTimeoutsRef.current[key]);
          setGroupTyping(prev => ({ ...prev, [id]: { ...prev[id], [memberId]: true } }));
          typingTimeoutsRef.current[key] = setTimeout(() =>
            setGroupTyping(prev => ({ ...prev, [id]: { ...prev[id], [memberId]: false } })), TYPING_INDICATOR_TIMEOUT_MS);
        } else {
          const message: ChatMessage = {
            messageId: createMessageId(), conversationId: row.conversationId,
            senderId: memberId, recipientId: id, body: 'Hello from the local preview', createdAt: now,
          };
          messagesByPeerRef.current = prependMessage(messagesByPeerRef.current, id, message);
          setMessagesByPeer(prev => prependMessage(prev, id, message));
          const next = withIncomingMessage(conversationsRef.current, message, {
            incrementUnread: activeChatPeerIdRef.current !== id,
          });
          conversationsRef.current = next;
          setConversations(next);
        }
      },
    };
  }, [userId, groupTransport]);

  useEffect(() => {
    const signaling = signalingRef.current;
    if (!signaling || !isSocketConnected || !scope) return undefined;
    return signaling.on(SERVER_EVENTS.CONVERSATION_UPDATED, ({ conversation }: { conversation: ConversationRecord }) => {
      if (scopeRef.current !== scope) return;
      const next = applyGroupSnapshot(conversationsRef.current, conversation, userId);
      conversationsRef.current = next;
      setConversations(next);
    });
  }, [isSocketConnected, scope, signalingRef, userId]);

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
  const prepareOutboxReply = useCallback((item: OutboxItem) => {
    const messages = messagesByPeerRef.current[item.recipientId] ?? [];
    const resolved = resolveOutboxReply(item, messages, userId);
    if (resolved) return { status: 'ready', item: resolved } as const;
    const reason = unavailableReplyReason(item, messages, outboxRef.current, userId);
    if (!reason) return { status: 'waiting' } as const;
    patchMessage(item.recipientId, item.messageId, asFailed);
    persistOutbox(withAttemptRecorded(outboxRef.current, item.messageId, {
      attempts: OUTBOX_MAX_ATTEMPTS, lastError: reason, lastAttemptAt: new Date().toISOString(),
    }));
    return { status: 'unavailable' } as const;
  }, [patchMessage, persistOutbox, userId]);

  const sendOutboxItem = useCallback(
    /** @param item */
    async (item: OutboxItem) => {
      const signaling = signalingRef?.current;
      if (!signaling || !socketRef.current?.connected || scopeRef.current !== scope) return false;

      // Failure to commit is not a send attempt: never emit an undurable row.
      try {
        await flushChatDb(scope);
      } catch {
        updateStatus('Cannot save message on this device. Free storage and retry.', 'error');
        return false;
      }
      const latest = outboxRef.current.find(row => row.messageId === item.messageId);
      if (scopeRef.current !== scope || !latest) return false;
      item = latest;

      try {
        const row = conversationsRef.current.find(entry => entry.peerId === item.recipientId);
        if (item.targetKind === 'group' && (!row?.group || row.left || !row.group.memberIds.includes(userId))) {
          throw new Error('You are no longer a group member');
        }
        // Replies to optimistic rows must wait for their server identity. Save
        // the resolved reference before emitting so retries submit the same send.
        const reply = prepareOutboxReply(item);
        if (reply.status !== 'ready') return reply.status;
        if (reply.item !== item) {
          item = reply.item;
          persistOutbox(outboxRef.current.map(queued => queued.messageId === item.messageId ? item : queued));
          await flushChatDb(scope);
        }
        if (scopeRef.current !== scope) return false;
        const ack = item.localMock
          ? { message: sendMockGroup(row, item, userId) }
          : await signaling.request(CLIENT_EVENTS.MESSAGE_SEND, outboxSendPayload(item));
        if (scopeRef.current !== scope) return false;
        const confirmed = (ack as { message?: ChatMessage } | undefined)?.message;
        patchMessage(item.recipientId, item.messageId, entry => asSent(entry, confirmed));
        const nextConversations = withReconciledMessage(conversationsRef.current, item.recipientId, item.messageId, confirmed);
        conversationsRef.current = nextConversations;
        setConversations(nextConversations);
        persistOutbox(withoutMessage(withResolvedReplies(outboxRef.current, item.messageId, confirmed?.messageId), item.messageId));
        return true;
      } catch (error) {
        if (scopeRef.current !== scope) return false;
        logWarn('[Messaging] sendMessage failed', { message: errorMessage(error) });
        const attempts = (item.attempts ?? 0) + 1;
        if (attempts >= OUTBOX_MAX_ATTEMPTS) {
          patchMessage(item.recipientId, item.messageId, asFailed);
          updateStatus('Message failed to send', 'error');
        }
        persistOutbox(
          withAttemptRecorded(outboxRef.current, item.messageId, {
            attempts,
            lastAttemptAt: new Date().toISOString(),
            lastError: errorMessage(error) ?? null,
          }),
        );
        return false;
      }
    },
    [patchMessage, persistOutbox, signalingRef, socketRef, updateStatus, scope, userId, prepareOutboxReply],
  );

  /**
   * Flush the durable outbox, oldest first.  A no-op while offline (the queue
   * is simply left for the next connect) and re-armed with backoff whenever a
   * send does not get through.
   */
  const drainOutbox = useCallback(async () => {
    if (drainingScopeRef.current === scope) return;
    const queue = drainOrder(outboxRef.current);
    if (!queue.length) return;
    if (!socketRef.current?.connected || !signalingRef?.current) {
      scheduleDrain();
      return;
    }

    drainingScopeRef.current = scope;
    let allSent = true;
    try {
      allSent = await drainQueuedMessages(queue, sendOutboxItem);
    } finally {
      if (drainingScopeRef.current === scope) drainingScopeRef.current = null;
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
    }
    // A new send can join the queue while the captured batch awaits an ack.
    if (scopeRef.current === scope && outboxRef.current.some(isRetryable)) {
      scheduleDrain();
    }
  }, [scheduleDrain, sendOutboxItem, signalingRef, socketRef, scope]);

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
      void fetchConversations();
      void backfillMessages();
      const peer = activeChatPeerIdRef.current;
      if (peer) void fetchMessagesForPeer(peer);
    });
    return () => subscription?.remove?.();
  }, [backfillMessages, fetchConversations, fetchMessagesForPeer]);

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
      if (!scope) return;
      try {
        await loadChatSnapshot(scope);
      } catch {
        updateStatus('Cannot open local message storage. Retry before sending.', 'error');
        return;
      }
      if (scopeRef.current !== scope) return;
      const groupRow = conversationsRef.current.find(row => row.peerId === trimmedPeerId && row.group);
      if (groupRow && (groupRow.left || !groupRow.group!.memberIds.includes(userId))) {
        updateStatus('You are no longer a group member', 'error');
        return;
      }

      const messageId = createMessageId();
      const createdAt = nextLocalCreatedAt(
        messagesByPeerRef.current[trimmedPeerId] ?? [],
        Date.now(),
        lastLocalCreatedAtMsRef.current,
      );
      lastLocalCreatedAtMsRef.current = Date.parse(createdAt);
      const conversationId = conversationIdForPeer(conversationsRef.current, trimmedPeerId);
      const outgoing = {
        messageId,
        clientMessageId: messageId,
        conversationId,
        senderId: userId,
        recipientId: trimmedPeerId,
        createdAt,
        body: trimmedBody,
        type,
        attachment,
        replyTo,
        replyToLocalMessageId: optimisticReplyKey(replyTo, messagesByPeerRef.current[trimmedPeerId] ?? [], userId),
        ...(groupRow ? { targetKind: 'group' as const, localMock: groupRow.localMock } : {}),
      };

      // Built once and shared: the conversation and the chat-list row are two
      // views of the same message and must not be able to drift apart.
      const optimistic = buildOptimisticMessage(outgoing);
      setMessagesByPeer(prev => prependMessage(prev, trimmedPeerId, optimistic));
      // The chat list summarises the same conversation, so it has to learn
      // about the send at the same moment the conversation does.
      setConversations(prev => withOutgoingMessage(prev, optimistic));
      persistOutbox([...outboxRef.current, buildOutboxItem(outgoing)]);
      // Persist the optimistic row and queue together, before React's mirror runs.
      messagesByPeerRef.current = prependMessage(messagesByPeerRef.current, trimmedPeerId, optimistic);
      conversationsRef.current = withOutgoingMessage(conversationsRef.current, optimistic);
      saveChatSnapshot({
        messagesByPeer: messagesByPeerRef.current,
        conversations: conversationsRef.current,
      }, scope);
      try {
        await flushChatDb(scope);
      } catch {
        updateStatus('Message is not saved. Free device storage and retry.', 'error');
        scheduleDrain();
        return;
      }

      await drainOutbox();
      return messageId;
    },
    [drainOutbox, persistOutbox, userId, scope, scheduleDrain, updateStatus],
  );

  const beginAttachmentUpload = useCallback(
    (peerId: string, type: string, attachment: Partial<AttachmentRecord> | null) => {
      if (!scope || scopeRef.current !== scope) return null;
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !isAttachmentMessageType(type) || !attachment?.url) return null;

      const messageId = createMessageId();
      const createdAt = nextLocalCreatedAt(
        messagesByPeerRef.current[trimmedPeerId] ?? [],
        Date.now(),
        lastLocalCreatedAtMsRef.current,
      );
      lastLocalCreatedAtMsRef.current = Date.parse(createdAt);
      const conversationId = conversationIdForPeer(conversationsRef.current, trimmedPeerId);
      const optimisticMessage = buildUploadingMessage({
        messageId,
        clientMessageId: messageId,
        conversationId,
        senderId: userId,
        recipientId: trimmedPeerId,
        createdAt,
        type,
        attachment: attachment as AttachmentRecord,
      });

      messagesByPeerRef.current = prependMessage(messagesByPeerRef.current, trimmedPeerId, optimisticMessage);
      conversationsRef.current = withOutgoingMessage(conversationsRef.current, optimisticMessage);
      setMessagesByPeer(prev => prependMessage(prev, trimmedPeerId, optimisticMessage));
      setConversations(prev => withOutgoingMessage(prev, optimisticMessage));
      attachmentUploadMetaRef.current[messageId] = { conversationId, createdAt };
      return messageId;
    },
    [userId, scope],
  );

  const updateAttachmentUploadProgress = useCallback(
    (peerId: string, messageId: string, progress: number) => {
      patchMessage(peerId, messageId, entry => withUploadProgress(entry, progress));
    },
    [patchMessage],
  );

  const finishAttachmentUpload = useCallback(
    async (peerId: string, messageId: string, type: string, attachment: AttachmentRecord) => {
      if (!scope || scopeRef.current !== scope) return;
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !messageId || !attachment?.url) return;
      const meta = attachmentUploadMetaRef.current[messageId];
      const conversationId =
        meta?.conversationId ?? conversationIdForPeer(conversationsRef.current, trimmedPeerId);
      const createdAt = meta?.createdAt ?? new Date().toISOString();

      patchMessage(trimmedPeerId, messageId, entry => asUploaded(entry, attachment));

      const groupRow = conversationsRef.current.find(row => row.peerId === trimmedPeerId && row.group);
      const nextItem = buildOutboxItem({
        messageId,
        clientMessageId: messageId,
        conversationId,
        recipientId: trimmedPeerId,
        createdAt,
        type,
        attachment,
        ...(groupRow ? { targetKind: 'group' as const, localMock: groupRow.localMock } : {}),
      });
      // Replayed under the original message identity, so a retry can never
      // duplicate the send it is retrying.
      persistOutbox([...withoutMessage(outboxRef.current, messageId), nextItem]);
      delete attachmentUploadMetaRef.current[messageId];
      await drainOutbox();
    },
    [drainOutbox, patchMessage, persistOutbox, scope],
  );

  const failAttachmentUpload = useCallback(
    (peerId: string, messageId: string, error: string | null = null) => {
      if (scopeRef.current !== scope) return;
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !messageId) return;
      delete attachmentUploadMetaRef.current[messageId];
      // The bubble stays, in a failed state: a cancelled or failed upload must
      // never silently vanish.
      patchMessage(trimmedPeerId, messageId, entry => asUploadFailed(entry, error));
      persistOutbox(withoutMessage(outboxRef.current, messageId));
    },
    [patchMessage, persistOutbox, scope],
  );

  /**
   * Re-queue a message whose automatic retries were exhausted, putting it back
   * into `pending` and draining immediately.
   */
  const retryMessage = useCallback(
    async (peerId: string, messageId: string) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId || !messageId) return;
      const group = conversationsRef.current.find(row => row.peerId === trimmedPeerId && row.group);
      if (group && (group.left || !group.group!.memberIds.includes(userId))) return;

      const queued = outboxRef.current.some(item => item.messageId === messageId);
      // The retry keeps the original message identity, so a late-succeeding
      // original send cannot land alongside it as a duplicate.
      if (!queued) return;

      patchMessage(trimmedPeerId, messageId, asQueued);
      persistOutbox(withAttemptsReset(outboxRef.current, messageId));
      drainAttemptRef.current = 0;
      clearTimeout(drainTimerRef.current ?? undefined);
      drainTimerRef.current = null;
      await drainOutbox();
    },
    [drainOutbox, patchMessage, persistOutbox, userId],
  );

  /**
   * Remove one message from the local history, wherever it lives.
   */
  const removeMessageLocally = useCallback(
    (peerId: string, messageId: string) => {
      messagesByPeerRef.current = removeMessage(messagesByPeerRef.current, peerId, messageId);
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
      removeMessageLocally(trimmedPeerId, messageId);
      persistOutbox(withoutMessage(outboxRef.current, messageId));
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
      if (!scope || scopeRef.current !== scope) return false;
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
      if (scopeRef.current !== scope) return false;
      patchMessage(trimmedPeerId, messageId, entry => ({ ...entry, ...tombstoneOf(entry) }));
      evictTombstonedAttachment(messageId);
      return true;
    },
    [discardMessage, patchMessage, signalingRef, socketRef, updateStatus, scope],
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
      const group = conversationsRef.current.find(row => row.peerId === trimmedPeerId && row.group);
      if (group?.left || (group && !group.group!.memberIds.includes(userId))) return;
      if (group?.localMock) return;
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
        ...(group ? { conversationId: group.conversationId } : { recipientId: trimmedPeerId }),
        isTyping: Boolean(isTyping),
      });
    },
    [signalingRef, socketRef, userId],
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
    setGroupTyping({});
  }, []);

  const commitMessageHistory = useCallback((next: Record<string, ChatMessage[]>) => {
    if (next === messagesByPeerRef.current) return;
    messagesByPeerRef.current = next;
    setMessagesByPeer(next);
  }, []);

  const commitLiveMessage = useCallback((
    peerId: string,
    message: ChatMessage,
    nextMessages: Record<string, ChatMessage[]>,
    nextConversations: ConversationSummary[],
  ) => {
    messagesByPeerRef.current = nextMessages;
    conversationsRef.current = nextConversations;
    setMessagesByPeer(nextMessages);
    setConversations(nextConversations);

    const conversationId = message.conversationId ??
      conversationIdForPeer(nextConversations, peerId);
    let cursors = socketCursorScopeRef.current === scope ? socketCursorsRef.current : {};
    if (conversationId) {
      const cursor = advanceSocketMessageCursor(cursors[conversationId], message);
      if (cursor !== cursors[conversationId]) {
        cursors = { ...cursors, [conversationId]: cursor! };
      }
    }
    if (scope && scopeRef.current === scope) {
      socketCursorScopeRef.current = scope;
      socketCursorsRef.current = cursors;
      if (cursors !== socketCursors) setSocketCursors(cursors);
    }
  }, [scope, socketCursors]);

  // ─── Socket-event adapters ────────────────────────────────────────────────
  // These encapsulate exactly how each raw `message.*` socket event mutates
  // this hook's state, so `useCallFlow`'s socket handlers stay thin.

  const handleGroupMessageReceived = useCallback((message: ChatMessage) => {
    const groupRow = conversationsRef.current.find(row => row.group && row.conversationId === message.conversationId);
    if (!groupRow) return false;
    if (groupRow.left || !groupRow.group!.memberIds.includes(userId) ||
      !groupRow.group!.memberIds.includes(message.senderId)) return true;
    const key = groupRow.peerId;
    const existing = messagesByPeerRef.current[key] ?? [];
    const duplicate = existing.some(entry => timelineEntryId(entry) === timelineEntryId(message));
    const nextMessages = existing.some(entry => entry.messageId === message.messageId)
      ? messagesByPeerRef.current
      : upsertTimelineEntry(messagesByPeerRef.current, key, message);
    const next = duplicate ? conversationsRef.current : withIncomingMessage(conversationsRef.current, message, {
      incrementUnread: message.senderId !== userId && activeChatPeerIdRef.current !== key,
    });
    commitLiveMessage(key, message, nextMessages, next);
    if (activeChatPeerIdRef.current === key) {
      void markConversationRead(key);
      markMessageSeen(message.messageId);
      return true;
    }
    if (!duplicate && message.senderId !== userId) {
      displayMessageReceivedInApp(message).catch(error => {
        logWarn('[Messaging] in-app group message notification failed', {
          message: errorMessage(error),
        });
      });
    }
    markMessageSeen(message.messageId);
    return true;
  }, [commitLiveMessage, markConversationRead, userId]);

  const handleMessageReceived = useCallback(
      (message: ChatMessage) => {
      if (!message?.senderId) return;
      if (handleGroupMessageReceived(message)) return;
      // Server group messages use the conversation ID as recipientId, unlike direct messages.
      if (message.conversationId && message.recipientId === message.conversationId && message.recipientId !== userId) {
        void fetchConversations().then(() => {
          if (scopeRef.current === scope) handleGroupMessageReceived(message);
        });
        return;
      }
      const senderId = message.senderId;

      const duplicate = messagesByPeerRef.current[senderId]?.some(entry => timelineEntryId(entry) === timelineEntryId(message));
      const nextMessages = applyIncomingMessage(messagesByPeerRef.current, message);
      const isActiveConversation = activeChatPeerIdRef.current === senderId;
      const isNewConversation = !conversationsRef.current.some(
        conversation => conversation.peerId === senderId,
      );
      const nextConversations = duplicate ? conversationsRef.current :
        withIncomingMessage(conversationsRef.current, message, { incrementUnread: !isActiveConversation });
      commitLiveMessage(senderId, message, nextMessages, nextConversations);
      if (isNewConversation && !duplicate) void fetchConversations();

      if (isActiveConversation) {
        // The conversation is currently open: auto-mark-read, no unread bump,
        // and clear any notification a push already posted for it.
        markMessageSeen(message.messageId);
        if (message.conversationId) dismissMessageNotification(message.conversationId);
        markConversationRead(senderId).catch(error => {
          logWarn('[Messaging] markConversationRead failed', {
            message: errorMessage(error),
          });
        });
        return;
      }

      if (duplicate) {
        markMessageSeen(message.messageId);
        return;
      }
      displayMessageReceivedInApp(message).catch(error => {
        logWarn('[Messaging] in-app message notification failed', {
          message: errorMessage(error),
        });
      });
      // The same message can also arrive as a push; record it after the in-app
      // path has had a chance to consult the shared dedupe registry.
      markMessageSeen(message.messageId);
    },
    [commitLiveMessage, fetchConversations, markConversationRead, userId, handleGroupMessageReceived, scope],
  );

  const handleMessageDelivered = useCallback(/** @param message */ (message: ChatMessage) => {
    if (!message?.recipientId) return;
    const group = conversationsRef.current.find(row => row.group && row.conversationId === message.conversationId);
    if (group) {
      commitMessageHistory(patchMessageIn(messagesByPeerRef.current, group.peerId, message.messageId,
        entry => asSent(entry, message)));
      return;
    }
    commitMessageHistory(applyDeliveryReceipt(messagesByPeerRef.current, message));
  }, [commitMessageHistory]);

  /**
   * Whether a direct `message.*` event names a conversation that is not this
   * peer's. A row only learns its conversation id once the server has reported
   * it, so an unknown id is "not yet known", never a mismatch: rejecting it
   * would drop the read receipt and typing indicator of every conversation
   * whose first message has not been refetched yet.
   */
  const contradictsDirectConversation = useCallback((peerId: string, conversationId?: string) => {
    if (!conversationId) return false;
    const known = conversationIdForPeer(conversationsRef.current, peerId);
    return Boolean(known) && known !== conversationId;
  }, []);

  const handleMessageRead = useCallback(
    /** @param payload */
    ({ readerId, readAt, conversationId }: { readerId?: string; readAt?: string; conversationId?: string; }) => {
      if (!readerId) return;
      const group = conversationsRef.current.find(row => row.group && row.conversationId === conversationId);
      if (group) {
        if (!readAt || !group.group!.memberIds.includes(readerId) || !Number.isFinite(Date.parse(readAt))) return;
        const next = conversationsRef.current.map(row => row.peerId !== group.peerId ||
          Date.parse(row.readByMember?.[readerId] ?? '') >= Date.parse(readAt) ? row : {
            ...row, readByMember: { ...row.readByMember, [readerId]: readAt },
          });
        conversationsRef.current = next;
        setConversations(next);
        return;
      }
      if (contradictsDirectConversation(readerId, conversationId)) return;
      commitMessageHistory(applyReadReceipt(messagesByPeerRef.current, {
        readerId, readAt, currentUserId: userId,
      }));
    },
    [commitMessageHistory, userId, contradictsDirectConversation],
  );

  const handleTypingEvent = useCallback(
    /** @param payload */
    ({ senderId, isTyping, conversationId }: { senderId?: string; isTyping?: boolean; conversationId?: string; }) => {
    if (!senderId) return;
      const group = conversationsRef.current.find(row => row.group && row.conversationId === conversationId);
      if (group) {
        if (group.left || senderId === userId || !group.group!.memberIds.includes(senderId)) return;
        const key = JSON.stringify([conversationId, senderId]);
        clearTimeout(typingTimeoutsRef.current[key]);
        const update = (value: boolean) => setGroupTyping(prev => ({
          ...prev, [group.peerId]: { ...prev[group.peerId], [senderId]: value },
        }));
        update(Boolean(isTyping));
        if (isTyping) typingTimeoutsRef.current[key] = setTimeout(() => update(false), TYPING_INDICATOR_TIMEOUT_MS);
        return;
      }
      if (contradictsDirectConversation(senderId, conversationId)) return;
      clearTimeout(typingTimeoutsRef.current[senderId]);
      setTypingByPeer(prev => ({ ...prev, [senderId]: Boolean(isTyping) }));
      if (isTyping) {
        // Safety net: auto-clear if a "stopped typing" event never arrives.
        typingTimeoutsRef.current[senderId] = setTimeout(() => {
          setTypingByPeer(prev => ({ ...prev, [senderId]: false }));
        }, TYPING_INDICATOR_TIMEOUT_MS);
      }
    },
    [userId, contradictsDirectConversation],
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
      commitMessageHistory(applyTombstone(messagesByPeerRef.current, messageId, payload?.message ?? undefined));
      evictTombstonedAttachment(messageId);
    },
    [commitMessageHistory],
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
      commitMessageHistory(applyReactions(messagesByPeerRef.current, messageId, reactions));
    },
    [commitMessageHistory],
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
      if (!scope || scopeRef.current !== scope) return false;
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
        if (scopeRef.current !== scope) return false;
        handleMessageReaction({ messageId, reactions });
        return true;
      } catch (error) {
        logWarn('[Messaging] reactToMessage failed', { message: errorMessage(error) });
        updateStatus('Could not react to message', 'error');
        return false;
      }
    },
    [handleMessageReaction, signalingRef, socketRef, updateStatus, scope],
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
    void backfillMessages();
    const peer = activeChatPeerIdRef.current;
    if (peer) void fetchMessagesForPeer(peer);
  }, [backfillMessages, fetchMessagesForPeer]);

  /** The socket went down: drive the offline banner. */
  const handleSocketDisconnected = useCallback(() => {
    setIsSocketConnected(false);
    const disconnectedScope = scopeRef.current;
    if (!disconnectedScope) return;
    const persistLatest = () => {
      if (scopeRef.current !== disconnectedScope) return;
      const snapshot = {
        conversations: conversationsRef.current,
        messagesByPeer: messagesByPeerRef.current,
        socketCursors: socketCursorsRef.current,
      };
      persistChatSnapshotRef.current(snapshot);
    };
    const flush = () => {
      if (scopeRef.current !== disconnectedScope) return;
      void flushChatDb(disconnectedScope).catch(error => {
        logWarn('[Messaging] Failed to flush message cache on disconnect', {
          message: errorMessage(error),
        });
      });
    };
    const latest = {
      conversations: conversationsRef.current,
      messagesByPeer: messagesByPeerRef.current,
      socketCursors: socketCursorsRef.current,
    };
    if (persistChatSnapshotRef.current(latest)) {
      flush();
      return;
    }
    // Hydration can still be in flight if the socket drops immediately after
    // launch. Let it merge disk state with any live event refs before flushing.
    void loadChatSnapshot(disconnectedScope).then(() => {
      persistLatest();
      flush();
    }).catch(error => {
      logWarn('[Messaging] Failed to hydrate message cache on disconnect', {
        message: errorMessage(error),
      });
    });
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
    conversations: stateScope === scope ? conversations : [],
    messagesByPeer: stateScope === scope ? messagesByPeer : {},
    drafts: stateScope === scope ? drafts : {},
    saveDraft,
    clearDraft,
    activeChatPeerId,
    setActiveChatPeerId,
    typingByPeer,
    groupTyping,
    groupActions,
    groupPreviewActions,
    groupCalls,
    groupCallActions,
    unreadTotal: stateScope === scope ? unreadTotal : 0,
    // Only reported once the socket has told us either way, so the banner
    // never flashes during the first connect.
    isOffline: isSocketConnected === false,
    pendingSendCount: stateScope === scope ? pendingSendCount : 0,
    fetchConversations,
    fetchMessagesForPeer,
    backfillMessages,
    searchMessages,
    searchLocalMessages,
    isBackfillingMessages,
    backfilledMessageCount,
    recordCallActivity,
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
