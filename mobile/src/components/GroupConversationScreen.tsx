import { useContext, useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { describeMessagePreview } from '../../../shared';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';
import { Sheet } from './primitives';
import GroupDirectorySheet from './GroupDirectorySheet';
import GroupCallPreview from './GroupCallPreview';
import type { GroupCallSnapshot } from '../chat/groupCallAdapter';
import type { ChatContextValue } from '../chat/ChatProvider';
import type { ChatMessage, ConversationSummary } from '../messaging/types';
import type { ContactRow } from '../types/directory';
import type { ThemeColors } from '../theme';

type Styles = ReturnType<typeof createStyles>;
type GroupActions = ChatContextValue['groupActions'];
type Props = {
  conversation: ConversationSummary;
  messages: ChatMessage[];
  currentUserId: string;
  typing: Record<string, boolean>;
  actions: GroupActions;
  callSnapshot?: GroupCallSnapshot;
  callActions: ChatContextValue['groupCallActions'];
  onSearchUsers: (query: string) => Promise<ContactRow[]>;
  onSend: (body: string) => Promise<unknown>;
  onRetry: (messageId: string) => Promise<unknown>;
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

function GroupBubble({ message, row, currentUserId, onRetry, styles }: {
  message: ChatMessage; row: ConversationSummary; currentUserId: string;
  onRetry: (id: string) => void; styles: Styles;
}) {
  const own = message.senderId === currentUserId;
  const readers = (row.group?.memberIds ?? []).filter(id => id !== currentUserId &&
    Date.parse(row.readByMember?.[id] ?? '') >= Date.parse(message.createdAt ?? ''));
  return <View style={[styles.bubble, own ? styles.ownBubble : undefined]} testID="group-message">
    <Text style={styles.name}>{own ? 'You' : message.senderId}</Text>
    <Text style={styles.text}>{message.deletedAt ? 'Message deleted' :
      !message.type || message.type === 'text' ? message.body : describeMessagePreview(message)}</Text>
    {own ? <Text style={styles.secondary}>{groupMessageStatus(message, Boolean(row.localMock))}</Text> : null}
    {own && readers.length ? <Text style={styles.secondary}>Read by {readers.join(', ')}</Text> : null}
    {own && message.failed && !row.left ? <Action label="Retry message" styles={styles}
      onPress={() => onRetry(message.messageId)} testID={`group-retry-${message.messageId}`} /> : null}
  </View>;
}

function groupMessageStatus(message: ChatMessage, mock: boolean) {
  if (message.pending) return 'Queued';
  if (message.failed) return 'Failed';
  return mock ? 'Saved locally (mock)' : 'Sent';
}

function MembersSheet({ visible, row, currentUserId, onClose, onAdd, onLeave, actions, run, busy, styles }: {
  visible: boolean; row: ConversationSummary; currentUserId: string; onClose: () => void; onAdd: () => void;
  onLeave: () => void;
  actions: GroupActions; run: (action: () => Promise<unknown>) => void; busy: boolean; styles: Styles;
}) {
  const group = row.group!;
  const member = !row.left && group.memberIds.includes(currentUserId);
  const admin = group.creatorId === currentUserId && member;
  const [name, setName] = useState(group.name);
  useEffect(() => { setName(group.name); }, [group.name]);
  return <Sheet visible={visible} onClose={onClose} title="Group members"
    subtitle={row.localMock ? 'Local mock — membership and simulated activity stay on this device.' : 'Member mutations await server support.'}
    testID="group-members-sheet">
    <ScrollView>
      {group.memberIds.map(id => <View key={id} style={styles.member}>
        <Text style={styles.name}>{id}{id === group.creatorId ? ' (admin)' : ''}</Text>
        <Text style={styles.secondary}>{row.readByMember?.[id] ? `Read through ${row.readByMember[id]}` : 'No read receipt'}</Text>
        {admin && row.localMock && id !== group.creatorId ? <Action styles={styles}
          disabled={busy} label={`Remove ${id}`} testID={`group-remove-${id}`}
          onPress={() => run(() => actions.members(row.peerId, { type: 'remove', userId: id }))} /> : null}
        {row.localMock && !row.left && id !== currentUserId ? <View>
          {(['typing', 'read', 'message'] as const).map(action => <Action key={action} styles={styles}
            disabled={busy} label={`Simulate ${id} ${action}`} testID={`group-simulate-${id}-${action}`}
            onPress={() => run(async () => actions.previewActivity(row.peerId, id, action))} />)}
        </View> : null}
      </View>)}
      {admin ? <View>
        {row.localMock ? <Action styles={styles} label="Add members" disabled={busy}
          testID="group-add-members" onPress={onAdd} /> : null}
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

export default function GroupConversationScreen({
  conversation: row, messages, currentUserId, typing, actions, callSnapshot, callActions, onSearchUsers, onSend, onRetry,
  onTyping, onRead, onBack, draft, onDraft, offline, onRefresh, onLoadOlder, isRefreshing = false,
}: Props) {
  const styles = useThemedStyles(createStyles);
  const insets = useContext(SafeAreaInsetsContext);
  const [membersVisible, setMembersVisible] = useState(false);
  const [adding, setAdding] = useState(false);
  const [calling, setCalling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const group = row.group!;
  const isMember = !row.left && group.memberIds.includes(currentUserId);
  const newestId = messages[0]?.messageId;
  const callbacks = useRef({ onRead, onTyping });
  callbacks.current = { onRead, onTyping };
  useEffect(() => {
    if (isMember) void callbacks.current.onRead().catch(() => setError('Unable to mark group read locally'));
  }, [newestId, isMember, row.peerId]);
  useEffect(() => () => callbacks.current.onTyping(false), [row.peerId]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Group action failed'); }
    finally { setBusy(false); }
  };
  const send = () => run(async () => {
    const result = await onSend(draft);
    if (result) { onDraft(''); onTyping(false); }
  });
  const typists = group.memberIds.filter(id => id !== currentUserId && typing[id]);
  return <KeyboardAvoidingView style={[styles.root, { paddingTop: spacing.md + (insets?.top ?? 0) }]}
    behavior={Platform.OS === 'ios' ? 'padding' : undefined} testID="group-conversation">
    <Action label="Back to chats" styles={styles} onPress={onBack} />
    <Text style={styles.title} accessibilityRole="header">{group.name}</Text>
    <Text style={styles.secondary}>{row.localMock ? 'Local mock group — not shared with other devices.' :
      'Live group — messages and lifecycle use the server. Read summaries are local.'}</Text>
    {offline ? <Text style={styles.secondary}>Offline — sends are durably queued</Text> : null}
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
        styles={styles} onRetry={id => { void run(() => onRetry(id)); }} />} />
    {typists.length ? <Text style={styles.secondary} testID="group-typing">{typists.join(', ')} typing…</Text> : null}
    {error ? <Text style={styles.text} accessibilityRole="alert" testID="group-error">{error}</Text> : null}
    <TextInput style={styles.input} value={draft} onChangeText={text => { onDraft(text); onTyping(Boolean(text.trim())); }}
      onBlur={() => onTyping(false)} maxLength={4000} editable={isMember && !busy}
      accessibilityLabel="Group message" placeholder="Message group" testID="group-composer" />
    <Action label={busy ? 'Sending…' : 'Send to group'} styles={styles} disabled={!isMember || busy || !draft.trim()}
      onPress={() => { void send(); }} testID="group-send" />
    <MembersSheet visible={membersVisible} row={row} currentUserId={currentUserId} actions={actions}
      onClose={() => setMembersVisible(false)} onAdd={() => { setMembersVisible(false); setAdding(true); }}
      onLeave={() => { void run(async () => { await actions.leave(row.peerId); onBack(); }); }}
      styles={styles} busy={busy} run={action => { void run(action); }} />
    <GroupDirectorySheet visible={adding} adding onClose={() => setAdding(false)}
      onSearchUsers={onSearchUsers} currentUserId={currentUserId} excludedIds={group.memberIds}
      onSubmit={async (_name, userIds) => actions.members(row.peerId, { type: 'add', userIds })} />
    <GroupCallPreview visible={calling && isMember} onClose={() => setCalling(false)} conversationId={row.peerId}
      currentUserId={currentUserId} localMock={Boolean(row.localMock)} snapshot={callSnapshot} actions={callActions} />
  </KeyboardAvoidingView>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, padding: spacing.md, backgroundColor: colors.background },
  title: { ...typography.headline, color: colors.onSurface },
  text: { ...typography.body, color: colors.onSurface },
  name: { ...typography.body, fontWeight: '600', color: colors.onSurface },
  secondary: { ...typography.caption, color: colors.onSurfaceVariant },
  controls: { flexDirection: 'row', flexWrap: 'wrap' },
  action: { minHeight: 48, justifyContent: 'center', padding: spacing.sm },
  input: { ...typography.body, color: colors.onSurface, backgroundColor: colors.surfaceControl, borderRadius: radius.md, padding: spacing.sm },
  timeline: { paddingVertical: spacing.sm },
  bubble: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.sm, marginVertical: spacing.xs, marginRight: spacing.lg },
  ownBubble: { backgroundColor: colors.surfaceRaised, marginLeft: spacing.lg, marginRight: 0 },
  member: { paddingVertical: spacing.sm },
});
