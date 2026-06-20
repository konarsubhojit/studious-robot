import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../theme';
import CallStage from './CallStage';
import CallTopBar from './CallTopBar';
import DraggableCallControls from './DraggableCallControls';
import ReconnectBanner from './ReconnectBanner';
import StatusBanner from './StatusBanner';

const STATUS_AUTO_HIDE_MS = 3000;

/**
 * Full in-call screen: top bar, reconnect banner, video stage, floating
 * draggable controls, and the status line.  Purely presentational — all
 * behaviour is supplied via props from the useWebRTCCall /
 * usePictureInPicturePip hooks.
 */
export default function CallScreen({
  elapsedCallSeconds,
  connectionQuality,
  participantLabel,
  isReconnecting,
  onRetry,
  onStageLayout,
  mainStreamUrl,
  hasMainStream,
  pipStreamUrl,
  hasPipStream,
  mirrorPip,
  mirrorMain = false,
  pipGesture,
  animatedPipStyle,
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
  status,
  isCompact = false,
}) {
  const [visibleStatus, setVisibleStatus] = useState(null);

  useEffect(() => {
    const message = status?.message?.trim();
    const severity = status?.severity || 'info';

    if (isCompact || isReconnecting || !message) {
      setVisibleStatus(null);
      return undefined;
    }

    setVisibleStatus({ message, severity });
    if (severity === 'error') {
      return undefined;
    }

    const timeout = setTimeout(() => {
      setVisibleStatus((current) =>
        current?.message === message && current?.severity === severity ? null : current,
      );
    }, STATUS_AUTO_HIDE_MS);

    return () => clearTimeout(timeout);
  }, [isCompact, isReconnecting, status?.message, status?.severity]);

  return (
    <View style={[styles.callScreen, isCompact && styles.callScreenCompact]}>
      {!isCompact ? (
        <CallTopBar
          elapsedCallSeconds={elapsedCallSeconds}
          connectionQuality={connectionQuality}
          participantLabel={participantLabel}
        />
      ) : null}

      {!isCompact && isReconnecting ? <ReconnectBanner onRetry={onRetry} /> : null}

      {!isCompact && visibleStatus ? (
        <StatusBanner
          status={visibleStatus}
          style={styles.inCallStatus}
          textStyle={styles.inCallStatusText}
        />
      ) : null}

      <CallStage
        onLayout={onStageLayout}
        mainStreamUrl={mainStreamUrl}
        hasMainStream={hasMainStream}
        pipStreamUrl={pipStreamUrl}
        hasPipStream={hasPipStream}
        mirrorPip={mirrorPip}
        mirrorMain={mirrorMain}
        pipGesture={pipGesture}
        animatedPipStyle={animatedPipStyle}
        isMuted={isMuted}
        isVideoEnabled={isVideoEnabled}
        isCompact={isCompact}
      />

      {!isCompact ? (
        <DraggableCallControls
          isMuted={isMuted}
          isVideoEnabled={isVideoEnabled}
          hasLocalStream={hasLocalStream}
          audioDevices={audioDevices}
          isSpeakerEnabled={isSpeakerEnabled}
          onMuteToggle={onMuteToggle}
          onVideoToggle={onVideoToggle}
          onChooseAudioOutput={onChooseAudioOutput}
          onCameraSwitch={onCameraSwitch}
          onLeave={onLeave}
        />
      ) : null}

    </View>
  );
}

const styles = StyleSheet.create({
  callScreen: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  callScreenCompact: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
  inCallStatus: {
    alignSelf: 'flex-start',
    maxWidth: '72%',
    marginBottom: spacing.sm,
  },
  inCallStatusText: {
    textAlign: 'left',
  },
});
