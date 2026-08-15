import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { logWarn } from '../appLogger';
import { emitWithAck, SIGNALING_VERSION } from '../socketProtocol';

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
 *   socketRef: { current: import('socket.io-client').Socket | null },
 *   userId: string,
 *   updateStatus: (message: string, severity?: string) => void,
 * }} params
 */
export default function useMessaging({
  authedFetchRef,
  sessionIdRef,
  signalingUrl,
  socketRef,
  userId,
  updateStatus,
}) {
  // One entry per conversation the user participates in: { conversationId,
  // peerId, lastMessage, unreadCount }, newest-activity first.
  const [conversations, setConversations] = useState([]);
  // Keyed by peerId → array of message objects, newest-first (matches the
  // server's ordering). Optimistic (pending/failed) sends are tagged inline.
  const [messagesByPeer, setMessagesByPeer] = useState({});
  // peerId of the conversation currently open in the UI, or null. Drives
  // auto-mark-read for incoming messages from that peer.
  const [activeChatPeerId, setActiveChatPeerId] = useState(null);
  // Keyed by peerId → boolean. True while that peer is actively typing in the
  // open conversation (relayed via the ephemeral `message.typing` socket
  // event). Cleared on receipt of isTyping:false or after a short timeout, in
  // case a "stopped typing" event is dropped.
  const [typingByPeer, setTypingByPeer] = useState({});
  const typingTimeoutsRef = useRef({});
  const typingSentAtRef = useRef({});
  // Mirrors activeChatPeerId so the message.received socket handler never
  // reads a stale value through a captured closure.
  const activeChatPeerIdRef = useRef(null);

  useEffect(() => {
    activeChatPeerIdRef.current = activeChatPeerId;
  }, [activeChatPeerId]);

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
      const response = await authedFetchRef.current?.(sid => ({
        url: `${trimmedUrl}/conversations?sessionId=${encodeURIComponent(sid)}`,
      }));
      if (!response?.ok) return;
      const data = await response.json();
      if (!Array.isArray(data.conversations)) return;
      setConversations(data.conversations);
    } catch (error) {
      logWarn('[Messaging] fetchConversations failed', {
        message: error?.message,
      });
    }
  }, [authedFetchRef, sessionIdRef, signalingUrl]);

  /**
   * Fetch a page of message history with `peerId` (`GET /messages`) and merge
   * it into `messagesByPeer`.  Pass `{ before }` (an ISO cursor, the oldest
   * held message's `createdAt`) to page further back; omit it for the first
   * page, which replaces any existing entry for that peer.
   *
   * @param {string} peerId
   * @param {{ before?: string }} [options]
   * @returns {Promise<Array>} the fetched page (empty on failure)
   */
  const fetchMessagesForPeer = useCallback(
    async (peerId, { before } = {}) => {
      const trimmedPeerId = (peerId ?? '').trim();
      const sessionId = sessionIdRef.current;
      if (!sessionId || !trimmedPeerId) return [];
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.(sid => {
          const params = new URLSearchParams({
            sessionId: sid,
            peerId: trimmedPeerId,
          });
          if (before) params.set('before', before);
          return { url: `${trimmedUrl}/messages?${params.toString()}` };
        });
        if (!response?.ok) return [];
        const data = await response.json();
        const messages = Array.isArray(data.messages) ? data.messages : [];
        setMessagesByPeer(prev => {
          const existing = prev[trimmedPeerId] ?? [];
          if (!before) {
            return { ...prev, [trimmedPeerId]: messages };
          }
          // Pagination: append older messages, deduping by messageId.
          const existingIds = new Set(existing.map(m => m.messageId));
          const merged = [...existing, ...messages.filter(m => !existingIds.has(m.messageId))];
          return { ...prev, [trimmedPeerId]: merged };
        });
        return messages;
      } catch (error) {
        logWarn('[Messaging] fetchMessagesForPeer failed', {
          message: error?.message,
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
    async peerId => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId) return;
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.(sid => ({
          url: `${trimmedUrl}/messages/read`,
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
          message: error?.message,
        });
      }
    },
    [authedFetchRef, signalingUrl],
  );

  /**
   * Send a chat message to `peerId`, appending an optimistic (pending) local
   * copy immediately and reconciling it with the server-confirmed message (or
   * marking it failed) once `message.send` acks.
   *
   * @param {string} peerId
   * @param {string} body
   */
  const sendMessage = useCallback(
    async (peerId, body) => {
      const trimmedPeerId = (peerId ?? '').trim();
      const trimmedBody = (body ?? '').trim();
      if (!trimmedPeerId || !trimmedBody) return;

      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const optimisticMessage = {
        messageId: tempId,
        conversationId: null,
        senderId: userId,
        recipientId: trimmedPeerId,
        body: trimmedBody,
        createdAt: new Date().toISOString(),
        deliveredTo: [],
        readAt: null,
        pending: true,
      };

      setMessagesByPeer(prev => ({
        ...prev,
        [trimmedPeerId]: [optimisticMessage, ...(prev[trimmedPeerId] ?? [])],
      }));

      const markFailed = () => {
        setMessagesByPeer(prev => ({
          ...prev,
          [trimmedPeerId]: (prev[trimmedPeerId] ?? []).map(m =>
            m.messageId === tempId ? { ...m, pending: false, failed: true } : m,
          ),
        }));
        updateStatus('Message failed to send', 'error');
      };

      if (!socketRef.current?.connected) {
        markFailed();
        return;
      }

      try {
        const ack = await emitWithAck(socketRef.current, 'message.send', {
          version: SIGNALING_VERSION,
          recipientId: trimmedPeerId,
          body: trimmedBody,
        });
        const confirmed = ack?.message;
        setMessagesByPeer(prev => ({
          ...prev,
          [trimmedPeerId]: (prev[trimmedPeerId] ?? []).map(m =>
            m.messageId === tempId ? { ...(confirmed ?? m), pending: false } : m,
          ),
        }));
      } catch (error) {
        logWarn('[Messaging] sendMessage failed', { message: error?.message });
        markFailed();
      }
    },
    [socketRef, userId, updateStatus],
  );

  /**
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
    (peerId, isTyping) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId) return;
      const socket = socketRef.current;
      if (!socket?.connected) return;

      const now = Date.now();
      if (isTyping) {
        const lastSentAt = typingSentAtRef.current[trimmedPeerId] ?? 0;
        if (now - lastSentAt < TYPING_INDICATOR_THROTTLE_MS) return;
      }
      typingSentAtRef.current[trimmedPeerId] = now;

      socket.emit('message.typing', {
        version: SIGNALING_VERSION,
        recipientId: trimmedPeerId,
        isTyping: Boolean(isTyping),
      });
    },
    [socketRef],
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
    message => {
      if (!message?.senderId) return;
      const senderId = message.senderId;

      setMessagesByPeer(prev => {
        const existing = prev[senderId] ?? [];
        if (existing.some(m => m.messageId === message.messageId)) {
          return prev;
        }
        return { ...prev, [senderId]: [message, ...existing] };
      });

      if (activeChatPeerIdRef.current === senderId) {
        // The conversation is currently open: auto-mark-read, no unread bump.
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
          unreadCount: (next[index].unreadCount || 0) + 1,
        };
        return next;
      });
    },
    [fetchConversations, markConversationRead],
  );

  const handleMessageDelivered = useCallback(message => {
    if (!message?.recipientId) return;
    const peerId = message.recipientId;
    setMessagesByPeer(prev => {
      const existing = prev[peerId] ?? [];
      if (existing.some(m => m.messageId === message.messageId)) {
        return prev;
      }
      return { ...prev, [peerId]: [message, ...existing] };
    });
  }, []);

  const handleMessageRead = useCallback(
    ({ readerId, readAt }) => {
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

  const handleTypingEvent = useCallback(({ senderId, isTyping }) => {
    if (!senderId) return;
    clearTimeout(typingTimeoutsRef.current[senderId]);
    setTypingByPeer(prev => ({ ...prev, [senderId]: Boolean(isTyping) }));
    if (isTyping) {
      // Safety net: auto-clear if a "stopped typing" event never arrives.
      typingTimeoutsRef.current[senderId] = setTimeout(() => {
        setTypingByPeer(prev => ({ ...prev, [senderId]: false }));
      }, TYPING_INDICATOR_TIMEOUT_MS);
    }
  }, []);

  return {
    conversations,
    messagesByPeer,
    activeChatPeerId,
    setActiveChatPeerId,
    typingByPeer,
    unreadTotal,
    fetchConversations,
    fetchMessagesForPeer,
    sendMessage,
    markConversationRead,
    sendTypingIndicator,
    resetTypingState,
    handleMessageReceived,
    handleMessageDelivered,
    handleMessageRead,
    handleTypingEvent,
  };
}
