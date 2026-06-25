import { StyleSheet, View } from 'react-native';
import { colors, spacing } from '../theme';
import AudioOutputMenu from './AudioOutputMenu';
import IconButton from './IconButton';

/**
 * In-call control deck: mute, camera on/off, audio-output picker, camera swap,
 * and leave.
 *
 * All action buttons use icon-only circular IconButton components for a clean,
 * professional look.  The leave button is visually distinct (danger variant).
 */
export default function CallControls({
  isMuted,
  isVideoEnabled,
  hasLocalStream,
  audioDevices,
  isSpeakerEnabled,
  onMuteToggle,
  onVideoToggle,
  onChooseAudioOutput,
  onCameraSwitch,
  onLeave,
}) {
  return (
    <View style={styles.controls}>
      <View style={styles.mediaRow}>
        <IconButton
          icon={isMuted ? '🔇' : '🎤'}
          label={isMuted ? 'Unmute' : 'Mute'}
          onPress={onMuteToggle}
          variant={isMuted ? 'active' : 'default'}
          disabled={!hasLocalStream}
          size={52}
          accessibilityLabel={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          testID="control-mute"
        />
        <IconButton
          icon={isVideoEnabled ? '📷' : '🚫'}
          label={isVideoEnabled ? 'Video off' : 'Video on'}
          onPress={onVideoToggle}
          variant={isVideoEnabled ? 'default' : 'active'}
          disabled={!hasLocalStream}
          size={52}
          accessibilityLabel={isVideoEnabled ? 'Turn camera off' : 'Turn camera on'}
          testID="control-video"
        />
        <AudioOutputMenu
          available={audioDevices?.available}
          selected={audioDevices?.selected}
          isSpeakerEnabled={isSpeakerEnabled}
          onSelect={onChooseAudioOutput}
        />
        <IconButton
          icon="🔄"
          label="Flip"
          onPress={onCameraSwitch}
          variant="default"
          disabled={!hasLocalStream}
          size={52}
          accessibilityLabel="Switch between front and back camera"
          testID="control-swap-camera"
        />
      </View>

      <IconButton
        icon="✕"
        label="Leave"
        onPress={onLeave}
        variant="danger"
        size={56}
        accessibilityLabel="Leave the call"
        testID="control-leave"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  controls: {
    gap: spacing.sm,
    marginBottom: spacing.sm,
    alignItems: 'center',
  },
  mediaRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

