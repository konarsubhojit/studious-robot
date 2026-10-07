import { useEffect, useRef, useState } from 'react';
import { GROUP_CALL_LIMIT_MESSAGE, MAX_GROUP_CALL_PARTICIPANTS } from '../../../shared';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';
import { Sheet } from './primitives';
import CallParticipantGrid from './CallParticipantGrid';
import type { ChatContextValue } from '../chat/ChatProvider';
import type { GroupCallAction, GroupCallSnapshot } from '../chat/groupCallAdapter';
import type { CallPeerMap } from '../call/callStateMachine';
import type { WebrtcMediaStream } from '../hooks/usePeerConnection';
import type { ThemeColors } from '../theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  conversationId: string;
  currentUserId: string;
  localMock: boolean;
  memberCount?: number;
  snapshot?: GroupCallSnapshot;
  actions: GroupCallPreviewActions;
  callPeers?: CallPeerMap<WebrtcMediaStream>;
  activeSpeakerId?: string | null;
  localStream?: WebrtcMediaStream | null;
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
};
export type GroupCallPreviewActions =
  Pick<ChatContextValue['groupCallActions'], 'start' | 'transition' | 'simulate'> &
  Partial<Pick<ChatContextValue['groupCallActions'],
    'joinMedia' | 'leaveMedia' | 'toggleMute' | 'toggleVideo' | 'toggleScreenShare'>>;
type Styles = ReturnType<typeof createStyles>;

function Button({ label, onPress, disabled, testID, styles }: {
  label: string; onPress: () => void; disabled: boolean; testID?: string; styles: Styles;
}) {
  return <Pressable style={styles.action} disabled={disabled} onPress={onPress} testID={testID}
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}>
    <Text style={styles.text}>{label}</Text>
  </Pressable>;
}

function participantLabels(person: GroupCallSnapshot['participants'][number], self: boolean) {
  return self ? {
    mute: 'Toggle microphone mute', accept: person.status === 'ringing' ? 'Join call' : 'Rejoin call',
    decline: 'Decline group call', leave: 'Leave call',
  } : {
    mute: `Simulate mute ${person.userId}`, accept: `Simulate accept ${person.userId}`,
    decline: `Simulate decline ${person.userId}`, leave: `Simulate leave ${person.userId}`,
  };
}

function Participant({ person, self, localMock, muted, ended, busy, capacityReached, onMute, onAction, styles }: {
  person: GroupCallSnapshot['participants'][number]; self: boolean; localMock: boolean; muted: boolean;
  ended: boolean; busy: boolean; capacityReached: boolean; onMute: () => void;
  onAction: (action: GroupCallAction) => void; styles: Styles;
}) {
  const terminal = ended || person.status === 'left' || person.status === 'declined';
  const controls = self || localMock;
  const labels = participantLabels(person, self);
  return <View style={styles.participant} testID={`group-participant-${person.userId}`}>
    <Text style={styles.name}>{self ? 'You' : person.userId}</Text>
    <Text style={styles.text}>{localMock && person.status === 'left' ? 'Left preview' : person.status}</Text>
    <Text style={styles.text}>{localMock ? (muted ? 'Muted (simulated)' : 'Unmuted (simulated)') :
      (muted ? 'Muted' : 'Unmuted')}</Text>
    {controls ? <Button styles={styles} disabled={terminal || busy} testID={`group-call-mute-${person.userId}`}
      label={labels.mute} onPress={onMute} /> : null}
    {controls && person.status !== 'accepted' ? <View>
      <Button styles={styles} disabled={ended || busy || capacityReached} testID={`group-call-accept-${person.userId}`}
        label={labels.accept} onPress={() => onAction('accept')} />
      {person.status === 'ringing' ?
      <Button styles={styles} disabled={terminal || busy} testID={`group-call-decline-${person.userId}`}
        label={labels.decline} onPress={() => onAction('decline')} /> : null}
    </View> : null}
    {controls && person.status === 'accepted' ? <Button styles={styles}
      disabled={terminal || busy} testID={`group-call-leave-${person.userId}`}
      label={labels.leave} onPress={() => onAction('leave')} /> : null}
  </View>;
}

function MediaControls({ visible, styles, disabled, isVideoEnabled, isScreenSharing, onVideo, onScreen }: {
  visible: boolean; styles: Styles; disabled: boolean; isVideoEnabled: boolean; isScreenSharing: boolean;
  onVideo: () => void; onScreen: () => void;
}) {
  if (!visible) return null;
  return <View>
    <Button styles={styles} label={isVideoEnabled ? 'Turn camera off' : 'Turn camera on'}
      testID="group-call-toggle-video" disabled={disabled || isScreenSharing} onPress={onVideo} />
    <Button styles={styles} label={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}
      testID="group-call-toggle-screen" disabled={disabled} onPress={onScreen} />
  </View>;
}

