// @ts-check
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppShell from './src/AppShell';
import { CallProvider } from './src/call/CallProvider';
import { ChatProvider } from './src/chat/ChatProvider';
import ThemeProvider from './src/ThemeProvider';

/**
 * Composition root: providers only.
 *
 * - `SafeAreaProvider` so screens can read real device insets (status bar /
 *   notch and the bottom gesture-navigation bar) instead of the iOS-only,
 *   Android-no-op `SafeAreaView`.
 * - `ThemeProvider` resolves the active colour scheme (system / light / dark)
 *   and hands the matching palette to every themed component.
 * - `CallProvider` owns the single call state machine (idle → outgoing /
 *   incoming → connected → ended) plus everything hanging off it, so screens
 *   never have to reconcile competing call sources.
 * - `ChatProvider` owns the chat/conversation state layered on top of it.
 *
 * All screen routing lives in `src/AppShell`; all behaviour lives in the
 * providers and their hooks, so the components stay presentational.
 */
export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <CallProvider>
            <ChatProvider>
              <AppShell />
            </ChatProvider>
          </CallProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
