import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { logError } from './appLogger';

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
 */
export default class SafeRTCView extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || 'unknown error' };
  }

  componentDidCatch(error) {
    logError('SafeRTCView render failure', {
      message: error?.message,
      stack: error?.stack,
    });
  }

  componentDidUpdate(prevProps) {
    // Recover automatically when the stream URL changes (e.g. a new preview or
    // remote stream arrives) so a previous failure does not stick permanently.
    if (this.state.hasError && prevProps.streamURL !== this.props.streamURL) {
      // eslint-disable-next-line react/no-did-update-set-state
      this.setState({ hasError: false, message: null });
    }
  }

  render() {
    const { fallbackLabel, style, ...rtcProps } = this.props;

    if (this.state.hasError) {
      return (
        <View style={[styles.fallback, style]}>
          <Text style={styles.fallbackText}>
            {fallbackLabel || 'Video unavailable'}
          </Text>
        </View>
      );
    }

    // Guard against an invalid/empty stream URL, which can also crash the
    // native view on some platforms.
    if (!rtcProps.streamURL) {
      return (
        <View style={[styles.fallback, style]}>
          <Text style={styles.fallbackText}>
            {fallbackLabel || 'No video stream'}
          </Text>
        </View>
      );
    }

    return <RTCView style={style} {...rtcProps} />;
  }
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2e242a',
    padding: 16,
  },
  fallbackText: {
    color: '#f1ddcb',
    fontSize: 14,
    textAlign: 'center',
  },
});
