// @ts-check
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useCall } from '../call/CallProvider';
import useChatDeepLink from '../hooks/useChatDeepLink';
import useChatSync from '../hooks/useChatSync';
import { openChatConversation } from '../navigation/navigationRef';

export type CallFlow = ReturnType<typeof import('../call/CallProvider').useCall>['callFlow'];
export type ChatSync = ReturnType<typeof useChatSync>;
export type ShellRoute = ReturnType<typeof import('../navigation/routes').deriveShellRoute>;

export type ChatContextValue = { chatPeerId: string | null; handleRouteChange: (route: ShellRoute) => void; peerPresence: ChatSync['peerPresence']; isLoadingConversations: boolean; isLoadingMessages: boolean; isRefreshingConversations: boolean; handleRefreshConversations: ChatSync['handleRefreshConversations']; handleLoadOlderMessages: ChatSync['handleLoadOlderMessages']; conversations: CallFlow['conversations']; messagesByPeer: CallFlow['messagesByPeer']; typingByPeer: CallFlow['typingByPeer']; unreadTotal: CallFlow['unreadTotal']; currentUserId: CallFlow['userId']; sendMessage: CallFlow['sendMessage']; retryMessage: CallFlow['retryMessage']; deleteMessage: CallFlow['deleteMessage']; reactToMessage: CallFlow['reactToMessage']; isChatOffline: CallFlow['isChatOffline']; markConversationRead: CallFlow['markConversationRead']; sendTypingIndicator: CallFlow['sendTypingIndicator']; searchUsers: CallFlow['searchUsers']; searchMessages: CallFlow['searchMessages']; isUserBlocked: CallFlow['isUserBlocked']; blockPeer: CallFlow['blockPeer']; unblockPeer: CallFlow['unblockPeer']; pickAndSendAttachment: CallFlow['pickAndSendAttachment']; startRecordingVoiceNote: CallFlow['startRecordingVoiceNote']; stopRecordingVoiceNoteAndSend: CallFlow['stopRecordingVoiceNoteAndSend']; cancelRecordingVoiceNote: CallFlow['cancelRecordingVoiceNote']; isUploadingAttachment: CallFlow['isUploadingAttachment']; attachmentUploadProgress: CallFlow['attachmentUploadProgress']; isRecordingVoiceNote: CallFlow['isRecordingVoiceNote']; attachmentsAvailable: CallFlow['attachmentsAvailable']; isVoiceNoteSupported: CallFlow['isVoiceNoteSupported']; };
export type ChatContextValue = { chatPeerId: string | null; handleRouteChange: (route: ShellRoute) => void; peerPresence: ChatSync['peerPresence']; isLoadingConversations: boolean; isLoadingMessages: boolean; isRefreshingConversations: boolean; handleRefreshConversations: ChatSync['handleRefreshConversations']; handleLoadOlderMessages: ChatSync['handleLoadOlderMessages']; conversations: CallFlow['conversations']; messagesByPeer: CallFlow['messagesByPeer']; typingByPeer: CallFlow['typingByPeer']; unreadTotal: CallFlow['unreadTotal']; currentUserId: CallFlow['userId']; sendMessage: CallFlow['sendMessage']; retryMessage: CallFlow['retryMessage']; deleteMessage: CallFlow['deleteMessage']; reactToMessage: CallFlow['reactToMessage']; isChatOffline: CallFlow['isChatOffline']; markConversationRead: CallFlow['markConversationRead']; sendTypingIndicator: CallFlow['sendTypingIndicator']; searchUsers: CallFlow['searchUsers']; searchMessages: CallFlow['searchMessages']; isUserBlocked: CallFlow['isUserBlocked']; blockPeer: CallFlow['blockPeer']; unblockPeer: CallFlow['unblockPeer']; pickAndSendAttachment: CallFlow['pickAndSendAttachment']; startRecordingVoiceNote: CallFlow['startRecordingVoiceNote']; stopRecordingVoiceNoteAndSend: CallFlow['stopRecordingVoiceNoteAndSend']; cancelRecordingVoiceNote: CallFlow['cancelRecordingVoiceNote']; isUploadingAttachment: CallFlow['isUploadingAttachment']; attachmentUploadProgress: CallFlow['attachmentUploadProgress']; isRecordingVoiceNote: CallFlow['isRecordingVoiceNote']; attachmentsAvailable: CallFlow['attachmentsAvailable']; isVoiceNoteSupported: CallFlow['isVoiceNoteSupported']; };
export type ChatContextValue = { chatPeerId: string | null; handleRouteChange: (route: ShellRoute) => void; peerPresence: ChatSync['peerPresence']; isLoadingConversations: boolean; isLoadingMessages: boolean; isRefreshingConversations: boolean; handleRefreshConversations: ChatSync['handleRefreshConversations']; handleLoadOlderMessages: ChatSync['handleLoadOlderMessages']; conversations: CallFlow['conversations']; messagesByPeer: CallFlow['messagesByPeer']; typingByPeer: CallFlow['typingByPeer']; unreadTotal: CallFlow['unreadTotal']; currentUserId: CallFlow['userId']; sendMessage: CallFlow['sendMessage']; retryMessage: CallFlow['retryMessage']; deleteMessage: CallFlow['deleteMessage']; reactToMessage: CallFlow['reactToMessage']; isChatOffline: CallFlow['isChatOffline']; markConversationRead: CallFlow['markConversationRead']; sendTypingIndicator: CallFlow['sendTypingIndicator']; searchUsers: CallFlow['searchUsers']; searchMessages: CallFlow['searchMessages']; isUserBlocked: CallFlow['isUserBlocked']; blockPeer: CallFlow['blockPeer']; unblockPeer: CallFlow['unblockPeer']; pickAndSendAttachment: CallFlow['pickAndSendAttachment']; startRecordingVoiceNote: CallFlow['startRecordingVoiceNote']; stopRecordingVoiceNoteAndSend: CallFlow['stopRecordingVoiceNoteAndSend']; cancelRecordingVoiceNote: CallFlow['cancelRecordingVoiceNote']; isUploadingAttachment: CallFlow['isUploadingAttachment']; attachmentUploadProgress: CallFlow['attachmentUploadProgress']; isRecordingVoiceNote: CallFlow['isRecordingVoiceNote']; attachmentsAvailable: CallFlow['attachmentsAvailable']; isVoiceNoteSupported: CallFlow['isVoiceNoteSupported']; };
export type ChatContextValue = { chatPeerId: string | null; handleRouteChange: (route: ShellRoute) => void; peerPresence: ChatSync['peerPresence']; isLoadingConversations: boolean; isLoadingMessages: boolean; isRefreshingConversations: boolean; handleRefreshConversations: ChatSync['handleRefreshConversations']; handleLoadOlderMessages: ChatSync['handleLoadOlderMessages']; conversations: CallFlow['conversations']; messagesByPeer: CallFlow['messagesByPeer']; typingByPeer: CallFlow['typingByPeer']; unreadTotal: CallFlow['unreadTotal']; currentUserId: CallFlow['userId']; sendMessage: CallFlow['sendMessage']; retryMessage: CallFlow['retryMessage']; deleteMessage: CallFlow['deleteMessage']; reactToMessage: CallFlow['reactToMessage']; isChatOffline: CallFlow['isChatOffline']; markConversationRead: CallFlow['markConversationRead']; sendTypingIndicator: CallFlow['sendTypingIndicator']; searchUsers: CallFlow['searchUsers']; searchMessages: CallFlow['searchMessages']; isUserBlocked: CallFlow['isUserBlocked']; blockPeer: CallFlow['blockPeer']; unblockPeer: CallFlow['unblockPeer']; pickAndSendAttachment: CallFlow['pickAndSendAttachment']; startRecordingVoiceNote: CallFlow['startRecordingVoiceNote']; stopRecordingVoiceNoteAndSend: CallFlow['stopRecordingVoiceNoteAndSend']; cancelRecordingVoiceNote: CallFlow['cancelRecordingVoiceNote']; isUploadingAttachment: CallFlow['isUploadingAttachment']; attachmentUploadProgress: CallFlow['attachmentUploadProgress']; isRecordingVoiceNote: CallFlow['isRecordingVoiceNote']; attachmentsAvailable: CallFlow['attachmentsAvailable']; isVoiceNoteSupported: CallFlow['isVoiceNoteSupported']; };

