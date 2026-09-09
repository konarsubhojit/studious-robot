import { useCallback, useEffect, useState } from 'react';
import type { PeerPresence } from '../types/directory';

export type { PeerPresence };

/**
 * Owns text-chat wiring for the AppShell's Chats tab: fetching the
 * conversation list once identity is established, keeping `useCallFlow`'s
 * `activeChatPeerId` mirror in sync with the locally open conversation
 * (loading its history and marking it read), and tracking the presence of
 * the currently open conversation's peer.
 *
 * Extracted out of `AppShell` so this concern is independently testable and
 * the component itself stays focused on screen routing / composition.
 *
 * @param params
 */
export type UseChatSyncParams = {
  chatPeerId: string | null;
  isRegistered: boolean;
  messagesByPeer: Record<string, Array<{ createdAt?: string; messageId?: string; callId?: string; type?: string; }>>;
  fetchConversations: () => Promise<void>;
  setActiveChatPeerId: (peerId: string | null) => void;
  fetchMessagesForPeer: (peerId: string, options?: { before?: string; cursor?: import('../messaging/types').TimelineCursor | null; }) => Promise<unknown>;
  markConversationRead: (peerId: string) => Promise<void>;
  checkPresence: (peerId: string) => Promise<PeerPresence | null>;
};

function cursorFromOldest(
  entry: { createdAt?: string; messageId?: string; callId?: string; type?: string; } | undefined,
): import('../messaging/types').TimelineCursor | null {
  if (!entry?.createdAt) return null;
  if (entry.type === 'call' && entry.callId) {
    return { before: entry.createdAt, beforeType: 'call', beforeCallId: entry.callId };
  }
  if (entry.messageId) {
    return { before: entry.createdAt, beforeType: 'message', beforeMessageId: entry.messageId };
  }
  return { before: entry.createdAt };
}

export default function useChatSync({
  chatPeerId,
  isRegistered,
  messagesByPeer,
  fetchConversations,
  setActiveChatPeerId,
  fetchMessagesForPeer,
  markConversationRead,
  checkPresence,
}: UseChatSyncParams) {
  // Presence snapshot for the currently open conversation's peer.
  const [peerPresence, setPeerPresence] = useState(
    (null as PeerPresence | null),
  );
  const [isRefreshingConversations, setIsRefreshingConversations] = useState(false);
  // True while the very first conversation-list / message-history fetch is in
  // flight, so the screens can show skeleton placeholders instead of an
  // "empty" state that is really just "not loaded yet".
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false);

  // Fetch the conversation list once identity is established.
  useEffect(() => {
    if (!isRegistered) return undefined;
    let cancelled = false;
    setIsLoadingConversations(true);
    // `catch` before `finally` so a rejected fetch clears the flag instead of
    // leaving the skeleton up behind an unhandled rejection.
    Promise.resolve(fetchConversations())
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIsLoadingConversations(false);
      });
    return () => {
      cancelled = true;
    };
    // Only re-run when registration status flips; fetchConversations is
    // stable for a given signalingUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRegistered]);

  // Keep the hook's activeChatPeerId mirror in sync with the locally open
  // conversation, and load history + mark it read whenever one is opened.
  useEffect(() => {
    setActiveChatPeerId(chatPeerId);
    let cancelled = false;
    if (chatPeerId) {
      setIsLoadingMessages(true);
      Promise.resolve(fetchMessagesForPeer(chatPeerId))
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setIsLoadingMessages(false);
        });
      markConversationRead(chatPeerId);
    } else {
      setIsLoadingMessages(false);
    }
    return () => {
      cancelled = true;
      setActiveChatPeerId(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatPeerId]);

  // Fetch presence for the peer of the currently open conversation.
  useEffect(() => {
    let cancelled = false;
    if (!chatPeerId) {
      setPeerPresence(null);
      return undefined;
    }
    checkPresence(chatPeerId).then(presence => {
      if (!cancelled) setPeerPresence(presence);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatPeerId]);

  const handleRefreshConversations = useCallback(async () => {
    setIsRefreshingConversations(true);
    try {
      await fetchConversations();
    } finally {
      setIsRefreshingConversations(false);
    }
  }, [fetchConversations]);

  const handleRefreshMessages = useCallback(async () => {
    if (!chatPeerId) return;
    setIsRefreshingMessages(true);
    try {
      await fetchMessagesForPeer(chatPeerId);
      await markConversationRead(chatPeerId);
    } finally {
      setIsRefreshingMessages(false);
    }
  }, [chatPeerId, fetchMessagesForPeer, markConversationRead]);

  const handleLoadOlderMessages = useCallback(() => {
    if (!chatPeerId) return;
    const existing = messagesByPeer[chatPeerId] ?? [];
    const oldest = existing[existing.length - 1];
    const cursor = cursorFromOldest(oldest);
    if (cursor) {
      fetchMessagesForPeer(chatPeerId, { cursor });
    }
  }, [chatPeerId, messagesByPeer, fetchMessagesForPeer]);

  return {
    peerPresence,
    isLoadingConversations,
    isLoadingMessages,
    isRefreshingConversations,
    isRefreshingMessages,
    handleRefreshConversations,
    handleRefreshMessages,
    handleLoadOlderMessages,
  };
}
