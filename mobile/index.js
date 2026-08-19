import 'react-native-gesture-handler';
import '@react-native-firebase/app';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import ErrorBoundary from './src/ErrorBoundary';
import { initObservability } from './src/observability';

// Single entry point for logging, crash handling and startup health: it
// installs the global crash handler, registers the native background-push and
// CallKeep listeners, and reports any failure as a degradation through the
// telemetry pipeline.  See `src/observability.js`.
initObservability();

function Root() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

AppRegistry.registerComponent(appName, () => Root);
