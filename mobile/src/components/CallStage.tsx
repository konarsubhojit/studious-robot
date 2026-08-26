import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import SafeRTCView from '../SafeRTCView';
import { useThemedStyles } from '../ThemeContext';
import { overlay, radius, spacing, typography } from '../theme';
import DraggablePip from './DraggablePip';
import { Avatar } from './primitives';
import type { Gesture } from 'react-native-gesture-handler';
import type { ThemeColors } from '../theme';

export type CallStageProps = {
  onLayout: (event: object) => void;
  mainStreamUrl: string | null;
  hasMainStream: boolean;
  pipStreamUrl: string | null;
  hasPipStream: boolean;
  mirrorPip: boolean;
  /** Mirror the main stream (true when local front camera is primary). */
  mirrorMain?: boolean;
  pipGesture: ReturnType<typeof Gesture.Race>;
  animatedPipStyle: object;
  /** Local microphone muted state (forwarded to PiP overlay). */
  isMuted?: boolean;
  /** Local camera on/off state (forwarded to PiP overlay). */
  isVideoEnabled?: boolean;
  isCompact?: boolean;
  /** Local user is presenting their screen. */
  isScreenSharing?: boolean;
  /** Remote peer is presenting their screen. */
  isRemoteScreenSharing?: boolean;
  /** Remote participant name/id, used in the "they are presenting" banner. */
  participantLabel?: string | null;
  /**
   * No video will ever appear on this stage — an audio call, or a peer whose
   * camera is off. Draws the ambient canvas instead of a black rectangle.
   */
  isAudioOnly?: boolean;
  /** Sub-heading under the avatar on the ambient canvas ("Ringing…", "02:14"). */
  audioStatusLabel?: string | null;
};

/**
 * The call canvas: the primary stream plus an optional PiP self-view, or — when
 * there is no picture to show — a large avatar on the ambient background.
 *
 * An audio call used to land here as an empty black rectangle reading "Waiting
 * for someone to join…" for its entire duration, because the stage only asked
 * whether a *stream* existed, and an audio call has one. It now asks whether
 * there is a *picture*, and when there isn't it shows who you are talking to.
 *
 * `ambient` is fixed-dark in both schemes (like `stage`), so its foreground is
 * `onOverlay` rather than the scheme's `onSurface`.
 */
export default function CallStage({
  onLayout,
  mainStreamUrl,
  hasMainStream,
  pipStreamUrl,
  hasPipStream,
  mirrorPip,
  mirrorMain = false,
  pipGesture,
  animatedPipStyle,
  isMuted = false,
  isVideoEnabled = true,
  isCompact = false,
  isScreenSharing = false,
  isRemoteScreenSharing = false,
  participantLabel = null,
  isAudioOnly = false,
  audioStatusLabel = null,
}: CallStageProps) {
  const styles = useThemedStyles(createStyles);

  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  // Local presenting state takes precedence if somehow both are true at once.
  const presenterBannerText = isScreenSharing
    ? "You're presenting"
    : isRemoteScreenSharing
    ? `${participantLabel || 'They'} are presenting`
    : null;

  return (
    <View
      style={[
        styles.callStage,
        isCompact && styles.callStageCompact,
        isLandscape && styles.callStageLandscape,
      ]}
      onLayout={onLayout}>
      {isAudioOnly ? (
        <View style={styles.ambientStage} testID="call-stage-ambient">
          <Avatar id={participantLabel || ''} size={isCompact ? 'lg' : 'xl'} />
          {/* Reflow, not a cap: the ambient canvas is `flex: 1` and centred, so
              it has a whole screen of room. Its entire job is to say who you
              are talking to, and "Alexandr…" is the one truncation that would
              destroy the surface's meaning, so the name wraps instead. */}
          <Text style={styles.ambientName} numberOfLines={2} accessibilityRole="header">
            {participantLabel || 'Unknown'}
          </Text>
          {audioStatusLabel ? (
            <Text style={styles.ambientStatus} testID="call-stage-ambient-status">
              {audioStatusLabel}
            </Text>
          ) : null}
        </View>
      ) : hasMainStream ? (
        <SafeRTCView
          fallbackLabel="Call video unavailable"
          style={styles.remoteStream}
          streamURL={mainStreamUrl}
          objectFit="cover"
          mirror={mirrorMain}
          zOrder={0}
        />
      ) : (
        <View
          style={styles.remotePlaceholder}
          accessibilityLiveRegion="polite"
          accessibilityRole="alert">
          <Text style={styles.remotePlaceholderText}>Waiting for someone to join…</Text>
        </View>
      )}

      {!isCompact && presenterBannerText ? (
        <View
          style={styles.presenterBanner}
          testID="presenter-banner"
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          accessibilityRole="alert">
          <Text style={styles.presenterBannerText}>{presenterBannerText}</Text>
        </View>
      ) : null}

      {!isCompact && !isAudioOnly && hasPipStream ? (
        <DraggablePip
          gesture={pipGesture}
          animatedStyle={animatedPipStyle}
          streamURL={pipStreamUrl}
          mirror={mirrorPip}
          isMuted={isMuted}
          isVideoEnabled={isVideoEnabled}
        />
      ) : null}
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    callStage: {
      flex: 1,
      minHeight: 0,
      borderRadius: 0,
      overflow: 'hidden',
      marginBottom: 0,
      backgroundColor: colors.stage,
      borderWidth: 0,
    },
    callStageCompact: {
      marginBottom: 0,
      minHeight: 0,
      borderRadius: 0,
      borderWidth: 0,
    },
    callStageLandscape: {
      minHeight: 120,
    },
    remoteStream: {
      flex: 1,
      backgroundColor: colors.stageDark,
    },
    ambientStage: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      backgroundColor: colors.ambient,
    },
    ambientName: {
      ...typography.display,
      color: colors.onOverlay,
      textAlign: 'center',
    },
    ambientStatus: {
      ...typography.body,
      // Full-strength `onOverlay` like every other label over a dark surface:
      // hierarchy here comes from the type scale, not from a faded colour that
      // would drop below AA against `ambient`.
      color: colors.onOverlay,
      textAlign: 'center',
    },
    remotePlaceholder: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.backgroundAlt,
    },
    remotePlaceholderText: {
      color: colors.textMuted,
      fontSize: 16,
    },
    presenterBanner: {
      position: 'absolute',
      top: spacing.sm,
      alignSelf: 'center',
      // Reflow, not a cap: absolutely positioned and centred, so its width is
      // content-driven and unbounded, while the stage around it clips
      // (`overflow: 'hidden'`). Bounding the pill lets "<name> are presenting"
      // wrap inside it at large font scales rather than running off both edges.
      maxWidth: '90%',
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      backgroundColor: overlay.scrimMedium,
    },
    presenterBannerText: {
      color: colors.accent,
      ...typography.hint,
      fontWeight: '700',
    },
  });
