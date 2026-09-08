import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { ActivityIndicator, AppState, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { logInfo, logWarn } from '../appLogger';
import {
  cyclePlaybackRate,
  formatPlaybackTime,
  getAudioPlaybackState,
  isAudioPlaybackAvailable,
  isPlaybackRateSupported,
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

/** Fewer bars than this and a waveform is more noise than signal — fall back to the flat track. */
const MIN_WAVEFORM_BARS = 2;
const WAVEFORM_BAR_MIN_HEIGHT = 3;
const WAVEFORM_BAR_MAX_HEIGHT = 22;

/** `1x` / `1.5x` / `2x`, without a trailing `.0` for whole-number speeds. */
function formatPlaybackRate(rate: number): string {
  return `${Number(rate.toFixed(2)).toString()}x`;
}

/** Amplitude (`0..1`) to bar height (dp), clamped so a bad sample can't collapse or blow out a bar. */
function waveformBarHeight(amplitude: number): number {
  const clamped = Math.min(1, Math.max(0, Number(amplitude) || 0));
  return WAVEFORM_BAR_MIN_HEIGHT + clamped * (WAVEFORM_BAR_MAX_HEIGHT - WAVEFORM_BAR_MIN_HEIGHT);
}

/**
 * Renders pre-computed amplitude data as bars, the played portion tinted
 * differently from the rest. `barHeights` is derived once per attachment (by
 * the caller, keyed on the `amplitudes` array identity) so this never
 * recomputes anything as `progress` ticks — only which bars count as played.
 */
function WaveformBars({
  barHeights,
  progress,
  styles,
  testID,
}: {
  barHeights: number[];
  progress: number;
  styles: ReturnType<typeof createStyles>;
  testID: string;
}) {
  const playedCount = Math.round(progress * barHeights.length);
  return (
    <View style={styles.waveformBars} pointerEvents="none" testID={`${testID}-waveform`}>
      {barHeights.map((height, index) => (
        <View
          // eslint-disable-next-line react/no-array-index-key -- bars are a fixed-length, order-stable layout
          key={index}
          style={[
            styles.waveformBar,
            { height },
            index < playedCount ? styles.waveformBarFilled : styles.waveformBarEmpty,
          ]}
        />
      ))}
    </View>
  );
}

function PlaybackIcon({
  isLoading,
  iconDefinition,
  VectorIcon,
  styles,
  testID,
}: {
  isLoading: boolean;
  iconDefinition: (typeof ICONS)[keyof typeof ICONS];
  VectorIcon: ReturnType<typeof loadVectorIcons>;
  styles: ReturnType<typeof createStyles>;
  testID: string;
}) {
  if (isLoading) return <ActivityIndicator size="small" testID={`${testID}-loading`} />;
  if (VectorIcon && iconDefinition) {
    return <VectorIcon name={iconDefinition.icon} size={18} style={styles.playGlyph} />;
  }
  return <Text style={styles.playGlyph}>{iconDefinition.emoji}</Text>;
}

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
export default function AudioAttachmentPlayer({
  uri,
  durationMs = 0,
  waveform,
  isOwn = false,
  testID = 'chat-audio-player',
}: {
        uri?: string | null;
        durationMs?: number | null;
        waveform?: number[] | null;
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

  const handleCycleRate = useCallback(() => {
    cyclePlaybackRate();
  }, []);

  const handleSeek = useCallback(
    (locationX: number) => {
      if (!isCurrent || !totalMs || !trackWidthRef.current) return;
      const fraction = Math.min(1, Math.max(0, locationX / trackWidthRef.current));
      void seekAudio(fraction * totalMs);
    },
    [isCurrent, totalMs],
  );

  // `PanResponder.create` is only called once (below); it must read the
  // latest `handleSeek` through a ref rather than closing over the one from
  // whichever render created it.
  const handleSeekRef = useRef(handleSeek);
  handleSeekRef.current = handleSeek;

  // A tap and a drag are the same gesture here — both move the scrubber to
  // wherever the finger is — so grant and move share one handler. Attaching
  // this to a plain `View` (rather than layering it onto `Pressable`, which
  // owns the same low-level responder props) is what makes dragging work.
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: event => handleSeekRef.current(event.nativeEvent.locationX),
        onPanResponderMove: event => handleSeekRef.current(event.nativeEvent.locationX),
      }),
    [],
  );

  const progress = totalMs > 0 ? Math.min(1, positionMs / totalMs) : 0;
  const iconDefinition = ICONS[isPlaying ? 'mediaPause' : 'mediaPlay'];
  const VectorIcon = loadVectorIcons();
  const unavailable = !isAudioPlaybackAvailable();
  const rateSupported = isPlaybackRateSupported();
  const rateLabel = formatPlaybackRate(playback.playbackRate);
  const hasWaveform = Array.isArray(waveform) && waveform.length >= MIN_WAVEFORM_BARS;
  // The expensive part — mapping every amplitude to a bar height — only
  // reruns when the attachment's own `waveform` array changes identity, not
  // on every progress tick (which only changes which bars count as played).
  const barHeights = useMemo(
    () => (hasWaveform ? (waveform as number[]).map(waveformBarHeight) : null),
    [hasWaveform, waveform],
  );

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
        <PlaybackIcon
          isLoading={isLoading}
          iconDefinition={iconDefinition}
          VectorIcon={VectorIcon}
          styles={styles}
          testID={testID}
        />
      </Pressable>

      <View style={styles.body}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Seek audio"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
          hitSlop={touchSlop(12)}
          onLayout={(event: LayoutChangeEvent) => {
            trackWidthRef.current = event.nativeEvent.layout.width;
          }}
          style={[styles.track, hasWaveform && styles.waveformTrack]}
          testID={`${testID}-track`}
          {...panResponder.panHandlers}>
          {hasWaveform && barHeights ? (
            <WaveformBars barHeights={barHeights} progress={progress} styles={styles} testID={testID} />
          ) : (
            <>
              <View style={[styles.trackFill, { flex: progress }]} />
              <View style={{ flex: 1 - progress }} />
            </>
          )}
        </View>
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
      {rateSupported ? (
        <Pressable
          onPress={handleCycleRate}
          accessibilityRole="button"
          accessibilityLabel={`Playback speed ${rateLabel}`}
          hitSlop={touchSlop(12)}
          style={styles.rateButton}
          testID={`${testID}-rate`}>
          <Text style={styles.rateLabel}>{rateLabel}</Text>
        </Pressable>
      ) : null}
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
    waveformTrack: {
      height: WAVEFORM_BAR_MAX_HEIGHT,
      backgroundColor: 'transparent',
      borderRadius: 0,
      overflow: 'visible',
    },
    waveformBars: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 2,
    },
    waveformBar: {
      flex: 1,
      minWidth: 2,
      borderRadius: 1,
    },
    waveformBarFilled: {
      backgroundColor: colors.accent,
    },
    waveformBarEmpty: {
      backgroundColor: colors.surfaceBanner,
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
    rateButton: {
      paddingHorizontal: spacing.xs,
      paddingVertical: 2,
      borderRadius: radius.sm,
      backgroundColor: colors.surfaceControl,
    },
    rateLabel: {
      ...typography.hint,
      color: colors.textPrimary,
    },
  });