const ChatContext = createContext(/** @type {ChatContextValue | null} */ (null));

/**
 * Owns the chat side of the app: which conversation the Chats tab currently
 * has open, keeping the call flow's chat state in sync with it, and the
 * message-notification deep link.
 *
 * React Navigation owns the routing; the `chatPeerId` mirror here is only the
 * part of it the chat-sync hook has to react to, and it lives in this provider
 * rather than in `AppShell` so the shell stays a purely presentational router.
 *
 * @param {{ children: import('react').ReactNode }} props
 */
export function ChatProvider({ children }: { children: import('react').ReactNode; }) {
  const { callFlow } = useCall();
  const [chatPeerId, setChatPeerId] = useState(/** @type {string | null} */ (null));

  /** @type {(route: ShellRoute) => void} */
  const handleRouteChange: (route: ShellRoute) => void = useCallback(route => {
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
      reactToMessage: callFlow.reactToMessage,
      isChatOffline: callFlow.isChatOffline,
      markConversationRead: callFlow.markConversationRead,
      sendTypingIndicator: callFlow.sendTypingIndicator,
      searchUsers: callFlow.searchUsers,
      searchMessages: callFlow.searchMessages,
      isUserBlocked: callFlow.isUserBlocked,
      blockPeer: callFlow.blockPeer,
      unblockPeer: callFlow.unblockPeer,
      pickAndSendAttachment: callFlow.pickAndSendAttachment,
      startRecordingVoiceNote: callFlow.startRecordingVoiceNote,
      stopRecordingVoiceNoteAndSend: callFlow.stopRecordingVoiceNoteAndSend,
      cancelRecordingVoiceNote: callFlow.cancelRecordingVoiceNote,
      isUploadingAttachment: callFlow.isUploadingAttachment,
      attachmentUploadProgress: callFlow.attachmentUploadProgress,
      isRecordingVoiceNote: callFlow.isRecordingVoiceNote,
      attachmentsAvailable: callFlow.attachmentsAvailable,
      isVoiceNoteSupported: callFlow.isVoiceNoteSupported,
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
      callFlow.reactToMessage,
      callFlow.sendMessage,
      callFlow.sendTypingIndicator,
      callFlow.typingByPeer,
      callFlow.unreadTotal,
      callFlow.userId,
      callFlow.pickAndSendAttachment,
      callFlow.startRecordingVoiceNote,
      callFlow.stopRecordingVoiceNoteAndSend,
      callFlow.cancelRecordingVoiceNote,
      callFlow.isUploadingAttachment,
      callFlow.attachmentUploadProgress,
      callFlow.isRecordingVoiceNote,
      callFlow.attachmentsAvailable,
      callFlow.isVoiceNoteSupported,
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
 * @returns {ChatContextValue} the value published by {@link ChatProvider}
 */
export function useChat(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
}
