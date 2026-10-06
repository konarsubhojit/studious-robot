import { useContext, useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { describeMessagePreview } from '../../../shared';
import { useThemedStyles } from '../ThemeContext';
import { usePeerProfile } from '../profile/ProfileContext';
import { radius, spacing, typography } from '../theme';
import { Avatar, Sheet } from './primitives';
import GroupDirectorySheet from './GroupDirectorySheet';
import GroupCallPreview from './GroupCallPreview';
import CallParticipantGrid from './CallParticipantGrid';
import type { GroupCallPreviewActions } from './GroupCallPreview';
import MessageDeliveryIndicator from './chat/MessageDeliveryIndicator';
import OutboxOfflineBanner from './chat/OutboxOfflineBanner';
import { messageDeliveryState } from '../messaging/deliveryState';
import type { GroupCallSnapshot } from '../chat/groupCallAdapter';
import type { CallPeerMap } from '../call/callStateMachine';
import type { WebrtcMediaStream } from '../hooks/usePeerConnection';
import type { ChatContextValue } from '../chat/ChatProvider';
import type { ChatMessage, ConversationSummary } from '../messaging/types';
import type { ContactRow } from '../types/directory';
import type { ThemeColors } from '../theme';

/** Matches the direct composer: stop reporting typing after this much silence. */
const TYPING_IDLE_MS = 3000;

type Styles = ReturnType<typeof createStyles>;
type GroupActions = ChatContextValue['groupActions'];
type CacheMemberProfiles = GroupActions['cacheMemberProfiles'];
type GroupPreviewActions = ChatContextValue['groupPreviewActions'];
type Props = {
  conversation: ConversationSummary;
  messages: ChatMessage[];
  currentUserId: string;
  typing: Record<string, boolean>;
  actions: GroupActions;
  /** Only supplied by a local-preview build; absent for the live transport. */
  preview?: GroupPreviewActions;
  callSnapshot?: GroupCallSnapshot;
  callActions: GroupCallPreviewActions;
  callPeers?: CallPeerMap<WebrtcMediaStream>;
  activeSpeakerId?: string | null;
  localStream?: WebrtcMediaStream | null;
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  onSearchUsers: (query: string) => Promise<ContactRow[]>;
  onSend: (body: string) => Promise<unknown>;
  onRetry: (messageId: string) => Promise<unknown>;
  onDiscard?: (messageId: string) => void;
  pendingSendCount?: number;
  onTyping: (typing: boolean) => void;
  onRead: () => Promise<void>;
  onBack: () => void;
  draft: string;
  onDraft: (text: string) => void;
  offline: boolean;
  onRefresh?: () => Promise<void>;
  onLoadOlder?: () => void;
  isRefreshing?: boolean;
};

function Action({ label, onPress, disabled = false, testID, styles }: {
  label: string; onPress: () => void; disabled?: boolean; testID?: string; styles: Styles;
}) {
  return <Pressable style={styles.action} onPress={onPress} disabled={disabled} testID={testID}
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}>
    <Text style={styles.text}>{label}</Text>
  </Pressable>;
}

type GroupBubbleProps = {
  message: ChatMessage; row: ConversationSummary; currentUserId: string; cacheMemberProfiles: CacheMemberProfiles;
  onRetry: (id: string) => void; onDiscard?: (id: string) => void; styles: Styles;
};

function useGroupMemberProfile(row: ConversationSummary, userId: string, cacheMemberProfiles: CacheMemberProfiles) {
  const cached = row.groupMemberProfiles?.[userId];
  const profile = usePeerProfile(userId, cached);
  useEffect(() => {
    if (profile.displayName === cached?.displayName && profile.avatarKey === cached?.avatarKey) return;
    if (profile.displayName === undefined && profile.avatarKey === undefined) return;
    cacheMemberProfiles(row.peerId, {
      [userId]: { displayName: profile.displayName, avatarKey: profile.avatarKey },
    });
  }, [cacheMemberProfiles, cached?.avatarKey, cached?.displayName, profile.avatarKey,
    profile.displayName, row.peerId, userId]);
  return profile;
}

