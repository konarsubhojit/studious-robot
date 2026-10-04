import { StyleSheet, Text, View } from 'react-native';
import SafeRTCView from '../SafeRTCView';
import { getParticipantGridLayout, orderParticipantsBySpeaker } from '../call/participantGrid';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';
import { Avatar } from './primitives';
import type { ThemeColors } from '../theme';

export type CallParticipantTile = {
  userId: string;
  name: string;
  streamUrl: string | null;
  isMuted: boolean | null;
  isVideoEnabled: boolean | null;
  connectionState: string;
  quality: string;
  isSpeaking?: boolean;
  isScreenSharing?: boolean;
};

type Props = {
  participants: readonly CallParticipantTile[];
  activeSpeakerId?: string | null;
  isCompact?: boolean;
};

export default function CallParticipantGrid({
  participants,
  activeSpeakerId = null,
  isCompact = false,
}: Props) {
  const styles = useThemedStyles(createStyles);
  if (!participants.length) return null;
  const speakerId = activeSpeakerId ?? participants.find(person => person.isSpeaking)?.userId ?? null;
  const ordered = orderParticipantsBySpeaker(participants, speakerId);
  const visible = isCompact
    ? ordered.filter(person => person.userId === speakerId).slice(0, 1)
    : ordered;
  const { columns } = getParticipantGridLayout(visible.length);

  return (
    <View
      style={[styles.grid, isCompact && styles.compactGrid]}
      testID="call-participant-grid"
      accessibilityLabel={`${participants.length} call participants`}>
      {visible.map(person => {
        const speaking = person.userId === speakerId;
        const hasVideo = Boolean(person.streamUrl && person.isVideoEnabled !== false);
        return (
          <View
            key={person.userId}
            style={[
              styles.tile,
              !isCompact && { width: `${100 / columns}%` },
              speaking && styles.activeSpeakerTile,
              isCompact && styles.compactTile,
            ]}
            testID={`call-participant-${person.userId}`}
            accessibilityLabel={`${person.name}${speaking ? ', speaking' : ''}`}>
            {hasVideo ? (
              <SafeRTCView
                style={styles.video}
                streamURL={person.streamUrl}
                objectFit={person.isScreenSharing ? 'contain' : 'cover'}
                mirror={false}
                zOrder={0}
              />
            ) : (
              <View style={styles.avatarSurface}>
                <Avatar id={person.userId} size={isCompact ? 'md' : 'lg'} />
              </View>
            )}
            <View style={styles.info}>
              <Text style={styles.name} numberOfLines={1}>{person.name}</Text>
              <Text style={styles.meta} numberOfLines={1}>
                {person.isMuted === null ? 'Mute status unavailable' : person.isMuted ? 'Muted' : 'Unmuted'}
                {' · '}
                {person.quality}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'center',
    gap: spacing.xs,
  },
  compactGrid: { flex: 1, justifyContent: 'center' },
  tile: {
    aspectRatio: 1.25,
    minWidth: '30%',
    overflow: 'hidden',
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: colors.stageDark,
  },
  activeSpeakerTile: { borderColor: colors.accent },
  compactTile: { width: '100%', aspectRatio: 1.5 },
  video: { ...StyleSheet.absoluteFill, backgroundColor: colors.stageDark },
  avatarSurface: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.ambient,
  },
  info: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
  },
  name: { ...typography.caption, fontWeight: '700', color: colors.onOverlay },
  meta: { ...typography.caption, color: colors.onOverlay },
});
