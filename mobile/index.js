import 'react-native-gesture-handler';
import '@react-native-firebase/app';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { getLogsAsText } from './src/appLogger';
import ErrorBoundary from './src/ErrorBoundary';
import { installCrashHandler } from './src/crashReporter';
import { installBackgroundMessageHandler } from './src/pushNotifications';
import { registerCallActionListeners, registerShowIncomingCallUiListener } from './src/callKeep';

// Install the global JS / unhandled-rejection crash handler as early as
// possible so it is in place before any component renders.
installCrashHandler(getLogsAsText);
installBackgroundMessageHandler();
// Wire CallKeep's answer/end listeners at module scope - not inside a React
// effect - so they exist even in the headless JS context a background push
// cold-starts, before any component (and therefore `useCallFlow`) has
// mounted. Otherwise a tap on the OS Answer button fires an event nothing is
// listening for. See `setCallActionHandlers` in `src/callKeep.js` for how
// `useCallFlow` takes over routing of these events without re-registering
// (and, on unmount, removing) this subscription.
registerCallActionListeners();
// Wire CallKeep's `showIncomingCallUi` listener at module scope too: Android
// CallKeep runs self-managed, so Telecom never draws its own ringing UI and
// relies on this event to ask the app to draw (and ring) its own. See
// `registerShowIncomingCallUiListener` in `src/callKeep.js`.
registerShowIncomingCallUiListener();

function Root() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

AppRegistry.registerComponent(appName, () => Root);
