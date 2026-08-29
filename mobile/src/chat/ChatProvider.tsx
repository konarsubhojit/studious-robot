import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useCall } from '../call/CallProvider';
import useChatDeepLink from '../hooks/useChatDeepLink';
import useChatSync from '../hooks/useChatSync';
import useNotificationPreferences from '../hooks/useNotificationPreferences';
import { openChatConversation } from '../navigation/navigationRef';
import type { ReactNode } from 'react';
import type { deriveShellRoute } from '../navigation/routes';

export type CallFlow = ReturnType<typeof useCall>['callFlow'];
export type ChatSync = ReturnType<typeof useChatSync>;
export type NotificationPreferences = ReturnType<typeof useNotificationPreferences>;
export type ShellRoute = ReturnType<typeof deriveShellRoute>;

export type ChatContextValue = {
  chatPeerId: string | null;
  handleRouteChange: (route: ShellRoute) => void;
  peerPresence: ChatSync['peerPresence'];
  isLoadingConversations: boolean;
  isLoadingMessages: boolean;
  isRefreshingConversations: boolean;
  handleRefreshConversations: ChatSync['handleRefreshConversations'];
  handleLoadOlderMessages: ChatSync['handleLoadOlderMessages'];
  conversations: CallFlow['conversations'];
  messagesByPeer: CallFlow['messagesByPeer'];
  drafts: CallFlow['drafts'];
  saveDraft: CallFlow['saveDraft'];
  clearDraft: CallFlow['clearDraft'];
  typingByPeer: CallFlow['typingByPeer'];
  unreadTotal: CallFlow['unreadTotal'];
  currentUserId: CallFlow['userId'];
  sendMessage: CallFlow['sendMessage'];
  retryMessage: CallFlow['retryMessage'];
  deleteMessage: CallFlow['deleteMessage'];
  reactToMessage: CallFlow['reactToMessage'];
  isChatOffline: CallFlow['isChatOffline'];
  markConversationRead: CallFlow['markConversationRead'];
  sendTypingIndicator: CallFlow['sendTypingIndicator'];
  searchUsers: CallFlow['searchUsers'];
  searchMessages: CallFlow['searchMessages'];
  isUserBlocked: CallFlow['isUserBlocked'];
  blockedUsers: CallFlow['blockedUsers'];
  blockPeer: CallFlow['blockPeer'];
  unblockPeer: CallFlow['unblockPeer'];
  // Mute sits beside block deliberately: both are relationship-level decisions
  // about one person, and the person hub offers them as one pair.
  mutedPeers: NotificationPreferences['mutedPeers'];
  isPeerMuted: NotificationPreferences['isPeerMuted'];
  setPeerMuted: NotificationPreferences['setPeerMuted'];
  messageNotificationsEnabled: NotificationPreferences['messageNotificationsEnabled'];
  setMessageNotificationsEnabled: NotificationPreferences['setMessageNotificationsEnabled'];
  pickAndSendAttachment: CallFlow['pickAndSendAttachment'];
  startRecordingVoiceNote: CallFlow['startRecordingVoiceNote'];
  stopRecordingVoiceNoteAndSend: CallFlow['stopRecordingVoiceNoteAndSend'];
  cancelRecordingVoiceNote: CallFlow['cancelRecordingVoiceNote'];
  cancelAttachmentUpload: CallFlow['cancelAttachmentUpload'];
  isUploadingAttachment: CallFlow['isUploadingAttachment'];
  attachmentUploadProgress: CallFlow['attachmentUploadProgress'];
  isRecordingVoiceNote: CallFlow['isRecordingVoiceNote'];
  attachmentsAvailable: CallFlow['attachmentsAvailable'];
  isVoiceNoteSupported: CallFlow['isVoiceNoteSupported'];
};

const ChatContext = createContext((null as ChatContextValue | null));

/**
 * Owns the chat side of the app: which conversation the Chats tab currently
 * has open, keeping the call flow's chat state in sync with it, and the
 * message-notification deep link.
 *
 * React Navigation owns the routing; the `chatPeerId` mirror here is only the
 * part of it the chat-sync hook has to react to, and it lives in this provider
 * rather than in `AppShell` so the shell stays a purely presentational router.
 */
export function ChatProvider({ children }: { children: ReactNode; }) {
  const { callFlow } = useCall();
  const [chatPeerId, setChatPeerId] = useState((null as string | null));

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

  const {
    mutedPeers,
    isPeerMuted,
    setPeerMuted,
    messageNotificationsEnabled,
    setMessageNotificationsEnabled,
  } = useNotificationPreferences();

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
      drafts: callFlow.drafts,
      saveDraft: callFlow.saveDraft,
      clearDraft: callFlow.clearDraft,
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
      blockedUsers: callFlow.blockedUsers,
      blockPeer: callFlow.blockPeer,
      unblockPeer: callFlow.unblockPeer,
      mutedPeers,
      isPeerMuted,
      setPeerMuted,
      messageNotificationsEnabled,
      setMessageNotificationsEnabled,
      pickAndSendAttachment: callFlow.pickAndSendAttachment,
      startRecordingVoiceNote: callFlow.startRecordingVoiceNote,
      stopRecordingVoiceNoteAndSend: callFlow.stopRecordingVoiceNoteAndSend,
      cancelRecordingVoiceNote: callFlow.cancelRecordingVoiceNote,
      cancelAttachmentUpload: callFlow.cancelAttachmentUpload,
      isUploadingAttachment: callFlow.isUploadingAttachment,
      attachmentUploadProgress: callFlow.attachmentUploadProgress,
      isRecordingVoiceNote: callFlow.isRecordingVoiceNote,
      attachmentsAvailable: callFlow.attachmentsAvailable,
      isVoiceNoteSupported: callFlow.isVoiceNoteSupported,
    }),
    [
      callFlow.blockPeer,
      callFlow.blockedUsers,
      callFlow.conversations,
      callFlow.isUserBlocked,
      callFlow.searchMessages,
      callFlow.unblockPeer,
      callFlow.messagesByPeer,
      callFlow.drafts,
      callFlow.saveDraft,
      callFlow.clearDraft,
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
      callFlow.cancelAttachmentUpload,
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
      messageNotificationsEnabled,
      mutedPeers,
      isPeerMuted,
      peerPresence,
      setMessageNotificationsEnabled,
      setPeerMuted,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/**
 * Access the chat context.
 *
 * @returns the value published by {@link ChatProvider}
 */
export function useChat(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
}
