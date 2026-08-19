import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logError } from '../appLogger';
import { useCall } from '../call/CallProvider';
import { useChat } from '../chat/ChatProvider';
import AppNavigator from '../navigation/AppNavigator';
import {
  closeChatConversation,
  openChatConversation,
  openTab,
  resetNavigation,
} from '../navigation/navigationRef';
import { clearNavigationState } from '../navigation/navigationState';
import { TABS } from '../navigation/routes';
import ChatConversationScreen from './ChatConversationScreen';
import ChatListScreen from './ChatListScreen';
import Lobby from './Lobby';
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

  const renderChatConversation = peerId => (
    <ChatConversationScreen
      peerId={peerId}
      messages={chat.messagesByPeer[peerId] ?? []}
      onSendMessage={body => chat.sendMessage(peerId, body)}
      onRetryMessage={message => chat.retryMessage(peerId, message.messageId)}
      onDeleteMessage={message => chat.deleteMessage(peerId, message.messageId)}
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
      onTypingChange={isTyping => chat.sendTypingIndicator(peerId, isTyping)}
    />
  );

  const renderChatList = () => (
    <ChatListScreen
      conversations={chat.conversations}
      onOpenConversation={openChatConversation}
      onSearchUsers={chat.searchUsers}
      onRefresh={chat.handleRefreshConversations}
      isRefreshing={chat.isRefreshingConversations}
      isLoading={chat.isLoadingConversations}
      onMarkRead={chat.markConversationRead}
      onOpenSettings={() => openTab(TABS.SETTINGS)}
    />
  );

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
      onRedial={peerId => startVideoCallWith(peerId)}
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
