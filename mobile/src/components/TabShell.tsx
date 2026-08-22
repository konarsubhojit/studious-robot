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
import ChatConversationScreen from './ChatConversationScreen';
import ChatListScreen from './ChatListScreen';
import Lobby from './Lobby';
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
    isSettingsPanelVisible,
    setIsSettingsPanelVisible,
    handleAutoLightingToggle,
    handleSpeakerDefaultToggle,
    handleDeveloperModeToggle,
    minimizeCallOnNavigate,
    startAudioCallWith,
    startVideoCallWith,
    handleExportLogs,
  } = useCall();
  const chat = useChat();
  const insets = useSafeAreaInsets();
  const { recentSearches, recordSearch, clearSearches } = useRecentSearches();

  const renderChatConversation = (peerId: string | null, { messageId }: { messageId?: string | null; } = {}) => {
    // A conversation route always carries its peer; without one there is
    // nothing to render (and every handler below would target no peer).
    if (!peerId) return null;
    return (
      <ChatConversationScreen
        peerId={peerId}
        messages={chat.messagesByPeer[peerId] ?? []}
        highlightMessageId={messageId ?? null}
        onOpenProfile={() => openPeerProfile(peerId)}
        onSendMessage={(body, options) => chat.sendMessage(peerId, body, options)}
        onRetryMessage={message => chat.retryMessage(peerId, message.messageId)}
        onDeleteMessage={message => chat.deleteMessage(peerId, message.messageId)}
        onReactToMessage={(message, emoji, action) =>
          chat.reactToMessage(peerId, message.messageId, emoji, action)
        }
        onDownloadAttachment={async message => {
          const result = await downloadAttachment({
            url: message?.attachment?.url,
            name: message?.attachment?.name,
            mimeType: message?.attachment?.mimeType,
          });
          callFlow.updateStatus(
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
        onPickAttachment={kind => chat.pickAndSendAttachment(peerId, kind)}
        onStartVoiceNote={() => chat.startRecordingVoiceNote()}
        onStopVoiceNote={() => chat.stopRecordingVoiceNoteAndSend(peerId)}
        onCancelVoiceNote={() => chat.cancelRecordingVoiceNote()}
        isUploadingAttachment={chat.isUploadingAttachment}
        attachmentUploadProgress={chat.attachmentUploadProgress}
        isRecordingVoiceNote={chat.isRecordingVoiceNote}
        attachmentsAvailable={chat.attachmentsAvailable}
        isVoiceNoteSupported={chat.isVoiceNoteSupported}
        onTypingChange={isTyping => chat.sendTypingIndicator(peerId, isTyping)}
      />
    );
  };

  const renderChatList = () => (
    <ChatListScreen
      conversations={chat.conversations}
      onOpenConversation={openChatConversation}
      onSearchUsers={chat.searchUsers}
      onRefresh={chat.handleRefreshConversations}
      isRefreshing={chat.isRefreshingConversations}
      isLoading={chat.isLoadingConversations}
      onMarkRead={chat.markConversationRead}
      onOpenSearch={openSearch}
      onOpenSettings={() => openTab(TABS.SETTINGS)}
    />
  );

  const renderSearch = () => (
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
  );

  /** @param peerId */
  const renderPeerProfile = (peerId: string | null) => {
    if (!peerId) return null;
    return (
      <PeerProfileScreen
        peerId={peerId}
        presence={chat.chatPeerId === peerId ? chat.peerPresence : null}
        isBlocked={Boolean(chat.isUserBlocked?.(peerId))}
        callHistory={callFlow.callHistory}
        currentUserId={chat.currentUserId}
        onBack={goBack}
        onMessage={openChatConversation}
        onAudioCall={startAudioCallWith}
        onVideoCall={startVideoCallWith}
        onBlock={chat.blockPeer}
        onUnblock={chat.unblockPeer}
      />
    );
  };

  const renderCalls = () => (
    <Lobby
      userId={callFlow.userId}
      onChangeUserId={callFlow.editUserId}
      calleeId={callFlow.calleeId}
      onChangeCalleeId={callFlow.setCalleeId}
      onCall={() => {
        callFlow.placeCall().catch(error => {
          logError('placeCall unhandled rejection', error);
        });
      }}
      calleePresence={callFlow.calleePresence}
      onOpenSettings={() => openTab(TABS.SETTINGS)}
      isServerUnreachable={callFlow.isServerUnreachable}
      onRetryConnect={callFlow.retryPresenceConnect}
      onSearchUsers={callFlow.searchUsers}
      onSelectContact={callFlow.setCalleeId}
      onOpenSearch={openSearch}
      developerMode={settings.developerModeEnabled}
      isSettingsVisible={isSettingsPanelVisible}
      onToggleSettings={() => setIsSettingsPanelVisible(previous => !previous)}
      onExportLogs={handleExportLogs}
      settings={settings}
      onToggleAutoLighting={handleAutoLightingToggle}
      onToggleSpeakerDefault={handleSpeakerDefaultToggle}
      status={callFlow.status}
      callSummary={callFlow.callSummary}
      onDismissSummary={callFlow.dismissCallSummary}
      callHistory={callFlow.callHistory}
      missedCallCount={callFlow.missedCallCount}
      onMarkMissedRead={callFlow.markMissedCallsRead}
      onRedial={startVideoCallWith}
    />
  );

  const renderSettings = () => (
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
        callFlow.unregisterUser().catch(error => {
          logError('unregisterUser failed', error);
        });
      }}
      onClose={() => openTab(TABS.CHATS)}
      onExportLogs={handleExportLogs}
      developerModeEnabled={settings.developerModeEnabled}
      onToggleDeveloperMode={handleDeveloperModeToggle}
    />
  );

  return (
    <View style={styles.root} testID="app-tab-shell">
      <AppNavigator
        unreadCount={chat.unreadTotal}
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
