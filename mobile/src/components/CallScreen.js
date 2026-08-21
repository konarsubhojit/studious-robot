import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useThemedStyles } from '../ThemeContext';
import { spacing } from '../theme';
import CallStage from './CallStage';
import CallControls from './CallControls';
import CallTopBar from './CallTopBar';
import ErrorState from './ErrorState';
import ReconnectBanner from './ReconnectBanner';
import StatusBanner from './StatusBanner';

const STATUS_AUTO_HIDE_MS = 3000;
const CONTROLS_AUTO_HIDE_MS = 3000;
const OVERLAY_FADE_MS = 180;

/**
 * Full-screen in-call screen whose overlay chrome (top bar + control deck)
 * auto-hides after a few seconds of inactivity and fades back in on tap.
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
  const styles = useThemedStyles(createStyles);

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
      setVisibleStatus(current =>
        current?.message === message && current?.severity === severity ? null : current,
      );
    }, STATUS_AUTO_HIDE_MS);

    return () => clearTimeout(timeout);
  }, [isCompact, isReconnecting, status?.message, status?.severity]);

  // Leaving compact mode (Picture-in-Picture / minimised call) must bring the
  // chrome back: the overlay was force-hidden on the way in, and without this
  // the restored full-screen call has no visible controls at all until the
  // user happens to tap the video.
  useEffect(() => {
    if (!isCompact) setShowControlsOverlay(true);
  }, [isCompact]);

  // Every timer this screen owns is cleared on unmount, so a call that ends
  // mid-animation cannot hide (or re-show) the controls of the *next* call.
  useEffect(() => clearControlsAutoHide, [clearControlsAutoHide]);

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
      onPress={() => setShowControlsOverlay(prev => !prev)}
      testID="call-screen-root">
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
        <Animated.View
          entering={FadeIn.duration(OVERLAY_FADE_MS)}
          exiting={FadeOut.duration(OVERLAY_FADE_MS)}
          style={styles.overlay}
          pointerEvents="box-none">
          <View style={styles.topOverlay}>
            <CallTopBar
              elapsedCallSeconds={elapsedCallSeconds}
              connectionQuality={connectionQuality}
              participantLabel={participantLabel}
              onMinimize={onMinimize}
            />
            {isReconnecting ? <ReconnectBanner onRetry={onRetry} /> : null}
            {visibleStatus?.severity === 'error' ? (
              <ErrorState
                title="Call problem"
                description={visibleStatus.message}
                actionLabel="Retry connection"
                actionHint="Renegotiates the call connection now"
                onAction={onRetry}
                style={styles.inCallError}
                testID="call-error-state"
              />
            ) : visibleStatus ? (
              <StatusBanner
                status={visibleStatus}
                style={styles.inCallStatus}
                textStyle={styles.inCallStatusText}
              />
            ) : null}
          </View>

          {/* No extra bottom safe-area padding is added here: the app-level
              root container (App.js) already pads its bottom edge by the
              device's safe-area/gesture-navigation inset whenever a
              non-compact CallScreen is on screen, so these controls never
              sit under the system nav bar. */}
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
        </Animated.View>
      ) : null}
    </Pressable>
  );
}

const createStyles = colors =>
  StyleSheet.create({
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
      ...StyleSheet.absoluteFill,
      // Pinned above the video stage (and any PiP window) so the control deck
      // can never end up interleaved with the layers it floats over.
      zIndex: 2,
      elevation: 2,
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
    inCallError: {
      alignSelf: 'flex-start',
      maxWidth: '80%',
      marginBottom: 0,
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
