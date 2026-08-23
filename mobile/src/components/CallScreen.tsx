import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeInUp, FadeOutDown, FadeOutUp } from 'react-native-reanimated';
import { useThemedStyles } from '../ThemeContext';
import { spacing } from '../theme';
import CallStage from './CallStage';
import CallControls from './CallControls';
import CallTopBar from './CallTopBar';
import ErrorState from './ErrorState';
import ReconnectBanner from './ReconnectBanner';
import StatusBanner from './StatusBanner';
import type { CallStatus } from './StatusBanner';
import type { MutableRefObject } from 'react';
import type { ThemeColors } from '../theme';

const STATUS_AUTO_HIDE_MS = 3000;
const CONTROLS_AUTO_HIDE_MS = 3000;
const OVERLAY_FADE_MS = 180;

/**
 * Full-screen in-call screen whose overlay chrome (top bar + control deck)
 * auto-hides after a few seconds of inactivity and fades back in on tap.
 *
 * @param props
 */
export default function CallScreen({
  elapsedCallSeconds,
  connectionQuality,
  participantLabel = null,
  iceTransportPolicy,
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
}: Omit<Parameters<typeof CallStage>[0], 'onLayout'> & Parameters<typeof CallControls>[0] &
    Parameters<typeof CallTopBar>[0] &
    {
        onRetry: () => void;
        onLeave: () => void;
        status?: CallStatus;
        onStageLayout: Parameters<typeof CallStage>[0]['onLayout'];
        isReconnecting?: boolean;
    }) {
  const styles = useThemedStyles(createStyles);

  const [visibleStatus, setVisibleStatus] = useState(
    (null as CallStatus | null),
  );
  const [showControlsOverlay, setShowControlsOverlay] = useState(true);
  const controlsAutoHideTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null> = useRef(null);

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

      {/* The overlay container is a layout-only box with no visuals of its
          own, so it stays mounted and each group animates itself. Nesting the
          groups inside a *single* exiting parent would suppress their own
          exit animations, and Reanimated would unmount them with no
          transition at all. */}
      <View style={styles.overlay} pointerEvents="box-none">
        {!isCompact && showControlsOverlay ? (
          <Animated.View
            entering={FadeInDown.duration(OVERLAY_FADE_MS)}
            exiting={FadeOutUp.duration(OVERLAY_FADE_MS)}
            style={styles.topOverlay}
            pointerEvents="box-none">
            <CallTopBar
              elapsedCallSeconds={elapsedCallSeconds}
              connectionQuality={connectionQuality}
              participantLabel={participantLabel}
              iceTransportPolicy={iceTransportPolicy}
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
          </Animated.View>
        ) : null}

        {/* No extra bottom safe-area padding is added here: the app-level
            root container (App.js) already pads its bottom edge by the
            device's safe-area/gesture-navigation inset whenever a
            non-compact CallScreen is on screen, so these controls never
            sit under the system nav bar. */}
        {!isCompact && showControlsOverlay ? (
          <Animated.View
            entering={FadeInUp.duration(OVERLAY_FADE_MS)}
            exiting={FadeOutDown.duration(OVERLAY_FADE_MS)}
            style={styles.bottomOverlay}>
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
          </Animated.View>
        ) : null}
      </View>
    </Pressable>
  );
}

const createStyles = (_colors: ThemeColors) =>
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
