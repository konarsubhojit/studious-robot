import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeInUp, FadeOutDown, FadeOutUp } from 'react-native-reanimated';
import { useThemedStyles } from '../ThemeContext';
import { motion, spacing } from '../theme';
import useReducedMotion from '../hooks/useReducedMotion';
import { formatCallDuration } from '../callUx';
import CallStage from './CallStage';
import CallControls from './CallControls';
import CallTopBar from './CallTopBar';
import ErrorState from './ErrorState';
import ReconnectBanner from './ReconnectBanner';
import StatusBanner from './StatusBanner';
import type { CallStatus } from './StatusBanner';
import type { CallRecoveryStatus } from '../hooks/useCallFlow';
import type { MutableRefObject } from 'react';
import type { ThemeColors } from '../theme';

/**
 * Full-screen in-call screen whose overlay chrome (top bar + control deck)
 * auto-hides after a few seconds of inactivity and fades back in on tap.
 *
 * Auto-hide exists to get chrome out of the way of *video*. It is therefore
 * suppressed whenever hiding the chrome would only take away information:
 * on an audio call (nothing underneath to reveal), while a recovery banner or
 * an error is showing, and when the user has asked for reduced motion — in
 * which case the fades are dropped too, not merely shortened.
 *
 * @param props
 */
export default function CallScreen({
  elapsedCallSeconds,
  connectionQuality,
  participantLabel = null,
  iceTransportPolicy,
  isReconnecting,
  recoveryStatus = null,
  isConnectionLost = false,
  onRetry,
  onStageLayout,
  onTopChromeLayout,
  onBottomChromeLayout,
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
  isTogglingScreenShare,
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
  isAudioOnly = false,
}: Omit<Parameters<typeof CallStage>[0], 'onLayout'> & Parameters<typeof CallControls>[0] &
    Parameters<typeof CallTopBar>[0] &
    {
        onRetry: () => void;
        onLeave: () => void;
        status?: CallStatus;
        onStageLayout: Parameters<typeof CallStage>[0]['onLayout'];
        onTopChromeLayout?: Parameters<typeof CallStage>[0]['onLayout'];
        onBottomChromeLayout?: Parameters<typeof CallStage>[0]['onLayout'];
        isReconnecting?: boolean;
        recoveryStatus?: CallRecoveryStatus | null;
        isConnectionLost?: boolean;
    }) {
  const styles = useThemedStyles(createStyles);
  const reduceMotion = useReducedMotion();
  const overlayFadeMs = reduceMotion ? motion.duration.instant : motion.duration.fast;
  // A media-only failure (ICE down, socket up) is a recovery too: gating the
  // banner on socket loss alone left the most common failure case invisible.
  // A spent recovery budget counts too: the episode closes with it, and the
  // banner used to vanish at exactly the moment the news was worst.
  const isRecovering = Boolean(isReconnecting || recoveryStatus || isConnectionLost);

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
    }, motion.delay.autoHide);
  }, [clearControlsAutoHide]);

  useEffect(() => {
    const message = status?.message?.trim();
    const severity = status?.severity || 'info';

    if (isCompact || isRecovering || !message) {
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
    }, motion.delay.autoHide);

    return () => clearTimeout(timeout);
  }, [isCompact, isRecovering, status?.message, status?.severity]);

  // Leaving compact mode (Picture-in-Picture / minimised call) must bring the
  // chrome back: the overlay was force-hidden on the way in, and without this
  // the restored full-screen call has no visible controls at all until the
  // user happens to tap the video.
  useEffect(() => {
    if (!isCompact) setShowControlsOverlay(true);
  }, [isCompact]);

  // An audio call has nothing under the chrome, so a deck hidden by a stray tap
  // (or by a video segment that has since ended) would be unrecoverable-looking.
  useEffect(() => {
    if (isAudioOnly && !isCompact) setShowControlsOverlay(true);
  }, [isAudioOnly, isCompact]);

  // Every timer this screen owns is cleared on unmount, so a call that ends
  // mid-animation cannot hide (or re-show) the controls of the *next* call.
  useEffect(() => clearControlsAutoHide, [clearControlsAutoHide]);

  useEffect(() => {
    if (isCompact) {
      clearControlsAutoHide();
      setShowControlsOverlay(false);
      return undefined;
    }
    const chromeIsTheOnlyContent = isAudioOnly;
    const hidingWouldSwallowAWarning = isRecovering || visibleStatus?.severity === 'error';
    if (showControlsOverlay && !chromeIsTheOnlyContent && !hidingWouldSwallowAWarning) {
      scheduleControlsAutoHide();
    } else {
      clearControlsAutoHide();
    }
    return clearControlsAutoHide;
  }, [
    clearControlsAutoHide,
    isAudioOnly,
    isCompact,
    isRecovering,
    scheduleControlsAutoHide,
    showControlsOverlay,
    visibleStatus?.severity,
  ]);

  return (
    <Pressable
      style={[styles.callScreen, isCompact && styles.callScreenCompact]}
      onPress={() => setShowControlsOverlay(prev => !prev)}
      accessibilityRole="button"
      accessibilityLabel={showControlsOverlay ? 'Hide call controls' : 'Show call controls'}
      accessibilityHint="Toggles the in-call control overlay"
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
        isAudioOnly={isAudioOnly}
        audioStatusLabel={
          isConnectionLost
            ? 'Connection lost'
            : isRecovering
            ? 'Reconnecting…'
            : formatCallDuration(elapsedCallSeconds)
        }
      />

      {/* The overlay container is a layout-only box with no visuals of its
          own, so it stays mounted and each group animates itself. Nesting the
          groups inside a *single* exiting parent would suppress their own
          exit animations, and Reanimated would unmount them with no
          transition at all. */}
      <View style={styles.overlay} pointerEvents="box-none">
        {!isCompact && showControlsOverlay ? (
          <Animated.View
            entering={FadeInDown.duration(overlayFadeMs)}
            exiting={FadeOutUp.duration(overlayFadeMs)}
            style={styles.topOverlay}
            onLayout={onTopChromeLayout}
            pointerEvents="box-none">
            <CallTopBar
              elapsedCallSeconds={elapsedCallSeconds}
              connectionQuality={connectionQuality}
              participantLabel={participantLabel}
              iceTransportPolicy={iceTransportPolicy}
              onMinimize={onMinimize}
            />
            {isRecovering ? (
              <ReconnectBanner
                onRetry={onRetry}
                recovery={recoveryStatus}
                isConnectionLost={isConnectionLost}
              />
            ) : null}
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
            entering={FadeInUp.duration(overlayFadeMs)}
            exiting={FadeOutDown.duration(overlayFadeMs)}
            onLayout={onBottomChromeLayout}
            style={styles.bottomOverlay}>
            <CallControls
              isMuted={isMuted}
              isVideoEnabled={isVideoEnabled}
              isAudioOnly={isAudioOnly}
              hasLocalStream={hasLocalStream}
              audioDevices={audioDevices}
              isSpeakerEnabled={isSpeakerEnabled}
              isScreenSharing={isScreenSharing}
              isTogglingScreenShare={isTogglingScreenShare}
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
