import 'react-native-gesture-handler';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { getLogsAsText } from './src/appLogger';
import ErrorBoundary from './src/ErrorBoundary';
import { installCrashHandler } from './src/crashReporter';

// Install the global JS / unhandled-rejection crash handler as early as
// possible so it is in place before any component renders.
installCrashHandler(getLogsAsText);

function Root() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

AppRegistry.registerComponent(appName, () => Root);
