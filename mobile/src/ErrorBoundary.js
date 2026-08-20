// @ts-check
import React from 'react';
import { Button, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getLogsAsText } from './appLogger';
import { saveCrashLog } from './crashReporter';

/**
 * Top-level React error boundary.
 *
 * Catches synchronous render errors anywhere in the component tree,
 * auto-saves a crash report file, and shows a diagnostic crash screen
 * instead of a white/black screen of death.
 *
 * Usage (index.js):
 *   <ErrorBoundary>
 *     <App />
 *   </ErrorBoundary>
 *
 * @typedef {{ error: Error|null, logPath: string|null, saving: boolean }} ErrorBoundaryState
 *
 * @extends {React.Component<{ children?: React.ReactNode }, ErrorBoundaryState>}
 */
export default class ErrorBoundary extends React.Component {
  /** @param {{ children?: React.ReactNode }} props */
  constructor(props) {
    super(props);
    this.state = /** @type {ErrorBoundaryState} */ ({ error: null, logPath: null, saving: false });
    this.handleRestart = this.handleRestart.bind(this);
  }

  /** @param {Error} error */
  static getDerivedStateFromError(error) {
    return { error };
  }

  /** @param {Error} error */
  componentDidCatch(error) {
    this.setState({ saving: true });
    saveCrashLog(error, true, getLogsAsText)
      .then(result => {
        this.setState({ saving: false, logPath: (result.success && result.path) || null });
      })
      .catch(() => {
        this.setState({ saving: false });
      });
  }

  handleRestart() {
    this.setState({ error: null, logPath: null, saving: false });
  }

  render() {
    const { error, logPath, saving } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message}>
            {String(error?.message || 'An unexpected error occurred.')}
          </Text>
          {saving ? (
            <Text style={styles.hint}>Saving crash log…</Text>
          ) : logPath ? (
            <Text style={styles.hint}>
              {'Crash log saved to:\n'}
              <Text style={styles.path}>{logPath}</Text>
              {'\n\nShare this file when reporting the issue.'}
            </Text>
          ) : (
            <Text style={styles.hint}>Unable to save crash log to storage.</Text>
          )}
          <View style={styles.button}>
            <Button title="Dismiss and retry" onPress={this.handleRestart} />
          </View>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#2d2329',
  },
  content: {
    flexGrow: 1,
    padding: 24,
    justifyContent: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f08d89',
    marginBottom: 12,
  },
  message: {
    color: '#fff5e8',
    fontSize: 13,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    marginBottom: 20,
  },
  hint: {
    color: '#dec8b5',
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 20,
  },
  path: {
    color: '#8be7a5',
    fontSize: 12,
  },
  button: {
    marginTop: 8,
  },
});