function GroupDelivery({ message, row, onRetry, onDiscard, styles }: Omit<GroupBubbleProps, 'currentUserId' | 'cacheMemberProfiles'>) {
  const status = messageDeliveryState(message);
  const savedMock = row.localMock && ['sent', 'delivered', 'read'].includes(status);
  if (savedMock) return <Text style={styles.secondary} accessibilityLabel="Saved locally (mock)">Saved locally (mock)</Text>;
  return <MessageDeliveryIndicator status={status} style={styles.secondary} testPrefix="group"
    onRetry={!row.left ? () => onRetry(message.messageId) : undefined}
    onDiscard={onDiscard ? () => onDiscard(message.messageId) : undefined} />;
}

function GroupBubble({ message, row, currentUserId, cacheMemberProfiles, onRetry, onDiscard, styles }: GroupBubbleProps) {
  const own = message.senderId === currentUserId;
  const sender = useGroupMemberProfile(row, message.senderId, cacheMemberProfiles);
  const memberIds = row.group?.memberIds ?? [];
  const readers = (message.readBy ?? []).filter(id => id !== currentUserId && memberIds.includes(id));
  return <View style={[styles.bubble, own ? styles.ownBubble : undefined]} testID="group-message">
    <View style={styles.sender}>
      <Avatar id={message.senderId} profile={sender} size="sm" testID={`group-sender-avatar-${message.messageId}`} />
      <Text style={styles.name} accessibilityLabel={own ? 'You' : `Message from ${sender.name}`}>
        {own ? 'You' : sender.name}
      </Text>
    </View>
    <Text style={styles.text}>{message.deletedAt ? 'Message deleted' :
      !message.type || message.type === 'text' ? message.body : describeMessagePreview(message)}</Text>
    {own ? <GroupDelivery message={message} row={row} styles={styles} onRetry={onRetry} onDiscard={onDiscard} /> : null}
    {own && readers.length ? <View style={styles.readers} testID={`group-message-readers-${message.messageId}`}>
      <Text style={styles.secondary}>Read by </Text>
      {readers.map((id, index) => <GroupReader key={id} userId={id} row={row}
        cacheMemberProfiles={cacheMemberProfiles} styles={styles}
        separator={index < readers.length - 1} />)}
    </View> : null}
  </View>;
}

function GroupReader({ userId, row, cacheMemberProfiles, styles, separator }: {
  userId: string; row: ConversationSummary; cacheMemberProfiles: CacheMemberProfiles; styles: Styles; separator: boolean;
}) {
  const profile = useGroupMemberProfile(row, userId, cacheMemberProfiles);
  return <Text style={styles.secondary} accessibilityLabel={`Read by ${profile.name}`}>
    {profile.name}{separator ? ', ' : ''}
  </Text>;
}

function GroupMemberIdentity({ userId, owner, row, cacheMemberProfiles, styles }: {
  userId: string; owner: boolean; row: ConversationSummary; cacheMemberProfiles: CacheMemberProfiles; styles: Styles;
}) {
  const profile = useGroupMemberProfile(row, userId, cacheMemberProfiles);
  return <View style={styles.sender}>
    <Avatar id={userId} profile={profile} size="sm" testID={`group-member-avatar-${userId}`} />
    <Text style={styles.name}>{profile.name}{owner ? ' (owner)' : ''}</Text>
  </View>;
}

