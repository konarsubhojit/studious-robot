import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logError } from '../appLogger';
import { describeAttachmentDownloadResult, downloadAttachment } from '../attachmentDownload';
import { useCallSelector } from '../call/CallProvider';
import { useChat } from '../chat/ChatProvider';
import AppNavigator from '../navigation/AppNavigator';
import { alertStatus } from './StatusToast';
import useRecentSearches from '../hooks/useRecentSearches';
import useStorageUsage from '../hooks/useStorageUsage';
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
import type { CallContextValue } from '../call/CallProvider';

/**
 * The fields of the call snapshot this shell reads.
 *
 * Declared at module scope and selected as one slice so the shell — and with it
 * every tab screen below it — re-renders when one of *these* changes and not
 * when the call's timer, connection stats or recovery attempts do.
 *
 * @param state the call snapshot
 * @returns the tab shell's slice of it
 */
const selectTabShellSlice = (state: CallContextValue) => ({
  accountEmail: state.callFlow.accountEmail,
  accountProviderId: state.callFlow.accountProviderId,
  callHistory: state.callFlow.callHistory,
  fetchCallHistory: state.callFlow.fetchCallHistory,
  isPlacingCall: state.callFlow.isPlacingCall,
  isServerUnreachable: state.callFlow.isServerUnreachable,
  markMissedCallsRead: state.callFlow.markMissedCallsRead,
  missedCallCount: state.callFlow.missedCallCount,
  retryPresenceConnect: state.callFlow.retryPresenceConnect,
  searchUsers: state.callFlow.searchUsers,
  setSignalingUrl: state.callFlow.setSignalingUrl,
  signalingUrl: state.callFlow.signalingUrl,
  status: state.callFlow.status,
  unregisterUser: state.callFlow.unregisterUser,
  updateStatus: state.callFlow.updateStatus,
  userId: state.callFlow.userId,
  settings: state.settings,
  handleAutoLightingToggle: state.handleAutoLightingToggle,
  handleDeveloperModeToggle: state.handleDeveloperModeToggle,
  handleExportLogs: state.handleExportLogs,
  handleHapticsToggle: state.handleHapticsToggle,
  handleIceTransportPolicyChange: state.handleIceTransportPolicyChange,
  handleSpeakerDefaultToggle: state.handleSpeakerDefaultToggle,
  minimizeCallOnNavigate: state.minimizeCallOnNavigate,
  startAudioCallWith: state.startAudioCallWith,
  startVideoCallWith: state.startVideoCallWith,
});

/**
 * The bottom-tab shell (Chats / Calls / Settings) shown whenever no call takes
 * over the screen.  Purely wiring: every screen reads its data from the call
 * and chat contexts, so no state lives here.
 */
