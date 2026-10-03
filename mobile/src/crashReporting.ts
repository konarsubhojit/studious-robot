import { logInfo, logWarn, redactSensitive } from './appLogger';
import type { ObservabilityEvent } from './observability';
import { APP_VERSION } from './appInfo';
import { CALL_STATES } from './call/callStateMachine';
import type { captureException as sentryCaptureException } from '@sentry/react-native';

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
  captureException?: (error: unknown, hint: Parameters<typeof sentryCaptureException>[1]) => unknown;
  reactNativeErrorHandlersIntegration?: (options: { onerror: boolean; }) => { name: string; };
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
let getRuntimeContext: (() => { signalingUrl: string; callPhase: string; }) | undefined;

/** Register a live, identity-free view of the call flow; clear it on unmount. */
export function registerCrashContext(provider: NonNullable<typeof getRuntimeContext>): () => void {
  getRuntimeContext = provider;
  return () => {
    if (getRuntimeContext === provider) getRuntimeContext = undefined;
  };
}

function signalingHost(url: string): string | undefined {
  // Do not forward URL credentials, paths, query parameters or fragments.
  return /^https?:\/\/(?:[^/@]*@)?(\[[a-f\d:]+\]|[a-z\d.-]+)(?::(\d+))?(?:[/?#]|$)/i
    .exec(url.trim())?.slice(1).filter(Boolean).join(':');
}

/**
 * The local buffer contains free-form text and chat metadata. Only retain its
 * diagnostic envelope remotely, never message text or arbitrary payloads.
 */
function remoteLogBuffer(logs: string): string {
  return logs.split('\n').slice(-100).flatMap(line => {
    const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[(DEBUG|INFO|WARN|ERROR)\](?: \[(CallFlow|CallKeep|CrashReporting|app\.startup)\])?/.exec(line);
    if (!match) return [];
    const callPhase = /"callPhase"\s*:\s*"(outgoing_ringing|incoming_ringing|in_call|idle|ended)"/.exec(line)?.[1];
    return [{ at: match[1], level: match[2], category: match[3] ?? 'app', callPhase }];
  }).map(entry => JSON.stringify(entry)).join('\n');
}

function remoteErrorText(text: string): string {
  return text
    .replace(/[^\s<>@"']+@[^\s<>@"']+\.[a-z]{2,}/gi, '[REDACTED]')
    .replace(/\b(userId|user_id|email|body|content|text|attachmentKey|attachment_key|objectKey)\b["']?\s*[:=][^\n]*/gi, '$1=[REDACTED]');
}

/** Best-effort exception capture; neither context nor SDK failures may escape. */
export function captureCrash(error: unknown, isFatal: boolean, getLogs?: () => string): void {
  try {
    if (status !== 'enabled') return;
    const sdk = loadCrashReportingSdk();
    if (typeof sdk?.captureException !== 'function') return;

    const tags: Record<string, string> = { isFatal: String(isFatal), appVersion: APP_VERSION };
    try {
      const context = getRuntimeContext?.();
      const host = context && signalingHost(context.signalingUrl);
      if (host) tags.signalingHost = host;
      if (context && Object.values(CALL_STATES).includes(context.callPhase) &&
          context.callPhase !== CALL_STATES.IDLE && context.callPhase !== CALL_STATES.ENDED) {
        tags.callPhase = context.callPhase;
      }
    } catch {
      // Missing runtime context must not suppress the exception.
    }

    let logs = '';
    try {
      logs = remoteLogBuffer(getLogs?.() ?? '');
    } catch {
      // A failing log callback must not suppress the exception.
    }

    // Avoid serialising custom error properties (which may contain chat data).
    const exception = new Error(error instanceof Error ? remoteErrorText(error.message) : 'Unknown JavaScript error');
    if (error instanceof Error) {
      exception.name = remoteErrorText(error.name);
      exception.stack = error.stack && remoteErrorText(error.stack);
    }
    const result = sdk.captureException(exception, {
      captureContext: { level: isFatal ? 'fatal' : 'error', tags },
      mechanism: { handled: false, type: 'onerror' },
      attachments: logs ? [{ filename: 'app-logs.jsonl', data: logs, contentType: 'text/plain' }] : [],
    });
    Promise.resolve(result).catch(() => {
      // Also swallow failures from asynchronous SDK shims.
    });
  } catch {
    // Reporting must never recurse into the global error handler.
  }
}

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
    const redacted = redactSensitive(rest) as Record<string, unknown>;
    // Only schema-defined diagnostics leave the device, not arbitrary chat data.
    const data: Record<string, unknown> = {};
    if (typeof redacted.at === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(redacted.at)) data.at = redacted.at;
    if (typeof redacted.value === 'number' && Number.isFinite(redacted.value)) data.value = redacted.value;
    if (typeof redacted.callPhase === 'string' && Object.values(CALL_STATES).includes(redacted.callPhase)) data.callPhase = redacted.callPhase;
    sdk.addBreadcrumb?.({
      category: 'app',
      level: BREADCRUMB_LEVELS[level] ?? 'info',
      message: name,
      data,
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
      release: process.env.SENTRY_RELEASE?.trim() || undefined,
      dist: process.env.SENTRY_DIST?.trim() || undefined,
      // The app redacts its own payloads (see `addBreadcrumb`); never let the
      // SDK attach request bodies, headers or user identifiers on its own.
      sendDefaultPii: false,
      // Our global handler owns JS capture; a second handler captures first
      // and Sentry's dedupe then drops our context-enriched event. Keep the
      // integration's production promise-rejection tracker.
      integrations: (integrations: { name: string; }[]) =>
        integrations.map(integration => integration.name === 'ReactNativeErrorHandlers'
          ? sdk.reactNativeErrorHandlersIntegration?.({ onerror: false }) ?? integration
          : integration),
      // Automatic console/network breadcrumbs bypass our diagnostic allowlist.
      beforeBreadcrumb: (breadcrumb: { category?: string; }) =>
        breadcrumb.category === 'app' ? breadcrumb : null,
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
  getRuntimeContext = undefined;
}
