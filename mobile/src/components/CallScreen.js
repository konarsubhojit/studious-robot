import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { spacing } from '../theme';
import CallStage from './CallStage';
import CallControls from './CallControls';
import CallTopBar from './CallTopBar';
import ReconnectBanner from './ReconnectBanner';
import StatusBanner from './StatusBanner';

const STATUS_AUTO_HIDE_MS = 3000;
const CONTROLS_AUTO_HIDE_MS = 3000;

/**
 * Full-screen in-call screen with tap-to-toggle overlay controls.
 */
export default function CallScreen({
  elapsedCallSeconds,
  connectionQuality,
  participantLabel = null,
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
  isScreenSharing,
  isScreenAudioEnabled,
  isScreenAudioShared,
  isScreenShareSupported,
  isRemoteScreenSharing = false,
  onMuteToggle,
  onVideoToggle,
  onChooseAudioOutput,
  onCameraSwitch,
  onScreenShareToggle,
  onScreenAudioToggle,
  onLeave,
  onMinimize,
  status,
  isCompact = false,
}) {
  const [visibleStatus, setVisibleStatus] = useState(null);
  const [showControlsOverlay, setShowControlsOverlay] = useState(true);
  const controlsAutoHideTimerRef = useRef(null);

  const clearControlsAutoHide = useCallback(() => {
    if (controlsAutoHideTimerRef.current) {
      clearTimeout(controlsAutoHideTimerRef.current);
      controlsAutoHideTimerRef.current = null;
    }
  }, []);

  const scheduleControlsAutoHide = useCallback(() => {
    clearControlsAutoHide();
    controlsAutoHideTimerRef.current = setTimeout(() => {
      setShowControlsOverlay(false);
      controlsAutoHideTimerRef.current = null;
    }, CONTROLS_AUTO_HIDE_MS);
  }, [clearControlsAutoHide]);

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

  useEffect(() => {
    if (isCompact) {
      clearControlsAutoHide();
      setShowControlsOverlay(false);
      return undefined;
    }
    if (showControlsOverlay && visibleStatus?.severity !== 'error') {
      scheduleControlsAutoHide();
    } else {
      clearControlsAutoHide();
    }
    return clearControlsAutoHide;
  }, [
    clearControlsAutoHide,
    isCompact,
    scheduleControlsAutoHide,
    showControlsOverlay,
    visibleStatus?.severity,
  ]);

  return (
    <Pressable
      style={[styles.callScreen, isCompact && styles.callScreenCompact]}
      onPress={() => setShowControlsOverlay((prev) => !prev)}
      testID="call-screen-root"
    >
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
        isScreenSharing={isScreenSharing}
        isRemoteScreenSharing={isRemoteScreenSharing}
        participantLabel={participantLabel}
      />

      {!isCompact && showControlsOverlay ? (
        <View style={styles.overlay} pointerEvents="box-none">
          <View style={styles.topOverlay}>
            <CallTopBar
              elapsedCallSeconds={elapsedCallSeconds}
              connectionQuality={connectionQuality}
              participantLabel={participantLabel}
              onMinimize={onMinimize}
            />
            {isReconnecting ? <ReconnectBanner onRetry={onRetry} /> : null}
            {visibleStatus ? (
              <StatusBanner
                status={visibleStatus}
                style={styles.inCallStatus}
                textStyle={styles.inCallStatusText}
              />
            ) : null}
          </View>

          <View style={styles.bottomOverlay}>
            <CallControls
              isMuted={isMuted}
              isVideoEnabled={isVideoEnabled}
              hasLocalStream={hasLocalStream}
              audioDevices={audioDevices}
              isSpeakerEnabled={isSpeakerEnabled}
              isScreenSharing={isScreenSharing}
              isScreenAudioEnabled={isScreenAudioEnabled}
              isScreenAudioShared={isScreenAudioShared}
              isScreenShareSupported={isScreenShareSupported}
              onMuteToggle={onMuteToggle}
              onVideoToggle={onVideoToggle}
              onChooseAudioOutput={onChooseAudioOutput}
              onCameraSwitch={onCameraSwitch}
              onScreenShareToggle={onScreenShareToggle}
              onScreenAudioToggle={onScreenAudioToggle}
              onLeave={onLeave}
            />
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  callScreen: {
    flex: 1,
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
  callScreenCompact: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  topOverlay: {
    gap: spacing.sm,
  },
  bottomOverlay: {
    alignItems: 'center',
  },
  inCallStatus: {
    alignSelf: 'flex-start',
    maxWidth: '72%',
    marginBottom: 0,
  },
  inCallStatusText: {
    textAlign: 'left',
  },
});
