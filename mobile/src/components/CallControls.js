import { StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../ThemeContext';
import { spacing } from '../theme';
import AudioOutputMenu from './AudioOutputMenu';
import IconButton from './IconButton';

/**
 * In-call control deck: mute, camera on/off, audio-output picker, camera swap,
 * screen sharing (with an optional screen-audio toggle) and leave.
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
  isScreenSharing = false,
  isScreenAudioEnabled = false,
  isScreenAudioShared = false,
  isScreenShareSupported = true,
  onMuteToggle,
  onVideoToggle,
  onChooseAudioOutput,
  onCameraSwitch,
  onScreenShareToggle,
  onScreenAudioToggle,
  onLeave,
}) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.controls}>
      <View style={styles.mediaRow}>
        <IconButton
          icon={isMuted ? 'micOff' : 'micOn'}
          label={isMuted ? 'Unmute' : 'Mute'}
          onPress={onMuteToggle}
          variant={isMuted ? 'active' : 'default'}
          disabled={!hasLocalStream}
          size={56}
          accessibilityLabel={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          testID="control-mute"
        />
        <IconButton
          icon={isVideoEnabled ? 'videoOn' : 'videoOff'}
          label={isVideoEnabled ? 'Stop video' : 'Start video'}
          onPress={onVideoToggle}
          variant={isVideoEnabled ? 'default' : 'active'}
          disabled={!hasLocalStream || isScreenSharing}
          size={56}
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
          icon="cameraSwitch"
          onPress={onCameraSwitch}
          variant="default"
          disabled={!hasLocalStream || isScreenSharing}
          size={56}
          accessibilityLabel="Switch between front and back camera"
          testID="control-swap-camera"
        />
      </View>

      {onScreenShareToggle ? (
        <View style={styles.mediaRow}>
          <IconButton
            icon={isScreenSharing ? 'screenShareOff' : 'screenShare'}
            onPress={onScreenShareToggle}
            variant={isScreenSharing ? 'active' : 'default'}
            disabled={!isScreenShareSupported}
            size={56}
            accessibilityLabel={isScreenSharing ? 'Stop sharing your screen' : 'Share your screen'}
            testID="control-screen-share"
          />
          {onScreenAudioToggle ? (
            <IconButton
              icon={isScreenAudioEnabled ? 'screenAudioOn' : 'screenAudioOff'}
              onPress={onScreenAudioToggle}
              variant={isScreenAudioEnabled ? 'active' : 'default'}
              disabled={!isScreenShareSupported}
              size={56}
              accessibilityLabel={
                isScreenAudioEnabled
                  ? 'Do not include screen audio when sharing'
                  : 'Include screen audio when sharing'
              }
              testID="control-screen-audio"
            />
          ) : null}
        </View>
      ) : null}

      {isScreenSharing ? (
        <Text style={styles.sharingLabel} testID="screen-share-indicator">
          {isScreenAudioShared ? 'Sharing screen with audio' : 'Sharing screen'}
        </Text>
      ) : null}

      <IconButton
        icon="callEnd"
        label="Leave"
        onPress={onLeave}
        variant="danger"
        size={64}
        accessibilityLabel="Leave the call"
        testID="control-leave"
      />
    </View>
  );
}

const createStyles = colors =>
  StyleSheet.create({
    controls: {
      gap: spacing.sm,
      marginBottom: spacing.sm,
      alignItems: 'center',
    },
    sharingLabel: {
      color: colors.textPrimary,
      fontSize: 13,
      fontWeight: '600',
    },
    mediaRow: {
      flexDirection: 'row',
      gap: spacing.lg,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
