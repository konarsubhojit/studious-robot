import { logInfo, logWarn, redactSensitive } from './appLogger';
import type { ObservabilityEvent } from './observability';

/**
 * Optional crash reporting for the WeTalk mobile app.
 *
 * Wraps the optional `@sentry/react-native` native module (the vendor chosen in
 * `docs/crash-reporting-decision.md`), which reports native and JavaScript
 * crashes off-device. Like `react-native-callkeep` in `callKeep.js` and
 * `@react-native-firebase/messaging` in `pushNotifications.js`, the package is
 * loaded through a guarded lazy `require` so a bundle (or a Jest run on CI)
 * without the native module still builds and runs: every helper below degrades
 * to a no-op and the app keeps its own crash handler and app-log sink.
 *
 * The DSN is supplied at build time through `SENTRY_DSN`, inlined into the
 * bundle by `babel.config.js` exactly like `SIGNALING_URL`. Without it crash
 * reporting stays off, which is the normal state for local and credential-free
 * CI builds.
 */

/**
 * The subset of the optional `@sentry/react-native` surface this module uses.
 * Every member is optional because the package may be absent or only partially
 * implemented by a test double, which the call sites already probe for.
 */
export type CrashReportingSdk = {
  init?: (options: object) => void;
  addBreadcrumb?: (breadcrumb: object) => void;
  setTag?: (key: string, value: string) => void;
};

/**
 * `disabled`    - no DSN configured, reporting intentionally off.
 * `enabled`     - the SDK was loaded and initialised.
 * `unavailable` - a DSN was configured but the SDK could not be used.
 */
export type CrashReportingStatus = 'disabled' | 'enabled' | 'unavailable';

/** Observability levels mapped onto Sentry's breadcrumb levels. */
const BREADCRUMB_LEVELS: Record<string, string> = {
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
};

let cachedSdk: CrashReportingSdk | null | undefined;
let hasLoggedMissingSdk = false;
let status: CrashReportingStatus | undefined;
let unregisterSink: (() => void) | null = null;

/**
 * The build-time DSN, or `null` when crash reporting is not configured.
 */
export function getCrashReportingDsn(): string | null {
  const dsn = process.env.SENTRY_DSN?.trim();
  return dsn ? dsn : null;
}

/**
 * Lazily resolve the optional `@sentry/react-native` module. Returns `null`
 * when the package is not installed. The lookup is memoised so a missing
 * module is only logged once.
 */
export function loadCrashReportingSdk(): CrashReportingSdk | null {
  if (cachedSdk !== undefined) return cachedSdk;
  try {
    const mod = require('@sentry/react-native');
    cachedSdk = ((mod?.default ?? mod ?? null) as CrashReportingSdk | null);
  } catch {
    cachedSdk = null;
    if (!hasLoggedMissingSdk) {
      logWarn('[CrashReporting] Native crash-reporting module not installed; skipping crash reporting');
      hasLoggedMissingSdk = true;
    }
  }
  return cachedSdk;
}

/**
 * Forward one structured observability event to the reporter as a breadcrumb,
 * so a crash report carries the events that led up to it. The payload goes
 * through the app logger's redaction first: breadcrumbs leave the device.
 */
function addBreadcrumb(sdk: CrashReportingSdk, event: ObservabilityEvent) {
  const { level, name, ...rest } = event;
  try {
    sdk.addBreadcrumb?.({
      category: 'app',
      level: BREADCRUMB_LEVELS[level] ?? 'info',
      message: name,
      data: redactSensitive(rest),
    });
  } catch {
    // Reporting must never break the emitting caller.
  }
}

/**
 * Initialise crash reporting and register it as an observability sink.
 *
 * Call once, as early as possible in the app lifecycle — `initObservability`
 * does so alongside `installBackgroundMessageHandler`, before
 * `AppRegistry.registerComponent` — so crashes during startup are still
 * reported. Idempotent: repeated calls return the first status.
 *
 * Never throws: an absent package, an unavailable native module or a failing
 * initialisation are all reported through the return value instead.
 *
 * @param addSink `addSink` from `observability`, injected to keep this module
 *                free of a cycle back into it.
 * @param dsn     defaults to the build-time `SENTRY_DSN`, which Babel inlines
 *                into the bundle; only tests pass it explicitly, because an
 *                inlined value cannot be set at runtime.
 */
export function initCrashReporting(
  addSink?: (sink: (event: ObservabilityEvent) => void) => () => void,
  dsn: string | null = getCrashReportingDsn(),
): CrashReportingStatus {
  if (status !== undefined) return status;

  if (!dsn) {
    logInfo('[CrashReporting] No SENTRY_DSN configured; crash reporting is off');
    status = 'disabled';
    return status;
  }

  const sdk = loadCrashReportingSdk();
  if (typeof sdk?.init !== 'function') {
    status = 'unavailable';
    return status;
  }

  try {
    sdk.init({
      dsn,
      // The app redacts its own payloads (see `addBreadcrumb`); never let the
      // SDK attach request bodies, headers or user identifiers on its own.
      sendDefaultPii: false,
    });
  } catch (error) {
    logWarn('[CrashReporting] Crash reporting failed to initialise', error);
    status = 'unavailable';
    return status;
  }

  if (typeof addSink === 'function') {
    unregisterSink = addSink(event => addBreadcrumb(sdk, event));
  }

  status = 'enabled';
  return status;
}

/** Reset the memoised module, status and sink registration (test hook). */
export function _resetCrashReportingForTests() {
  unregisterSink?.();
  unregisterSink = null;
  cachedSdk = undefined;
  hasLoggedMissingSdk = false;
  status = undefined;
}