function TabShell() {
  const {
    accountEmail,
    accountProviderId,
    callHistory,
    fetchCallHistory,
    isPlacingCall,
    isServerUnreachable,
    markMissedCallsRead,
    missedCallCount,
    retryPresenceConnect,
    searchUsers,
    setSignalingUrl,
    signalingUrl,
    status,
    unregisterUser,
    updateStatus,
    userId,
    settings,
    handleAutoLightingToggle,
    handleSpeakerDefaultToggle,
    handleDeveloperModeToggle,
    handleHapticsToggle,
    handleIceTransportPolicyChange,
    minimizeCallOnNavigate,
    startAudioCallWith,
    startVideoCallWith,
    handleExportLogs,
  } = useCallSelector(selectTabShellSlice);
  const chat = useChat();
  // Context methods are pulled out rather than invoked as `chat.sendMessage(…)`:
  // `react-hooks/exhaustive-deps` treats a method
  // *call* as a use of the whole container, which is precisely the whole-object
  // dependency that would defeat the memoised renderers below (and the
  // `screenRenderers` memo in `AppNavigator` that depends on them).
  const {
    cancelRecordingVoiceNote,
    cancelAttachmentUpload,
    clearDraft,
    deleteMessage,
    isPeerMuted,
    isUserBlocked,
    pickAndSendAttachment,
    reactToMessage,
    retryAttachmentUpload,
    retryMessage,
    saveDraft,
    sendMessage,
    sendTypingIndicator,
    setPeerMuted,
    startRecordingVoiceNote,
    stopRecordingVoiceNoteAndSend,
  } = chat;
  const insets = useSafeAreaInsets();
  const { recentSearches, recordSearch, clearSearches } = useRecentSearches();
  // Storage accounting is owned here rather than by the Settings screen, so the
  // screen stays presentational like every other one in this shell.
  const {
    storageUsage,
    isMeasuringStorage,
    isClearingMedia,
    refreshStorageUsage,
    clearCachedMedia,
  } = useStorageUsage({ onStatus: updateStatus });

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
        onRetryMessage={message => {
          if (message.uploadState === 'failed') {
            retryAttachmentUpload(peerId, message);
          } else {
            retryMessage(peerId, message.messageId);
          }
        }}
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
        isStartingCall={isPlacingCall}
        isPeerTyping={Boolean(chat.typingByPeer[peerId])}
        isLoadingMessages={chat.isLoadingMessages}
        onPickAttachment={kind => pickAndSendAttachment(peerId, kind)}
        onStartVoiceNote={() => startRecordingVoiceNote()}
        onStopVoiceNote={() => stopRecordingVoiceNoteAndSend(peerId)}
        onCancelVoiceNote={() => cancelRecordingVoiceNote()}
        onCancelAttachmentUpload={cancelAttachmentUpload}
        isUploadingAttachment={chat.isUploadingAttachment}
        attachmentUploadProgress={chat.attachmentUploadProgress}
        isRecordingVoiceNote={chat.isRecordingVoiceNote}
        attachmentsAvailable={chat.attachmentsAvailable}
        isVoiceNoteSupported={chat.isVoiceNoteSupported}
        onTypingChange={isTyping => sendTypingIndicator(peerId, isTyping)}
        unreadCount={
          chat.conversations?.find(entry => entry?.peerId === peerId)?.unreadCount ?? 0
        }
        initialDraft={chat.drafts?.[peerId] ?? null}
        onSaveDraft={(text, replyToId) => saveDraft(peerId, text, replyToId)}
        onClearDraft={() => clearDraft(peerId)}
      />
    );
  }, [
    cancelAttachmentUpload,
    cancelRecordingVoiceNote,
    chat.attachmentUploadProgress,
    chat.attachmentsAvailable,
    chat.conversations,
    chat.currentUserId,
    chat.handleLoadOlderMessages,
    chat.isChatOffline,
    chat.isLoadingMessages,
    chat.isRecordingVoiceNote,
    chat.isUploadingAttachment,
    chat.isVoiceNoteSupported,
    chat.drafts,
    chat.messagesByPeer,
    chat.peerPresence,
    chat.typingByPeer,
    clearDraft,
    deleteMessage,
    insets.top,
    isPlacingCall,
    pickAndSendAttachment,
    reactToMessage,
    retryAttachmentUpload,
    retryMessage,
    saveDraft,
    sendMessage,
    sendTypingIndicator,
    startAudioCallWith,
    startRecordingVoiceNote,
    startVideoCallWith,
    stopRecordingVoiceNoteAndSend,
    updateStatus,
  ]);

  // Narrowed and memoised on its parts, not on the status object: `status` is
  // rewritten throughout a call ("Calling bob…", "Connected"), none of which
  // this bar shows, and taking the raw value as a prop re-rendered the whole
  // chat list for each one.
  const alert = alertStatus(status);
  const alertMessage = alert?.message;
  const alertSeverity = alert?.severity;
  const chatAlert = useMemo(
    () => (alertMessage ? { message: alertMessage, severity: alertSeverity } : undefined),
    [alertMessage, alertSeverity],
  );

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
      drafts={chat.drafts}
      isPeerMuted={isPeerMuted}
      onSetPeerMuted={setPeerMuted}
      status={chatAlert}
    />
  ), [
    chat.currentUserId,
    chat.conversations,
    chat.drafts,
    isPeerMuted,
    setPeerMuted,
    chat.handleRefreshConversations,
    chat.isLoadingConversations,
    chat.isRefreshingConversations,
    chat.markConversationRead,
    chat.searchUsers,
    chatAlert,
  ]);

  const renderSearch = useCallback(() => (
    <SearchScreen
      onSearchContacts={chat.searchUsers}
      onSearchMessages={chat.searchMessages}
      conversations={chat.conversations}
      callHistory={callHistory}
      currentUserId={chat.currentUserId}
      onOpenConversation={openChatConversation}
      onOpenMessage={({ peerId, messageId }) => openChatConversation(peerId, { messageId })}
      onOpenProfile={openPeerProfile}
      onBack={goBack}
      isServerUnreachable={isServerUnreachable}
      recentSearches={recentSearches}
      onRecordRecentSearch={recordSearch}
      onClearRecentSearches={clearSearches}
    />
  ), [
    callHistory,
    chat.conversations,
    chat.currentUserId,
    chat.searchMessages,
    chat.searchUsers,
    clearSearches,
    isServerUnreachable,
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
        callHistory={callHistory}
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
    callHistory,
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
      callHistory={callHistory}
      missedCallCount={missedCallCount}
      onFetchCallHistory={fetchCallHistory}
      onMarkMissedRead={markMissedCallsRead}
      onOpenProfile={openPeerProfile}
      onMessage={openChatConversation}
      onAudioCall={startAudioCallWith}
      onVideoCall={startVideoCallWith}
      onOpenSearch={openSearch}
      onSearchUsers={searchUsers}
      conversations={chat.conversations}
      isServerUnreachable={isServerUnreachable}
      onRetryConnect={retryPresenceConnect}
      status={status}
    />
  ), [
    callHistory,
    fetchCallHistory,
    isServerUnreachable,
    markMissedCallsRead,
    missedCallCount,
    retryPresenceConnect,
    searchUsers,
    status,
    chat.conversations,
    startAudioCallWith,
    startVideoCallWith,
  ]);

  const renderSettings = useCallback(() => (
    <SettingsScreen
      userId={userId}
      accountEmail={accountEmail}
      accountProviderId={accountProviderId}
      signalingUrl={signalingUrl}
      onSaveSignalingUrl={setSignalingUrl}
      status={status}
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
      storageUsage={storageUsage}
      onRefreshStorage={refreshStorageUsage}
      onClearCachedMedia={clearCachedMedia}
      isMeasuringStorage={isMeasuringStorage}
      isClearingMedia={isClearingMedia}
      developerModeEnabled={settings.developerModeEnabled}
      onToggleDeveloperMode={handleDeveloperModeToggle}
      speakerDefaultEnabled={settings.speakerEnabledByDefault}
      onToggleSpeakerDefault={handleSpeakerDefaultToggle}
      autoLightingEnabled={settings.autoCameraLightingEnabled}
      onToggleAutoLighting={handleAutoLightingToggle}
      hapticsEnabled={settings.hapticsEnabled}
      onToggleHaptics={handleHapticsToggle}
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
    accountEmail,
    accountProviderId,
    setSignalingUrl,
    signalingUrl,
    status,
    userId,
    chat.blockedUsers,
    chat.messageNotificationsEnabled,
    chat.mutedPeers,
    chat.setMessageNotificationsEnabled,
    chat.unblockPeer,
    clearCachedMedia,
    handleAutoLightingToggle,
    handleDeveloperModeToggle,
    handleExportLogs,
    handleHapticsToggle,
    handleIceTransportPolicyChange,
    handleSpeakerDefaultToggle,
    isClearingMedia,
    isMeasuringStorage,
    refreshStorageUsage,
    setPeerMuted,
    settings.autoCameraLightingEnabled,
    settings.developerModeEnabled,
    settings.hapticsEnabled,
    settings.iceTransportPolicy,
    settings.speakerEnabledByDefault,
    storageUsage,
    unregisterUser,
  ]);

  return (
    <View style={styles.root} testID="app-tab-shell">
      <AppNavigator
        unreadCount={chat.unreadTotal}
        missedCallCount={missedCallCount}
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

// Memoised so an `AppShell` re-render (a call state change it routes on, say)
// does not re-render the whole tab shell: the element carries no props, so the
// comparison always bails out and the shell re-renders only for the call slice
// it selected and for its own chat context.
export default memo(TabShell);
