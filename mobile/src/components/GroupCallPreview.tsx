import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';
import { Sheet } from './primitives';
import type { ChatContextValue } from '../chat/ChatProvider';
import type { GroupCallAction, GroupCallSnapshot } from '../chat/groupCallAdapter';
import type { ThemeColors } from '../theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  conversationId: string;
  currentUserId: string;
  localMock: boolean;
  snapshot?: GroupCallSnapshot;
  actions: ChatContextValue['groupCallActions'];
};
type Styles = ReturnType<typeof createStyles>;

function Button({ label, onPress, disabled, testID, styles }: {
  label: string; onPress: () => void; disabled: boolean; testID?: string; styles: Styles;
}) {
  return <Pressable style={styles.action} disabled={disabled} onPress={onPress} testID={testID}
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}>
    <Text style={styles.text}>{label}</Text>
  </Pressable>;
}

function Participant({ person, self, localMock, muted, ended, busy, onMute, onAction, styles }: {
  person: GroupCallSnapshot['participants'][number]; self: boolean; localMock: boolean; muted: boolean;
  ended: boolean; busy: boolean; onMute: () => void; onAction: (action: GroupCallAction) => void; styles: Styles;
}) {
  const terminal = ended || person.status === 'left' || person.status === 'declined';
  const controls = self || localMock;
  const labels = self ? {
    mute: 'Toggle preview mute', accept: 'Accept (no media)', decline: 'Decline group call', leave: 'Leave preview',
  } : {
    mute: `Simulate mute ${person.userId}`, accept: `Simulate accept ${person.userId}`,
    decline: `Simulate decline ${person.userId}`, leave: `Simulate leave ${person.userId}`,
  };
  return <View style={styles.participant} testID={`group-participant-${person.userId}`}>
    <Text style={styles.name}>{self ? 'You' : person.userId}</Text>
    <Text style={styles.text}>{person.status === 'left' ? 'Left preview' : person.status}</Text>
    <Text style={styles.text}>{muted ? 'Muted (simulated)' : 'Unmuted (simulated)'}</Text>
    {controls ? <Button styles={styles} disabled={terminal || busy} testID={`group-call-mute-${person.userId}`}
      label={labels.mute} onPress={onMute} /> : null}
    {controls && person.status === 'ringing' ? <View>
      <Button styles={styles} disabled={terminal || busy} testID={`group-call-accept-${person.userId}`}
        label={labels.accept} onPress={() => onAction('accept')} />
      <Button styles={styles} disabled={terminal || busy} testID={`group-call-decline-${person.userId}`}
        label={labels.decline} onPress={() => onAction('decline')} />
    </View> : null}
    {controls && (person.status === 'accepted' || person.status === 'left') ? <Button styles={styles}
      disabled={terminal || busy} testID={`group-call-leave-${person.userId}`}
      label={labels.leave} onPress={() => onAction('leave')} /> : null}
  </View>;
}

/** Lifecycle states are authoritative; mute remains a separate, local-only media placeholder. */
export default function GroupCallPreview({
  visible, onClose, conversationId, currentUserId, localMock, snapshot, actions,
}: Props) {
  const styles = useThemedStyles(createStyles);
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setMuted({}); setError(''); }, [snapshot?.callId]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Group call action failed'); }
    finally { setBusy(false); }
  };
  const transition = (id: string, action: GroupCallAction) => {
    void run(() => id === currentUserId ? actions.transition(conversationId, action) :
      actions.simulate(conversationId, id, action));
  };
  const ended = snapshot?.call.status === 'ended';
  return <Sheet visible={visible} onClose={onClose} title="Group call preview"
    subtitle={localMock ? 'Local mock signaling — no actual media, microphone, camera, or WebRTC.' :
      'Real group lifecycle signaling only — no actual media. Starting or accepting notifies other participants.'}
    testID="group-call-preview">
    {snapshot ? <Text style={styles.text} testID="group-call-status">
      {snapshot.call.mediaType} · {snapshot.call.status} (signaling)
    </Text> : null}
    {!snapshot || ended ? <View>
      <Button styles={styles} label="Start audio signaling preview" disabled={busy} testID="group-call-start-audio"
        onPress={() => { void run(() => actions.start(conversationId, 'audio')); }} />
      <Button styles={styles} label="Start video signaling preview" disabled={busy} testID="group-call-start-video"
        onPress={() => { void run(() => actions.start(conversationId, 'video')); }} />
    </View> : null}
    <ScrollView>
      <View style={styles.grid}>
        {snapshot?.participants.map(person => <Participant key={person.userId} person={person}
          self={person.userId === currentUserId} localMock={localMock} muted={Boolean(muted[person.userId])}
          ended={Boolean(ended)} busy={busy} styles={styles}
          onMute={() => setMuted(previous => ({ ...previous, [person.userId]: !previous[person.userId] }))}
          onAction={action => transition(person.userId, action)} />)}
      </View>
    </ScrollView>
    {error ? <Text style={styles.text} accessibilityRole="alert">{error}</Text> : null}
    <Button styles={styles} label="Close preview" disabled={busy} onPress={onClose} />
    <Text style={styles.secondary}>Closing this sheet does not leave the call. Use Leave preview to signal departure.</Text>
  </Sheet>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  text: { ...typography.body, color: colors.onSurface },
  name: { ...typography.body, fontWeight: '600', color: colors.onSurface },
  secondary: { ...typography.caption, color: colors.onSurfaceVariant },
  action: { minHeight: 48, justifyContent: 'center', padding: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  participant: { width: '47%', borderRadius: radius.md, padding: spacing.sm, backgroundColor: colors.surfaceRaised },
});
