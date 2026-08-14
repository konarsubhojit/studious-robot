import { useCallback, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radius, spacing, typography } from '../theme';
import IconButton from './IconButton';

function formatMessageTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * One-to-one conversation window: header (back, presence, call actions),
 * a bubble message list (oldest at top, newest at bottom), and a composer.
 *
 * @param {object} props
 * @param {string} props.peerId
 * @param {Array<object>} [props.messages] - newest-first, as delivered by the hook.
 * @param {(body: string) => void} props.onSendMessage
 * @param {() => void} [props.onLoadOlder]
 * @param {() => void} props.onBack
 * @param {string} props.currentUserId
 * @param {{ online: boolean, status?: string } | null} [props.peerPresence]
 * @param {() => void} [props.onStartAudioCall]
 * @param {() => void} [props.onStartVideoCall]
 * @param {boolean} [props.isSending]
 */
export default function ChatConversationScreen({
  peerId,
  messages = [],
  onSendMessage,
  onLoadOlder,
  onBack,
  currentUserId,
  peerPresence = null,
  onStartAudioCall,
  onStartVideoCall,
  isSending = false,
}) {
  const [draft, setDraft] = useState('');
  const hasReachedTopRef = useRef(false);

  // Data arrives newest-first; reverse so a plain (non-inverted) FlatList
  // renders oldest-at-top / newest-at-bottom, matching a natural chat log.
  const orderedMessages = [...messages].reverse();

  const handleSend = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSendMessage?.(trimmed);
    setDraft('');
  }, [draft, onSendMessage]);

  const handleRetry = useCallback(
    (body) => {
      onSendMessage?.(body);
    },
    [onSendMessage],
  );

  const handleScroll = useCallback(
    (event) => {
      const { contentOffset } = event.nativeEvent;
      if (contentOffset.y <= 0 && !hasReachedTopRef.current) {
        hasReachedTopRef.current = true;
        onLoadOlder?.();
      } else if (contentOffset.y > 0) {
        hasReachedTopRef.current = false;
      }
    },
    [onLoadOlder],
  );

  const presenceLabel = peerPresence ? (peerPresence.online ? 'Online' : 'Offline') : null;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.root} testID="chat-conversation-root">
        <View style={styles.header}>
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Back to chat list"
            testID="chat-back"
            style={styles.backButton}
          >
            <Text style={styles.backButtonText}>‹</Text>
          </Pressable>

          <View style={styles.headerText}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {peerId}
            </Text>
            {presenceLabel ? <Text style={styles.headerSubtitle}>{presenceLabel}</Text> : null}
          </View>

          {onStartAudioCall ? (
            <IconButton
              icon="chatAudioCall"
              onPress={onStartAudioCall}
              size={40}
              accessibilityLabel={`Call ${peerId}`}
              testID="chat-call-audio"
            />
          ) : null}
          {onStartVideoCall ? (
            <IconButton
              icon="chatVideoCall"
              onPress={onStartVideoCall}
              size={40}
              accessibilityLabel={`Video call ${peerId}`}
              testID="chat-call-video"
            />
          ) : null}
        </View>

        <FlatList
          testID="chat-message-list"
          data={orderedMessages}
          keyExtractor={(item) => item.messageId}
          contentContainerStyle={styles.messageList}
          onScroll={handleScroll}
          scrollEventThrottle={32}
          renderItem={({ item }) => {
            const isOwn = item.senderId === currentUserId;
            return (
              <View
                testID="chat-message-row"
                style={[styles.messageRow, isOwn ? styles.messageRowOwn : styles.messageRowPeer]}
              >
                <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubblePeer]}>
                  <Text style={isOwn ? styles.bubbleTextOwn : styles.bubbleTextPeer}>
                    {item.body}
                  </Text>
                </View>
                <Text style={[styles.timestamp, isOwn && styles.timestampOwn]}>
                  {formatMessageTimestamp(item.createdAt)}
                </Text>
                {item.pending ? <Text style={styles.pendingText}>Sending…</Text> : null}
                {item.failed ? (
                  <Pressable
                    onPress={() => handleRetry(item.body)}
                    accessibilityRole="button"
                    accessibilityLabel="Retry sending message"
                  >
                    <Text style={styles.failedText}>Failed to send · tap to retry</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          }}
        />

        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Message"
            placeholderTextColor={colors.textSecondary}
            style={styles.composerInput}
            multiline
            testID="chat-message-input"
          />
          <IconButton
            icon="➤"
            onPress={handleSend}
            variant="active"
            disabled={!draft.trim() || isSending}
            size={44}
            accessibilityLabel="Send message"
            testID="chat-message-send"
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  root: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    color: colors.textPrimary,
    fontSize: 28,
    lineHeight: 28,
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
  },
  headerSubtitle: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 1,
  },
  messageList: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  messageRow: {
    marginBottom: spacing.sm,
    maxWidth: '80%',
  },
  messageRowOwn: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
  },
  messageRowPeer: {
    alignSelf: 'flex-start',
    alignItems: 'flex-start',
  },
  bubble: {
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bubbleOwn: {
    backgroundColor: colors.accentButton,
  },
  bubblePeer: {
    backgroundColor: colors.surfaceRaised,
  },
  bubbleTextOwn: {
    color: colors.textOnAccent,
  },
  bubbleTextPeer: {
    color: colors.textPrimary,
  },
  timestamp: {
    ...typography.hint,
    color: colors.textMuted,
    marginTop: 2,
  },
  timestampOwn: {
    textAlign: 'right',
  },
  pendingText: {
    ...typography.hint,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  failedText: {
    ...typography.hint,
    color: colors.danger,
    fontWeight: '600',
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  composerInput: {
    flex: 1,
    maxHeight: 120,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
});
