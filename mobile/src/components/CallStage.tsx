import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import SafeRTCView from '../SafeRTCView';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';
import DraggablePip from './DraggablePip';
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
};

/**
 * The full-screen video stage: primary stream plus optional PiP self-view.
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
      {hasMainStream ? (
        <SafeRTCView
          fallbackLabel="Call video unavailable"
          style={styles.remoteStream}
          streamURL={mainStreamUrl}
          objectFit="cover"
          mirror={mirrorMain}
          zOrder={0}
        />
      ) : (
        <View style={styles.remotePlaceholder}>
          <Text style={styles.remotePlaceholderText}>Waiting for someone to join…</Text>
        </View>
      )}

      {!isCompact && presenterBannerText ? (
        <View style={styles.presenterBanner} testID="presenter-banner" pointerEvents="none">
          <Text style={styles.presenterBannerText}>{presenterBannerText}</Text>
        </View>
      ) : null}

      {!isCompact && hasPipStream ? (
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

/** @param {import('../theme').ThemeColors} colors */
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
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      backgroundColor: 'rgba(0, 0, 0, 0.55)',
    },
    presenterBannerText: {
      color: colors.accent,
      ...typography.hint,
      fontWeight: '700',
    },
  });
