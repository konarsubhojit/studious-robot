import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../ThemeContext';
import { fontScaleCaps, spacing, typography } from '../theme';
import AudioOutputMenu from './AudioOutputMenu';
import IconButton from './IconButton';
import { ListItem, Sheet } from './primitives';
import type { ThemeColors } from '../theme';

export type CallControlsProps = {
  isMuted: boolean;
  isVideoEnabled: boolean;
  hasLocalStream: boolean;
  audioDevices?: { available?: string[]; selected?: string | null; };
  isSpeakerEnabled: boolean;
  isScreenSharing?: boolean;
  /** True while a start/stop is in flight (capture prompt, renegotiation). */
  isTogglingScreenShare?: boolean;
  isScreenAudioEnabled?: boolean;
  isScreenAudioShared?: boolean;
  isScreenShareSupported?: boolean;
  onMuteToggle: () => void;
  onVideoToggle: () => void;
  onChooseAudioOutput: (deviceId: string) => void;
  onCameraSwitch: () => void;
  onScreenShareToggle?: () => void;
  onScreenAudioToggle?: () => void;
  onLeave: () => void;
  /** Audio call: the camera controls have nothing to act on. */
  isAudioOnly?: boolean;
};

/**
 * In-call control deck: one primary row, a "More" sheet, and Leave.
 *
 * The deck used to be a flat list of up to seven equally-weighted circles
 * across two rows, which made "share my screen" as prominent as "mute" and
 * pushed Leave around as the second row appeared and disappeared. The four
 * controls people reach for mid-call (mute, camera, audio output, flip) stay
 * on the surface; the occasional ones move behind `more`. Leave keeps its own
 * row and its danger variant, and is never inside the sheet — ending a call
 * must never be two taps deep.
 */
export default function CallControls({
  isMuted,
  isVideoEnabled,
  hasLocalStream,
  audioDevices,
  isSpeakerEnabled,
  isScreenSharing = false,
  isTogglingScreenShare = false,
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
  isAudioOnly = false,
}: CallControlsProps) {
  const styles = useThemedStyles(createStyles);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const hasMoreActions = Boolean(onScreenShareToggle);

  return (
    <View style={styles.controls}>
      <View style={styles.mediaRow}>
        <IconButton
          icon={isMuted ? 'micOff' : 'micOn'}
          label={isMuted ? 'Unmute' : 'Mute'}
          onPress={onMuteToggle}
          variant={isMuted ? 'active' : 'default'}
          selected={isMuted}
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
          selected={!isVideoEnabled}
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
          disabled={!hasLocalStream || isScreenSharing || isAudioOnly}
          size={56}
          accessibilityLabel="Switch between front and back camera"
          testID="control-swap-camera"
        />
        {hasMoreActions ? (
          <IconButton
            icon="more"
            onPress={() => setIsMoreOpen(true)}
            variant={isScreenSharing ? 'active' : 'default'}
            selected={isScreenSharing}
            size={56}
            accessibilityLabel="More call options"
            accessibilityHint="Opens screen sharing options"
            testID="control-more"
          />
        ) : null}
      </View>

      {isScreenSharing ? (
        // Capped: the deck hangs off `CallScreen`'s `StyleSheet.absoluteFill`
        // overlay, pinned to the bottom edge with no scroll and nothing to
        // push. This caption sits between the primary row and `control-leave`,
        // so every line it gains drives Leave toward the screen edge — and
        // Leave is the one control that must never be hard to hit.
        <Text
          style={styles.sharingLabel}
          maxFontSizeMultiplier={fontScaleCaps.control}
          testID="screen-share-indicator">
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

      {hasMoreActions ? (
        <Sheet
          visible={isMoreOpen}
          onClose={() => setIsMoreOpen(false)}
          title="More options"
          testID="call-more-sheet">
          <ListItem
            title={
              isTogglingScreenShare
                ? isScreenSharing
                  ? 'Stopping…'
                  : 'Starting…'
                : isScreenSharing
                  ? 'Stop sharing your screen'
                  : 'Share your screen'
            }
            subtitle={
              isScreenShareSupported ? null : 'Not supported on this device'
            }
            icon={isScreenSharing ? 'screenShareOff' : 'screenShare'}
            // A toggle already in flight is inert, not silently ignored: the
            // hook drops the second tap either way, so the control has to say
            // so rather than looking unresponsive.
            disabled={!isScreenShareSupported || isTogglingScreenShare}
            accessibilityRole="switch"
            accessibilityState={{
              checked: isScreenSharing,
              disabled: !isScreenShareSupported || isTogglingScreenShare,
              busy: isTogglingScreenShare,
            }}
            onPress={() => {
              setIsMoreOpen(false);
              onScreenShareToggle?.();
            }}
            testID="control-screen-share"
          />
          {onScreenAudioToggle ? (
            <ListItem
              title="Include screen audio"
              subtitle={
                isScreenShareSupported
                  ? 'Shares what your device is playing while you present'
                  : 'Not supported on this device'
              }
              icon={isScreenAudioEnabled ? 'screenAudioOn' : 'screenAudioOff'}
              disabled={!isScreenShareSupported}
              accessibilityRole="switch"
              accessibilityState={{
                checked: isScreenAudioEnabled,
                disabled: !isScreenShareSupported,
              }}
              onPress={onScreenAudioToggle}
              testID="control-screen-audio"
            />
          ) : null}
        </Sheet>
      ) : null}
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    controls: {
      gap: spacing.sm,
      marginBottom: spacing.sm,
      alignItems: 'center',
    },
    sharingLabel: {
      ...typography.label,
      color: colors.textPrimary,
    },
    mediaRow: {
      flexDirection: 'row',
      gap: spacing.lg,
      // Top-aligned, not centre-aligned: a row mixes buttons that carry a
      // caption (mute, video) with ones that do not (audio output, camera
      // swap). Centring the *wrapper* heights pushes the caption-less circles
      // half a caption-height down, so the deck reads as visibly crooked.
      // Every circle in a row is the same diameter, so aligning their tops
      // aligns the icons exactly.
      alignItems: 'flex-start',
      justifyContent: 'center',
    },
  });
