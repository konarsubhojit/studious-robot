import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { logInfo, logWarn } from '../appLogger';
import {
  formatPlaybackTime,
  getAudioPlaybackState,
  isAudioPlaybackAvailable,
  pauseAudio,
  playAudio,
  resumeAudio,
  seekAudio,
  subscribeAudioPlayback,
} from '../audioPlayback';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, touchSlop, typography } from '../theme';
import { ICONS, loadVectorIcons } from '../vectorIcons';
import type { ThemeColors } from '../theme';

/** Height (dp) of the scrubber track — small, but still comfortably tappable with the hit slop below. */
const TRACK_HEIGHT = 4;

/**
 * Inline player for a voice note or audio attachment.
 *
 * All players in a conversation share the one native player owned by
 * `audioPlayback`, so this component only ever renders the shared state: when
 * another bubble starts playing, this one falls back to its idle look without
 * any coordination between the rows.
 *
 * @param props
 */
export default function AudioAttachmentPlayer({ uri, durationMs = 0, isOwn = false, testID = 'chat-audio-player' }: {
        uri?: string | null;
        durationMs?: number | null;
        isOwn?: boolean;
        testID?: string;
    }) {
  const styles = useThemedStyles(createStyles);
  const [playback, setPlayback] = useState(() => getAudioPlaybackState());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trackWidthRef = useRef(0);

  useEffect(() => subscribeAudioPlayback(setPlayback), []);

  const isCurrent = Boolean(uri) && playback.uri === uri;
  const isPlaying = isCurrent && playback.isPlaying;
  const totalMs = (isCurrent && playback.durationMs) || Number(durationMs) || 0;
  const positionMs = isCurrent ? playback.positionMs : 0;

  // Leaving the app must not leave audio running from a chat bubble; the call
  // flow is the only thing allowed to hold audio in the background.
  useEffect(() => {
    if (!isPlaying) return undefined;
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') return;
      logInfo('[AudioPlayback] pausing playback because the app was backgrounded');
      void pauseAudio();
    });
    return () => subscription.remove();
  }, [isPlaying]);

  const handleToggle = useCallback(async () => {
    setError(null);
    if (isPlaying) {
      const paused = await pauseAudio();
      if (!paused.ok) setError(paused.message);
      return;
    }
    if (isCurrent) {
      const resumed = await resumeAudio();
      if (!resumed.ok) setError(resumed.message);
      return;
    }
    if (!uri) {
      logWarn('[AudioPlayback] bubble has no audio URL to play');
      setError('This audio message is still uploading');
      return;
    }
    setIsLoading(true);
    try {
      const started = await playAudio(uri, { durationMs });
      if (!started.ok) setError(started.message);
    } finally {
      setIsLoading(false);
    }
  }, [durationMs, isCurrent, isPlaying, uri]);

  const handleSeek = useCallback(
    (locationX: number) => {
      if (!isCurrent || !totalMs || !trackWidthRef.current) return;
      const fraction = Math.min(1, Math.max(0, locationX / trackWidthRef.current));
      void seekAudio(fraction * totalMs);
    },
    [isCurrent, totalMs],
  );

  const progress = totalMs > 0 ? Math.min(1, positionMs / totalMs) : 0;
  const iconDefinition = ICONS[isPlaying ? 'mediaPause' : 'mediaPlay'];
  const VectorIcon = loadVectorIcons();
  const unavailable = !isAudioPlaybackAvailable();

  return (
    <View style={styles.container} testID={testID}>
      <Pressable
        onPress={handleToggle}
        disabled={unavailable}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause voice message' : 'Play voice message'}
        accessibilityState={{ disabled: unavailable, selected: isPlaying }}
        hitSlop={touchSlop(12)}
        style={[styles.playButton, unavailable && styles.disabled]}
        testID={`${testID}-toggle`}>
        {isLoading ? (
          <ActivityIndicator size="small" testID={`${testID}-loading`} />
        ) : VectorIcon && iconDefinition ? (
          <VectorIcon name={iconDefinition.icon} size={18} style={styles.playGlyph} />
        ) : (
          <Text style={styles.playGlyph}>{iconDefinition.emoji}</Text>
        )}
      </Pressable>

      <View style={styles.body}>
        <Pressable
          accessibilityRole="adjustable"
          accessibilityLabel="Seek audio"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
          hitSlop={touchSlop(12)}
          onLayout={(event: LayoutChangeEvent) => {
            trackWidthRef.current = event.nativeEvent.layout.width;
          }}
          onPress={event => handleSeek(event.nativeEvent.locationX)}
          style={styles.track}
          testID={`${testID}-track`}>
          <View style={[styles.trackFill, { flex: progress }]} />
          <View style={{ flex: 1 - progress }} />
        </Pressable>
        <View style={styles.times}>
          <Text style={[styles.time, isOwn && styles.timeOwn]} testID={`${testID}-elapsed`}>
            {formatPlaybackTime(positionMs)}
          </Text>
          <Text style={[styles.time, isOwn && styles.timeOwn]} testID={`${testID}-duration`}>
            {formatPlaybackTime(totalMs)}
          </Text>
        </View>
        {error ? (
          <Text style={styles.error} testID={`${testID}-error`}>
            {error}
          </Text>
        ) : null}
        {unavailable ? (
          <Text style={styles.error} testID={`${testID}-unavailable`}>
            Audio playback isn't available on this build
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minWidth: 180,
    },
    playButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceControl,
    },
    playGlyph: {
      color: colors.textPrimary,
      fontSize: 16,
    },
    disabled: {
      opacity: 0.45,
    },
    body: {
      flex: 1,
      gap: 2,
    },
    track: {
      flexDirection: 'row',
      height: TRACK_HEIGHT,
      borderRadius: radius.sm,
      backgroundColor: colors.surfaceBanner,
      overflow: 'hidden',
    },
    trackFill: {
      backgroundColor: colors.accent,
    },
    times: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    time: {
      ...typography.hint,
      color: colors.textSecondary,
    },
    timeOwn: {
      color: colors.textSecondary,
    },
    error: {
      ...typography.hint,
      color: colors.danger,
    },
  });
