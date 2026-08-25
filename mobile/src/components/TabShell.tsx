import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logError } from '../appLogger';
import { describeAttachmentDownloadResult, downloadAttachment } from '../attachmentDownload';
import { useCall } from '../call/CallProvider';
import { useChat } from '../chat/ChatProvider';
import AppNavigator from '../navigation/AppNavigator';
import useRecentSearches from '../hooks/useRecentSearches';
import {
  closeChatConversation,
  goBack,
  openChatConversation,
  openPeerProfile,
  openSearch,
  openTab,
  resetNavigation,
} from '../navigation/navigationRef';
import { clearNavigationState } from '../navigation/navigationState';
import { TABS } from '../navigation/routes';
import CallsScreen from './CallsScreen';
import ChatConversationScreen from './ChatConversationScreen';
import ChatListScreen from './ChatListScreen';
import PeerProfileScreen from './PeerProfileScreen';
import SearchScreen from './SearchScreen';
import SettingsScreen from './SettingsScreen';

/**
 * The bottom-tab shell (Chats / Calls / Settings) shown whenever no call takes
 * over the screen.  Purely wiring: every screen reads its data from the call
 * and chat contexts, so no state lives here.
 */
export default function TabShell() {
  const {
    callFlow,
    settings,
    handleAutoLightingToggle,
    handleSpeakerDefaultToggle,
    handleDeveloperModeToggle,
    handleIceTransportPolicyChange,
    minimizeCallOnNavigate,
    startAudioCallWith,
    startVideoCallWith,
    handleExportLogs,
  } = useCall();
  const chat = useChat();
  // Context methods are pulled out rather than invoked as `chat.sendMessage(…)`
  // or `callFlow.placeCall(…)`: `react-hooks/exhaustive-deps` treats a method
  // *call* as a use of the whole container, which is precisely the whole-object
  // dependency that would defeat the memoised renderers below (and the
  // `screenRenderers` memo in `AppNavigator` that depends on them).
  const {
    cancelRecordingVoiceNote,
    deleteMessage,
    isPeerMuted,
    isUserBlocked,
    pickAndSendAttachment,
    reactToMessage,
    retryMessage,
    sendMessage,
    sendTypingIndicator,
    setPeerMuted,
    startRecordingVoiceNote,
    stopRecordingVoiceNoteAndSend,
  } = chat;
  const { unregisterUser, updateStatus } = callFlow;
  const insets = useSafeAreaInsets();
  const { recentSearches, recordSearch, clearSearches } = useRecentSearches();

  const renderChatConversation = useCallback((peerId: string | null, { messageId }: { messageId?: string | null; } = {}) => {
    // A conversation route always carries its peer; without one there is
    // nothing to render (and every handler below would target no peer).
    if (!peerId) return null;
    return (
      <ChatConversationScreen
        peerId={peerId}
        messages={chat.messagesByPeer[peerId] ?? []}
        highlightMessageId={messageId ?? null}
        onOpenProfile={() => openPeerProfile(peerId)}
        onSendMessage={(body, options) => sendMessage(peerId, body, options)}
        onRetryMessage={message => retryMessage(peerId, message.messageId)}
        onDeleteMessage={message => deleteMessage(peerId, message.messageId)}
        onReactToMessage={(message, emoji, action) =>
          reactToMessage(peerId, message.messageId, emoji, action)
        }
        onDownloadAttachment={async message => {
          const result = await downloadAttachment({
            url: message?.attachment?.url,
            name: message?.attachment?.name,
            mimeType: message?.attachment?.mimeType,
          });
          updateStatus(
            describeAttachmentDownloadResult(result),
            result.success ? 'success' : 'error',
          );
        }}
        isOffline={chat.isChatOffline}
        onLoadOlder={chat.handleLoadOlderMessages}
        onBack={closeChatConversation}
        currentUserId={chat.currentUserId}
        peerPresence={chat.peerPresence}
        keyboardVerticalOffset={insets.top}
        onStartAudioCall={() => startAudioCallWith(peerId)}
        onStartVideoCall={() => startVideoCallWith(peerId)}
        onCallBack={startAudioCallWith}
        onVideoCallBack={startVideoCallWith}
        isStartingCall={callFlow.isPlacingCall}
        isPeerTyping={Boolean(chat.typingByPeer[peerId])}
        isLoadingMessages={chat.isLoadingMessages}
        onPickAttachment={kind => pickAndSendAttachment(peerId, kind)}
        onStartVoiceNote={() => startRecordingVoiceNote()}
        onStopVoiceNote={() => stopRecordingVoiceNoteAndSend(peerId)}
        onCancelVoiceNote={() => cancelRecordingVoiceNote()}
        isUploadingAttachment={chat.isUploadingAttachment}
        attachmentUploadProgress={chat.attachmentUploadProgress}
        isRecordingVoiceNote={chat.isRecordingVoiceNote}
        attachmentsAvailable={chat.attachmentsAvailable}
        isVoiceNoteSupported={chat.isVoiceNoteSupported}
        onTypingChange={isTyping => sendTypingIndicator(peerId, isTyping)}
      />
    );
  }, [
    callFlow.isPlacingCall,
    cancelRecordingVoiceNote,
    chat.attachmentUploadProgress,
    chat.attachmentsAvailable,
    chat.currentUserId,
    chat.handleLoadOlderMessages,
    chat.isChatOffline,
    chat.isLoadingMessages,
    chat.isRecordingVoiceNote,
    chat.isUploadingAttachment,
    chat.isVoiceNoteSupported,
    chat.messagesByPeer,
    chat.peerPresence,
    chat.typingByPeer,
    deleteMessage,
    insets.top,
    pickAndSendAttachment,
    reactToMessage,
    retryMessage,
    sendMessage,
    sendTypingIndicator,
    startAudioCallWith,
    startRecordingVoiceNote,
    startVideoCallWith,
    stopRecordingVoiceNoteAndSend,
    updateStatus,
  ]);

  const renderChatList = useCallback(() => (
    <ChatListScreen
      conversations={chat.conversations}
      onOpenConversation={openChatConversation}
      onSearchUsers={chat.searchUsers}
      onRefresh={chat.handleRefreshConversations}
      isRefreshing={chat.isRefreshingConversations}
      isLoading={chat.isLoadingConversations}
      onMarkRead={chat.markConversationRead}
      onOpenSearch={openSearch}
      onOpenProfile={openPeerProfile}
      onStartChat={openChatConversation}
      currentUserId={chat.currentUserId}
    />
  ), [
    chat.currentUserId,
    chat.conversations,
    chat.handleRefreshConversations,
    chat.isLoadingConversations,
    chat.isRefreshingConversations,
    chat.markConversationRead,
    chat.searchUsers,
  ]);

  const renderSearch = useCallback(() => (
    <SearchScreen
      onSearchContacts={chat.searchUsers}
      onSearchMessages={chat.searchMessages}
      conversations={chat.conversations}
      callHistory={callFlow.callHistory}
      currentUserId={chat.currentUserId}
      onOpenConversation={openChatConversation}
      onOpenMessage={({ peerId, messageId }) => openChatConversation(peerId, { messageId })}
      onOpenProfile={openPeerProfile}
      onBack={goBack}
      isServerUnreachable={callFlow.isServerUnreachable}
      recentSearches={recentSearches}
      onRecordRecentSearch={recordSearch}
      onClearRecentSearches={clearSearches}
    />
  ), [
    callFlow.callHistory,
    callFlow.isServerUnreachable,
    chat.conversations,
    chat.currentUserId,
    chat.searchMessages,
    chat.searchUsers,
    clearSearches,
    recentSearches,
    recordSearch,
  ]);

  /** @param peerId */
  const renderPeerProfile = useCallback((peerId: string | null) => {
    if (!peerId) return null;
    return (
      <PeerProfileScreen
        peerId={peerId}
        presence={chat.chatPeerId === peerId ? chat.peerPresence : null}
        isBlocked={Boolean(isUserBlocked?.(peerId))}
        isMuted={isPeerMuted(peerId)}
        callHistory={callFlow.callHistory}
        currentUserId={chat.currentUserId}
        onBack={goBack}
        onMessage={openChatConversation}
        onAudioCall={startAudioCallWith}
        onVideoCall={startVideoCallWith}
        onToggleMute={id => setPeerMuted(id, !isPeerMuted(id))}
        onBlock={chat.blockPeer}
        onUnblock={chat.unblockPeer}
      />
    );
  }, [
    callFlow.callHistory,
    chat.blockPeer,
    chat.chatPeerId,
    chat.currentUserId,
    chat.peerPresence,
    chat.unblockPeer,
    isPeerMuted,
    isUserBlocked,
    setPeerMuted,
    startAudioCallWith,
    startVideoCallWith,
  ]);

  const renderCalls = useCallback(() => (
    <CallsScreen
      callHistory={callFlow.callHistory}
      missedCallCount={callFlow.missedCallCount}
      onMarkMissedRead={callFlow.markMissedCallsRead}
      onOpenProfile={openPeerProfile}
      onAudioCall={startAudioCallWith}
      onVideoCall={startVideoCallWith}
      onOpenSearch={openSearch}
      onSearchUsers={callFlow.searchUsers}
      conversations={chat.conversations}
      isServerUnreachable={callFlow.isServerUnreachable}
      onRetryConnect={callFlow.retryPresenceConnect}
      status={callFlow.status}
    />
  ), [
    callFlow.callHistory,
    callFlow.isServerUnreachable,
    callFlow.markMissedCallsRead,
    callFlow.missedCallCount,
    callFlow.retryPresenceConnect,
    callFlow.searchUsers,
    callFlow.status,
    chat.conversations,
    startAudioCallWith,
    startVideoCallWith,
  ]);

  const renderSettings = useCallback(() => (
    <SettingsScreen
      userId={callFlow.userId}
      onSaveUserId={callFlow.updateUserId}
      signalingUrl={callFlow.signalingUrl}
      onSaveSignalingUrl={callFlow.setSignalingUrl}
      status={callFlow.status}
      onSignOut={() => {
        // Reset first, then clear: the reset's own state write can only ever
        // race with the clear as the (harmless) default route, never as the
        // signed-out user's open conversation.
        resetNavigation();
        clearNavigationState();
        unregisterUser().catch(error => {
          logError('unregisterUser failed', error);
        });
      }}
      onClose={() => openTab(TABS.CHATS)}
      onExportLogs={handleExportLogs}
      developerModeEnabled={settings.developerModeEnabled}
      onToggleDeveloperMode={handleDeveloperModeToggle}
      speakerDefaultEnabled={settings.speakerEnabledByDefault}
      onToggleSpeakerDefault={handleSpeakerDefaultToggle}
      autoLightingEnabled={settings.autoCameraLightingEnabled}
      onToggleAutoLighting={handleAutoLightingToggle}
      iceTransportPolicy={settings.iceTransportPolicy}
      onChangeIceTransportPolicy={handleIceTransportPolicyChange}
      messageNotificationsEnabled={chat.messageNotificationsEnabled}
      onToggleMessageNotifications={chat.setMessageNotificationsEnabled}
      mutedPeers={chat.mutedPeers}
      onUnmutePeer={peerId => setPeerMuted(peerId, false)}
      blockedUsers={chat.blockedUsers}
      onUnblockUser={chat.unblockPeer}
      onOpenProfile={openPeerProfile}
    />
  ), [
    callFlow.setSignalingUrl,
    callFlow.signalingUrl,
    callFlow.status,
    callFlow.updateUserId,
    callFlow.userId,
    chat.blockedUsers,
    chat.messageNotificationsEnabled,
    chat.mutedPeers,
    chat.setMessageNotificationsEnabled,
    chat.unblockPeer,
    handleAutoLightingToggle,
    handleDeveloperModeToggle,
    handleExportLogs,
    handleIceTransportPolicyChange,
    handleSpeakerDefaultToggle,
    setPeerMuted,
    settings.autoCameraLightingEnabled,
    settings.developerModeEnabled,
    settings.iceTransportPolicy,
    settings.speakerEnabledByDefault,
    unregisterUser,
  ]);

  return (
    <View style={styles.root} testID="app-tab-shell">
      <AppNavigator
        unreadCount={chat.unreadTotal}
        missedCallCount={callFlow.missedCallCount}
        bottomInset={insets.bottom}
        onTabPress={minimizeCallOnNavigate}
        onRouteChange={chat.handleRouteChange}
        renderChatList={renderChatList}
        renderChatConversation={renderChatConversation}
        renderSearch={renderSearch}
        renderPeerProfile={renderPeerProfile}
        renderCalls={renderCalls}
        renderSettings={renderSettings}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
