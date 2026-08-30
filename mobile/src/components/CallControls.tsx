import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../ThemeContext';
import { fontScaleCaps, spacing, typography } from '../theme';
import { describeScreenShareDelivery } from '../callUx';
import AudioOutputMenu from './AudioOutputMenu';
import IconButton from './IconButton';
import { ListItem, Sheet } from './primitives';
import type { ScreenShareDelivery } from '../callUx';
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
  /** How far the share has got towards reaching the remote peer. */
  screenShareDelivery?: ScreenShareDelivery;
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

type CallControlsStyles = ReturnType<typeof createStyles>;

function PrimaryCallControls({
  isMuted,
  isVideoEnabled,
  hasLocalStream,
  audioDevices,
  isSpeakerEnabled,
  isScreenSharing,
  isAudioOnly,
  onMuteToggle,
  onVideoToggle,
  onChooseAudioOutput,
  onCameraSwitch,
  onScreenShareToggle,
  onOpenMore,
  styles,
}: Pick<CallControlsProps, 'isMuted' | 'isVideoEnabled' | 'hasLocalStream' | 'audioDevices' |
  'isSpeakerEnabled' | 'isScreenSharing' | 'isAudioOnly' | 'onMuteToggle' | 'onVideoToggle' |
  'onChooseAudioOutput' | 'onCameraSwitch' | 'onScreenShareToggle'> & {
  onOpenMore: () => void;
  styles: CallControlsStyles;
}) {
  if (!onScreenShareToggle) {
    return (
      <View style={styles.mediaRow}>
        <MediaControlButtons
          isMuted={isMuted}
          isVideoEnabled={isVideoEnabled}
          hasLocalStream={hasLocalStream}
          audioDevices={audioDevices}
          isSpeakerEnabled={isSpeakerEnabled}
          isScreenSharing={isScreenSharing}
          isAudioOnly={isAudioOnly}
          onMuteToggle={onMuteToggle}
          onVideoToggle={onVideoToggle}
          onChooseAudioOutput={onChooseAudioOutput}
          onCameraSwitch={onCameraSwitch}
        />
      </View>
    );
  }
  return (
    <View style={styles.mediaRow}>
      <MediaControlButtons
        isMuted={isMuted}
        isVideoEnabled={isVideoEnabled}
        hasLocalStream={hasLocalStream}
        audioDevices={audioDevices}
        isSpeakerEnabled={isSpeakerEnabled}
        isScreenSharing={isScreenSharing}
        isAudioOnly={isAudioOnly}
        onMuteToggle={onMuteToggle}
        onVideoToggle={onVideoToggle}
        onChooseAudioOutput={onChooseAudioOutput}
        onCameraSwitch={onCameraSwitch}
      />
      <IconButton
        icon="more"
        onPress={onOpenMore}
        variant={isScreenSharing ? 'active' : 'default'}
        selected={isScreenSharing}
        size={56}
        accessibilityLabel="More call options"
        accessibilityHint="Opens screen sharing options"
        testID="control-more"
      />
    </View>
  );
}

function MediaControlButtons({
  isMuted,
  isVideoEnabled,
  hasLocalStream,
  audioDevices,
  isSpeakerEnabled,
  isScreenSharing,
  isAudioOnly,
  onMuteToggle,
  onVideoToggle,
  onChooseAudioOutput,
  onCameraSwitch,
}: Pick<CallControlsProps, 'isMuted' | 'isVideoEnabled' | 'hasLocalStream' | 'audioDevices' |
  'isSpeakerEnabled' | 'isScreenSharing' | 'isAudioOnly' | 'onMuteToggle' | 'onVideoToggle' |
  'onChooseAudioOutput' | 'onCameraSwitch'>) {
  return (
    <>
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
    </>
  );
}

function ScreenShareOptions({
  visible,
  onClose,
  isScreenSharing,
  isTogglingScreenShare,
  isScreenAudioEnabled,
  isScreenShareSupported,
  onScreenShareToggle,
  onScreenAudioToggle,
}: Pick<CallControlsProps, 'isScreenSharing' | 'isTogglingScreenShare' | 'isScreenAudioEnabled' |
  'isScreenShareSupported' | 'onScreenShareToggle' | 'onScreenAudioToggle'> & {
  visible: boolean;
  onClose: () => void;
}) {
  if (!onScreenShareToggle) return null;
  const sharingTitle = isTogglingScreenShare
    ? (isScreenSharing ? 'Stopping…' : 'Starting…')
    : (isScreenSharing ? 'Stop sharing your screen' : 'Share your screen');
  const unsupportedSubtitle = isScreenShareSupported ? null : 'Not supported on this device';
  return (
    <Sheet visible={visible} onClose={onClose} title="More options" testID="call-more-sheet">
      <ListItem
        title={sharingTitle}
        subtitle={unsupportedSubtitle}
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
          onClose();
          onScreenShareToggle();
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
  );
}

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
  screenShareDelivery = 'idle',
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

  return (
    <View style={styles.controls}>
      <PrimaryCallControls
        isMuted={isMuted}
        isVideoEnabled={isVideoEnabled}
        hasLocalStream={hasLocalStream}
        audioDevices={audioDevices}
        isSpeakerEnabled={isSpeakerEnabled}
        isScreenSharing={isScreenSharing}
        isAudioOnly={isAudioOnly}
        onMuteToggle={onMuteToggle}
        onVideoToggle={onVideoToggle}
        onChooseAudioOutput={onChooseAudioOutput}
        onCameraSwitch={onCameraSwitch}
        onScreenShareToggle={onScreenShareToggle}
        onOpenMore={() => setIsMoreOpen(true)}
        styles={styles}
      />

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
          {describeScreenShareDelivery(screenShareDelivery, isScreenAudioShared)}
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

      <ScreenShareOptions
        visible={isMoreOpen}
        onClose={() => setIsMoreOpen(false)}
        isScreenSharing={isScreenSharing}
        isTogglingScreenShare={isTogglingScreenShare}
        isScreenAudioEnabled={isScreenAudioEnabled}
        isScreenShareSupported={isScreenShareSupported}
        onScreenShareToggle={onScreenShareToggle}
        onScreenAudioToggle={onScreenAudioToggle}
      />
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