function MembersSheet({ visible, row, currentUserId, onClose, onAdd, onLeave, onRemove, actions, preview, run, busy, styles }: {
  visible: boolean; row: ConversationSummary; currentUserId: string; onClose: () => void; onAdd: () => void;
  onLeave: () => void; onRemove: (userId: string) => void; preview?: GroupPreviewActions;
  actions: GroupActions; run: (action: () => Promise<unknown>) => void; busy: boolean; styles: Styles;
}) {
  const group = row.group!;
  const member = !row.left && group.memberIds.includes(currentUserId);
  const ownerId = group.ownerId ?? group.creatorId;
  const admin = ownerId === currentUserId && member;
  const [name, setName] = useState(group.name);
  useEffect(() => { setName(group.name); }, [group.name]);
  return <Sheet visible={visible} onClose={onClose} title="Group members"
    subtitle={row.localMock ? 'Local mock — membership and simulated activity stay on this device.' : 'Only group owners can add or remove members.'}
    testID="group-members-sheet">
    <ScrollView>
      {group.memberIds.map(id => <View key={id} style={styles.member}>
        <GroupMemberIdentity userId={id} owner={id === ownerId} row={row}
          cacheMemberProfiles={actions.cacheMemberProfiles} styles={styles} />
        <Text style={styles.secondary}>{row.readByMember?.[id] ? `Read through ${row.readByMember[id]}` : 'No read receipt'}</Text>
        {admin && id !== ownerId ? <Action styles={styles}
          disabled={busy} label={`Remove ${id}`} testID={`group-remove-${id}`}
          onPress={() => onRemove(id)} /> : null}
        {preview && row.localMock && !row.left && id !== currentUserId ? <View>
          {(['typing', 'read', 'message'] as const).map(action => <Action key={action} styles={styles}
            disabled={busy} label={`Simulate ${id} ${action}`} testID={`group-simulate-${id}-${action}`}
            onPress={() => run(async () => preview.activity(row.peerId, id, action))} />)}
        </View> : null}
      </View>)}
      {admin ? <View>
        <Action styles={styles} label="Add members" disabled={busy}
          testID="group-add-members" onPress={onAdd} />
        <TextInput style={styles.input} accessibilityLabel="Rename group" value={name}
          onChangeText={setName} maxLength={128} editable={!busy} testID="group-rename-input" />
        <Action styles={styles} label="Rename group" disabled={busy || !name.trim()} testID="group-rename"
          onPress={() => run(() => actions.rename(row.peerId, name))} />
      </View> : null}
    </ScrollView>
    <Action label="Leave group" styles={styles} disabled={!member || busy}
      testID="group-leave" onPress={onLeave} />
  </Sheet>;
}

function GroupActionConfirmation({ action, busy, onCancel, onConfirm, styles }: {
  action: { type: 'leave' } | { type: 'remove'; userId: string } | null;
  busy: boolean; onCancel: () => void; onConfirm: () => void; styles: Styles;
}) {
  if (!action) return null;
  const leaving = action.type === 'leave';
  return <Sheet visible onClose={onCancel} title={leaving ? 'Leave group?' : `Remove ${action.userId}?`}
    subtitle={leaving
      ? 'You will no longer receive messages or be able to send messages in this group.'
      : `${action.userId} will no longer be a member of this group.`}
    testID="group-action-confirmation">
    <Action label="Cancel" styles={styles} disabled={busy} testID="group-action-cancel" onPress={onCancel} />
    <Action label={leaving ? 'Leave group' : `Remove ${action.userId}`} styles={styles} disabled={busy}
      testID={leaving ? 'group-confirm-leave' : 'group-confirm-remove'}
      onPress={onConfirm} />
  </Sheet>;
}

