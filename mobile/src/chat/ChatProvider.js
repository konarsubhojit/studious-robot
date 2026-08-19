import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useCall } from '../call/CallProvider';
import useChatDeepLink from '../hooks/useChatDeepLink';
import useChatSync from '../hooks/useChatSync';
import { openChatConversation } from '../navigation/navigationRef';

const ChatContext = createContext(null);

/**
 * Owns the chat side of the app: which conversation the Chats tab currently
 * has open, keeping the call flow's chat state in sync with it, and the
 * message-notification deep link.
 *
 * React Navigation owns the routing; the `chatPeerId` mirror here is only the
 * part of it the chat-sync hook has to react to, and it lives in this provider
 * rather than in `AppShell` so the shell stays a purely presentational router.
 */
export function ChatProvider({ children }) {
  const { callFlow } = useCall();
  const [chatPeerId, setChatPeerId] = useState(null);

  const handleRouteChange = useCallback(route => {
    setChatPeerId(route.chatPeerId);
  }, []);

  const {
    peerPresence,
    isLoadingConversations,
    isLoadingMessages,
    isRefreshingConversations,
    handleRefreshConversations,
    handleLoadOlderMessages,
  } = useChatSync({
    chatPeerId,
    isRegistered: callFlow.isRegistered,
    messagesByPeer: callFlow.messagesByPeer,
    fetchConversations: callFlow.fetchConversations,
    setActiveChatPeerId: callFlow.setActiveChatPeerId,
    fetchMessagesForPeer: callFlow.fetchMessagesForPeer,
    markConversationRead: callFlow.markConversationRead,
    checkPresence: callFlow.checkPresence,
  });

  // Open the conversation a tapped message notification points at
  // (`wetalk://chat/{conversationId}`), including from a cold start. Routed
  // through the navigation container ref so the link opens a real route
  // (animated, restorable) instead of ad-hoc component state.
  useChatDeepLink({
    userId: callFlow.userId,
    conversations: callFlow.conversations,
    onOpenConversation: openChatConversation,
  });

  const value = useMemo(
    () => ({
      chatPeerId,
      handleRouteChange,
      peerPresence,
      isLoadingConversations,
      isLoadingMessages,
      isRefreshingConversations,
      handleRefreshConversations,
      handleLoadOlderMessages,
      conversations: callFlow.conversations,
      messagesByPeer: callFlow.messagesByPeer,
      typingByPeer: callFlow.typingByPeer,
      unreadTotal: callFlow.unreadTotal,
      currentUserId: callFlow.userId,
      sendMessage: callFlow.sendMessage,
      retryMessage: callFlow.retryMessage,
      deleteMessage: callFlow.deleteMessage,
      isChatOffline: callFlow.isChatOffline,
      markConversationRead: callFlow.markConversationRead,
      sendTypingIndicator: callFlow.sendTypingIndicator,
      searchUsers: callFlow.searchUsers,
      searchMessages: callFlow.searchMessages,
      isUserBlocked: callFlow.isUserBlocked,
      blockPeer: callFlow.blockPeer,
      unblockPeer: callFlow.unblockPeer,
    }),
    [
      callFlow.blockPeer,
      callFlow.conversations,
      callFlow.isUserBlocked,
      callFlow.searchMessages,
      callFlow.unblockPeer,
      callFlow.messagesByPeer,
      callFlow.searchUsers,
      callFlow.markConversationRead,
      callFlow.deleteMessage,
      callFlow.isChatOffline,
      callFlow.retryMessage,
      callFlow.sendMessage,
      callFlow.sendTypingIndicator,
      callFlow.typingByPeer,
      callFlow.unreadTotal,
      callFlow.userId,
      chatPeerId,
      handleLoadOlderMessages,
      handleRefreshConversations,
      handleRouteChange,
      isLoadingConversations,
      isLoadingMessages,
      isRefreshingConversations,
      peerPresence,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/**
 * Access the chat context.
 *
 * @returns {object} the value published by {@link ChatProvider}
 */
export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
}
