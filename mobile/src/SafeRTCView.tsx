import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { logError } from './appLogger';
import type { RTCVideoViewProps } from 'react-native-webrtc';
import type { StyleProp, ViewStyle } from 'react-native';

/**
 * Crash-safe wrapper around react-native-webrtc's <RTCView>.
 *
 * RTCView is a native view; on some devices / library versions it can throw
 * while mounting or while rendering a stream URL (e.g. New Architecture interop
 * issues, a revoked/ended track, or a transient native surface failure). A
 * throw inside a native component render can tear down the whole screen — and,
 * in the worst case, surface as a hard native crash.
 *
 * This boundary contains such render failures to the video area only and shows
 * a small inline fallback message instead of crashing the surrounding UI, so a
 * camera/render problem degrades gracefully into a visible error rather than a
 * blank screen or an app exit.
 *
 * @typedef {Omit<import('react-native-webrtc').RTCVideoViewProps, 'streamURL'> & {
 *   streamURL?: string|null,
 *   fallbackLabel?: string,
 *   style?: import('react-native').StyleProp<import('react-native').ViewStyle>,
 * }} SafeRTCViewProps
 *
 * @typedef {{ hasError: boolean }} SafeRTCViewState
 *
 * @extends {React.Component<SafeRTCViewProps, SafeRTCViewState>}
 */
export type SafeRTCViewProps = Omit<RTCVideoViewProps, 'streamURL'> & { streamURL?: string | null; fallbackLabel?: string; style?: StyleProp<ViewStyle>; };
export type SafeRTCViewState = { hasError: boolean; };
export default class SafeRTCView extends React.Component<SafeRTCViewProps, SafeRTCViewState> {
  /** @param {SafeRTCViewProps} props */
  constructor(props: SafeRTCViewProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  /** @param {Error} error */
  componentDidCatch(error: Error) {
    logError('SafeRTCView render failure', {
      message: error?.message,
      stack: error?.stack,
    });
  }

  /** @param {SafeRTCViewProps} prevProps */
  componentDidUpdate(prevProps: SafeRTCViewProps) {
    // Recover automatically when the stream URL changes (e.g. a new preview or
    // remote stream arrives) so a previous failure does not stick permanently.
    if (this.state.hasError && prevProps.streamURL !== this.props.streamURL) {
      this.setState({ hasError: false });
    }
  }

  render() {
    const { fallbackLabel, style, streamURL, ...rtcProps } = this.props;

    if (this.state.hasError) {
      return (
        <View style={[styles.fallback, style]}>
          <Text style={styles.fallbackText}>{fallbackLabel || 'Video unavailable'}</Text>
        </View>
      );
    }

    // Guard against an invalid/empty stream URL, which can also crash the
    // native view on some platforms.
    if (!streamURL) {
      return (
        <View style={[styles.fallback, style]}>
          <Text style={styles.fallbackText}>No video stream</Text>
        </View>
      );
    }

    return <RTCView style={style} streamURL={streamURL} {...rtcProps} />;
  }
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2e242a',
    padding: 16,
    minHeight: 120,
  },
  fallbackText: {
    color: '#f1ddcb',
    fontSize: 14,
    textAlign: 'center',
  },
});