/** Server lifecycle is authoritative; mock media controls remain local-only. */
export default function GroupCallPreview({
  visible, onClose, conversationId, currentUserId, localMock, memberCount = 0, snapshot, actions,
  callPeers = {}, activeSpeakerId = null, localStream = null,
  isMuted = false, isVideoEnabled = false, isScreenSharing = false,
}: Props) {
  const styles = useThemedStyles(createStyles);
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const joinedCallIdRef = useRef<string | null>(null);
  useEffect(() => { setMuted({}); setError(''); }, [snapshot?.callId]);
  useEffect(() => {
    const self = snapshot?.participants.find(person => person.userId === currentUserId);
    if (
      visible && snapshot && !localMock && self?.status === 'accepted' &&
      snapshot.call.status !== 'ended' && joinedCallIdRef.current !== snapshot.callId
    ) {
      actions.joinMedia?.(conversationId);
      joinedCallIdRef.current = snapshot.callId;
    }
    if (!snapshot || snapshot.call.status === 'ended' || self?.status !== 'accepted') joinedCallIdRef.current = null;
  }, [actions, conversationId, currentUserId, localMock, snapshot, visible]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Group call action failed'); }
    finally { setBusy(false); }
  };
  const transition = (id: string, action: GroupCallAction) => {
    void run(async () => {
      if (id === currentUserId) {
        await actions.transition(conversationId, action);
        if (action === 'accept') {
          actions.joinMedia?.(conversationId);
          joinedCallIdRef.current = snapshot?.callId ?? null;
        } else if (action === 'leave') {
          actions.leaveMedia?.(conversationId);
          joinedCallIdRef.current = null;
        }
      } else await actions.simulate(conversationId, id, action);
    });
  };
  const ended = snapshot?.call.status === 'ended';
  const acceptedCount = snapshot?.participants.filter(person => person.status === 'accepted').length ?? 0;
  const capacityReached = acceptedCount >= MAX_GROUP_CALL_PARTICIPANTS;
  const tooLarge = memberCount > MAX_GROUP_CALL_PARTICIPANTS;
  const canControlMedia = !localMock && !ended &&
    snapshot?.participants.some(person => person.userId === currentUserId && person.status === 'accepted');
  const streamUrl = (stream: WebrtcMediaStream | null | undefined) =>
    (stream as any)?.toURL?.() ?? null;
  const mediaParticipants = snapshot?.participants.map(person => {
    const peer = callPeers[person.userId];
    const self = person.userId === currentUserId;
    return {
      userId: person.userId,
      name: self ? 'You' : person.userId,
      streamUrl: self ? streamUrl(localStream) : streamUrl(peer?.stream),
      isMuted: self ? isMuted : peer?.isMuted ?? null,
      isVideoEnabled: self ? isVideoEnabled : peer?.isVideoEnabled ?? null,
      connectionState: peer?.connectionState ?? person.status,
      quality: peer?.quality ?? (person.status === 'accepted' ? 'connecting' : person.status),
      isSpeaking: peer?.isSpeaking ?? false,
      isScreenSharing: self ? isScreenSharing : peer?.isScreenSharing ?? false,
    };
  }) ?? [];
  return <Sheet visible={visible} onClose={onClose} title={localMock ? 'Group call preview' : 'Group call'}
    subtitle={localMock ? 'Local mock signaling — no actual media, microphone, camera, or WebRTC.' :
      'Group call mesh media connects accepted participants. Starting or accepting notifies other participants; calls support up to four connected people.'}
    testID="group-call-preview">
    {snapshot ? <Text style={styles.text} testID="group-call-status">
      {snapshot.call.mediaType} · {snapshot.call.status} (signaling)
    </Text> : null}
    {!snapshot || ended ? <View>
      {tooLarge ? <Text style={styles.text} accessibilityRole="alert" testID="group-call-size-limit">
        {GROUP_CALL_LIMIT_MESSAGE}
      </Text> : null}
      <Button styles={styles} label={localMock ? 'Start audio signaling preview' : 'Start audio call'} disabled={busy || tooLarge} testID="group-call-start-audio"
        onPress={() => { void run(async () => {
          await actions.start(conversationId, 'audio');
          actions.joinMedia?.(conversationId);
        }); }} />
      <Button styles={styles} label={localMock ? 'Start video signaling preview' : 'Start video call'} disabled={busy || tooLarge} testID="group-call-start-video"
        onPress={() => { void run(async () => {
          await actions.start(conversationId, 'video');
          actions.joinMedia?.(conversationId);
        }); }} />
    </View> : null}
    {snapshot ? <CallParticipantGrid participants={mediaParticipants} activeSpeakerId={activeSpeakerId} /> : null}
    <MediaControls visible={Boolean(canControlMedia)} styles={styles} disabled={busy || !localStream}
      isVideoEnabled={isVideoEnabled} isScreenSharing={isScreenSharing}
      onVideo={() => { void run(async () => { await actions.toggleVideo?.(); }); }}
      onScreen={() => { void run(async () => { await actions.toggleScreenShare?.(); }); }} />
    {snapshot && capacityReached && snapshot.participants.some(person => person.status === 'ringing') ? (
      <Text style={styles.text} accessibilityRole="alert" testID="group-call-capacity">
        Group call is full; mesh calls support up to four participants.
      </Text>
    ) : null}
    <ScrollView>
      <View style={styles.grid}>
        {snapshot?.participants.map(person => <Participant key={person.userId} person={person}
          self={person.userId === currentUserId} localMock={localMock}
          muted={localMock ? Boolean(muted[person.userId])
            : person.userId === currentUserId ? isMuted : Boolean(callPeers[person.userId]?.isMuted)}
          ended={Boolean(ended)} busy={busy} capacityReached={capacityReached} styles={styles}
          onMute={() => localMock
            ? setMuted(previous => ({ ...previous, [person.userId]: !previous[person.userId] }))
            : actions.toggleMute?.()}
          onAction={action => transition(person.userId, action)} />)}
      </View>
    </ScrollView>
    {error ? <Text style={styles.text} accessibilityRole="alert">{error}</Text> : null}
    <Button styles={styles} label="Close" disabled={busy} onPress={onClose} />
    <Text style={styles.secondary}>Closing this sheet does not leave the call. Use Leave call to signal departure.</Text>
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