export default function GroupConversationScreen({
  conversation: row, messages, currentUserId, typing, actions, preview, callSnapshot, callActions,
  callPeers, activeSpeakerId, localStream, isMuted, isVideoEnabled, isScreenSharing, onSearchUsers, onSend, onRetry, onDiscard,
  onTyping, onRead, onBack, draft, onDraft, offline, pendingSendCount = 0, onRefresh, onLoadOlder, isRefreshing = false,
}: Props) {
  const styles = useThemedStyles(createStyles);
  const insets = useContext(SafeAreaInsetsContext);
  const [membersVisible, setMembersVisible] = useState(false);
  const [adding, setAdding] = useState(false);
  const [calling, setCalling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<
    { type: 'leave' } | { type: 'remove'; userId: string } | null
  >(null);
  const openedCallIdRef = useRef<string | null>(null);
  const group = row.group!;
  const isMember = !row.left && group.memberIds.includes(currentUserId);
  const selfCallParticipant = callSnapshot?.participants.find(person => person.userId === currentUserId);
  const isCompactCallVisible = Boolean(
    callSnapshot &&
    callSnapshot.call.status !== 'ended' &&
    selfCallParticipant?.status === 'accepted' &&
    !calling &&
    isMember,
  );
  const compactSpeakerId = activeSpeakerId ??
    Object.values(callPeers ?? {}).find(peer => peer.isSpeaking)?.userId ??
    callSnapshot?.participants.find(person =>
      person.userId !== currentUserId && person.status === 'accepted',
    )?.userId ??
    currentUserId;
  const compactParticipants = callSnapshot?.participants
    .filter(person => person.status === 'accepted')
    .map(person => {
      const self = person.userId === currentUserId;
      const peer = callPeers?.[person.userId];
      const stream = self ? localStream : peer?.stream;
      return {
        userId: person.userId,
        name: self ? 'You' : person.userId,
        streamUrl: (stream as any)?.toURL?.() ?? null,
        isMuted: self ? Boolean(isMuted) : peer?.isMuted ?? null,
        isVideoEnabled: self ? Boolean(isVideoEnabled) : peer?.isVideoEnabled ?? null,
        connectionState: peer?.connectionState ?? person.status,
        quality: peer?.quality ?? (person.status === 'accepted' ? 'connecting' : person.status),
        isSpeaking: peer?.isSpeaking ?? false,
        isScreenSharing: self ? Boolean(isScreenSharing) : peer?.isScreenSharing ?? false,
      };
    }) ?? [];
  useEffect(() => {
    const self = callSnapshot?.participants.find(person => person.userId === currentUserId);
    if (
      !row.localMock && callSnapshot && callSnapshot.call.status !== 'ended' &&
      self && (self.status === 'accepted' || self.status === 'ringing') &&
      openedCallIdRef.current !== callSnapshot.callId
    ) {
      openedCallIdRef.current = callSnapshot.callId;
      setCalling(true);
    }
    if (!callSnapshot || callSnapshot.call.status === 'ended') openedCallIdRef.current = null;
  }, [callSnapshot, currentUserId, row.localMock]);
  const newestId = messages[0]?.messageId;
  const callbacks = useRef({ onRead, onTyping });
  callbacks.current = { onRead, onTyping };
  const typingIdleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (isMember) void callbacks.current.onRead().catch(() => setError('Unable to mark group read locally'));
  }, [newestId, isMember, row.peerId]);
  useEffect(() => () => {
    clearTimeout(typingIdleTimer.current);
    callbacks.current.onTyping(false);
  }, [row.peerId]);
  // A typist who stops without blurring would otherwise keep every member's
  // indicator alive until their receive-side safety timeout fires.
  const reportTyping = (isTyping: boolean) => {
    clearTimeout(typingIdleTimer.current);
    onTyping(isTyping);
    if (isTyping) typingIdleTimer.current = setTimeout(() => callbacks.current.onTyping(false), TYPING_IDLE_MS);
  };
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Group action failed'); }
    finally { setBusy(false); }
  };
  const send = () => run(async () => {
    const result = await onSend(draft);
    if (result) { onDraft(''); reportTyping(false); }
  });
  const confirmGroupAction = () => {
    const pending = confirmation;
    if (!pending) return;
    setConfirmation(null);
    if (pending.type === 'leave') {
      void run(async () => { await actions.leave(row.peerId); onBack(); });
    } else {
      void run(() => actions.members(row.peerId, { type: 'remove', userId: pending.userId }));
    }
  };
  const typists = group.memberIds.filter(id => id !== currentUserId && typing[id]);
  return <KeyboardAvoidingView style={[styles.root, { paddingTop: spacing.md + (insets?.top ?? 0) }]}
    behavior={Platform.OS === 'ios' ? 'padding' : undefined} testID="group-conversation">
    <Action label="Back to chats" styles={styles} onPress={onBack} />
    <Text style={styles.title} accessibilityRole="header">{group.name}</Text>
    <Text style={styles.secondary}>{row.localMock ? 'Local mock group — not shared with other devices.' :
      'Live group — messages and lifecycle use the server. Read summaries are local.'}</Text>
    <OutboxOfflineBanner offline={offline} count={pendingSendCount} testID="group-offline-notice" />
    {!isMember ? <Text style={styles.text}>You left this group or were removed.</Text> : null}
    <View style={styles.controls}>
      <Action label="Members" styles={styles} onPress={() => setMembersVisible(true)} testID="group-open-members" />
      <Action label={callSnapshot?.call.status === 'ringing' ? 'Open ringing group call preview' : 'Group call preview'}
        styles={styles} disabled={!isMember}
        onPress={() => setCalling(true)} testID="group-open-call" />
    </View>
    <FlatList data={messages} inverted keyExtractor={message => message.messageId}
      contentContainerStyle={styles.timeline} keyboardShouldPersistTaps="handled"
      onEndReached={onLoadOlder} onEndReachedThreshold={0.2}
      refreshControl={onRefresh ? <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} /> : undefined}
      ListEmptyComponent={<Text style={styles.text}>No group messages yet</Text>}
      renderItem={({ item }) => <GroupBubble message={item} row={row} currentUserId={currentUserId}
        cacheMemberProfiles={actions.cacheMemberProfiles} styles={styles}
        onRetry={id => { void run(() => onRetry(id)); }} onDiscard={onDiscard} />} />
    {typists.length ? <Text style={styles.secondary} testID="group-typing">{typists.join(', ')} typing…</Text> : null}
    {error ? <Text style={styles.text} accessibilityRole="alert" testID="group-error">{error}</Text> : null}
    <TextInput style={styles.input} value={draft} onChangeText={text => { onDraft(text); reportTyping(Boolean(text.trim())); }}
      onBlur={() => reportTyping(false)} maxLength={4000} editable={isMember && !busy}
      accessibilityLabel="Group message" placeholder="Message group" testID="group-composer" />
    <Action label={busy ? 'Sending…' : 'Send to group'} styles={styles} disabled={!isMember || busy || !draft.trim()}
      onPress={() => { void send(); }} testID="group-send" />
    {isCompactCallVisible ? (
      <Pressable style={styles.compactCall} onPress={() => setCalling(true)}
        testID="group-call-mini-preview" accessibilityRole="button"
        accessibilityLabel="Return to group call">
        <CallParticipantGrid participants={compactParticipants} activeSpeakerId={compactSpeakerId} isCompact />
        <Text style={styles.compactCallLabel}>Return to group call</Text>
      </Pressable>
    ) : null}
    <MembersSheet visible={membersVisible} row={row} currentUserId={currentUserId} actions={actions} preview={preview}
      onClose={() => setMembersVisible(false)} onAdd={() => { setMembersVisible(false); setAdding(true); }}
      onLeave={() => setConfirmation({ type: 'leave' })}
      onRemove={userId => setConfirmation({ type: 'remove', userId })}
      styles={styles} busy={busy} run={action => { void run(action); }} />
    <GroupActionConfirmation action={confirmation} busy={busy} styles={styles}
      onCancel={() => setConfirmation(null)} onConfirm={confirmGroupAction} />
    <GroupDirectorySheet visible={adding} adding onClose={() => setAdding(false)}
      onSearchUsers={onSearchUsers} currentUserId={currentUserId} excludedIds={group.memberIds}
      onSubmit={async (_name, userIds, profiles) => {
        await actions.members(row.peerId, { type: 'add', userIds });
        actions.cacheMemberProfiles(row.peerId, profiles);
      }} />
    <GroupCallPreview visible={calling && isMember} onClose={() => setCalling(false)} conversationId={row.peerId}
      currentUserId={currentUserId} localMock={Boolean(row.localMock)} snapshot={callSnapshot} actions={callActions}
      callPeers={callPeers} activeSpeakerId={activeSpeakerId} localStream={localStream}
      isMuted={isMuted} isVideoEnabled={isVideoEnabled} isScreenSharing={isScreenSharing} />
  </KeyboardAvoidingView>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, padding: spacing.md, backgroundColor: colors.background },
  title: { ...typography.headline, color: colors.onSurface },
  text: { ...typography.body, color: colors.onSurface },
  name: { ...typography.body, fontWeight: '600', color: colors.onSurface },
  secondary: { ...typography.caption, color: colors.onSurfaceVariant },
  controls: { flexDirection: 'row', flexWrap: 'wrap' },
  sender: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  readers: { flexDirection: 'row', flexWrap: 'wrap' },
  action: { minHeight: 48, justifyContent: 'center', padding: spacing.sm },
  compactCall: {
    position: 'absolute',
    right: spacing.md,
    bottom: 88,
    width: 180,
    height: 140,
    zIndex: 20,
    elevation: 8,
    overflow: 'hidden',
    borderRadius: radius.md,
    backgroundColor: colors.stageDark,
  },
  compactCallLabel: {
    ...typography.caption,
    color: colors.onOverlay,
    textAlign: 'center',
    paddingBottom: spacing.xs,
  },
  input: { ...typography.body, color: colors.onSurface, backgroundColor: colors.surfaceControl, borderRadius: radius.md, padding: spacing.sm },
  timeline: { paddingVertical: spacing.sm },
  bubble: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.sm, marginVertical: spacing.xs, marginRight: spacing.lg },
  ownBubble: { backgroundColor: colors.surfaceRaised, marginLeft: spacing.lg, marginRight: 0 },
  member: { paddingVertical: spacing.sm },
});
