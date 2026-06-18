import { StyleSheet, View } from 'react-native';
import { colors, spacing } from '../theme';
import AppButton from './AppButton';
import AudioOutputMenu from './AudioOutputMenu';

/**
 * In-call control deck: mute, camera on/off, audio-output picker, camera swap,
 * and leave.  The audio-output picker lets the user route to speaker, earpiece,
 * Bluetooth, or a wired headset.
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
        <AppButton
          title={isMuted ? 'Unmute' : 'Mute'}
          onPress={onMuteToggle}
          active={isMuted}
          disabled={!hasLocalStream}
          accessibilityLabel={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          testID="control-mute"
        />
        <AppButton
          title={isVideoEnabled ? 'Video Off' : 'Video On'}
          onPress={onVideoToggle}
          active={!isVideoEnabled}
          disabled={!hasLocalStream}
          accessibilityLabel={isVideoEnabled ? 'Turn camera off' : 'Turn camera on'}
          testID="control-video"
        />
        <AudioOutputMenu
          available={audioDevices?.available}
          selected={audioDevices?.selected}
          isSpeakerEnabled={isSpeakerEnabled}
          onSelect={onChooseAudioOutput}
        />
        <AppButton
          title="Swap Camera"
          onPress={onCameraSwitch}
          disabled={!hasLocalStream}
          accessibilityLabel="Switch between front and back camera"
          testID="control-swap-camera"
        />
      </View>

      <AppButton
        title="Leave"
        onPress={onLeave}
        style={styles.leaveButton}
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
  },
  mediaRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  leaveButton: {
    backgroundColor: colors.danger,
  },
});
