import { getLogsAsText, logDebug, logError, logInfo, logWarn, persistLogLine } from './appLogger';
import { getStartupIssues, recordStartupIssue } from './startupHealth';

/**
 * Single observability entry point: structured, levelled events fan out to
 * pluggable sinks (the in-memory/durable app log by default, optionally
 * Crashlytics or the server), crash reporting is installed here, and startup
 * degradations travel through the same pipeline instead of ad-hoc strings.
 *
 * Every event carries the per-session correlation ID, which is also sent on
 * the signaling handshake (see `useCallFlow`), so a failed call can be traced
 * from the client log through the server log.
 *
 * Usage (index.js):
 *   import { initObservability } from './src/observability';
 *   initObservability();
 *
 * Usage (anywhere else):
 *   import { emitEvent, emitMetric, getCorrelationId } from '../observability';
 *   emitMetric('call.ice_failed', 1, { callId });
 */

const LEVEL_LOGGERS: Record<string, (message: unknown, metadata?: unknown) => string | undefined> = {
  debug: logDebug,
  info: logInfo,
  warn: logWarn,
  error: logError,
};

export type ObservabilityEvent = { level: string; name: string; [key: string]: any; };
export type ObservabilityInitResult = {
  correlationId: string;
  backgroundPushRegistered: boolean;
  callActionsRegistered: boolean;
  incomingCallUiRegistered: boolean;
};

/**
 * Sinks that receive every structured event.
 */
const sinks: Set<(event: ObservabilityEvent) => void> = new Set();

let correlationId: string | null = null;
let initialized = false;
let lastInitResult: ObservabilityInitResult | null = null;

function randomId() {
  // Math.random is sufficient: the correlation ID is a log-tracing handle, not
  // a security token.
  const part = () => Math.random().toString(36).slice(2, 10);
  return `${part()}${part()}`;
}

/**
 * Per-app-session correlation ID, generated lazily on first use so background
 * (headless) events share the ID of the process that emitted them.
 */
export function getCorrelationId(): string {
  if (!correlationId) {
    correlationId = `wt-${randomId()}`;
  }
  return correlationId;
}

/**
 * Start a new correlation scope. Only intended for tests and for explicit
 * "new session" boundaries (e.g. re-registration).
 *
 * @returns the new correlation ID
 */
export function resetCorrelationId(): string {
  correlationId = null;
  return getCorrelationId();
}

/**
 * Register an additional sink (Crashlytics, server upload, test spy, …).
 */
export function addSink(sink: (event: ObservabilityEvent) => void): () => void {
  if (typeof sink !== 'function') return () => {};
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/** Remove every registered sink (used by tests). */
export function clearSinks() {
  sinks.clear();
}

/**
 * The default sink: levelled write into the in-memory app log buffer, with
 * warnings and errors also persisted so they survive the process being killed
 * while backgrounded.
 */
function appLogSink(event: ObservabilityEvent): void {
  const { level, name, ...rest } = event;
  const write = LEVEL_LOGGERS[level] || logInfo;
  const line = write(`[${name}]`, rest);
  if (line && (level === 'warn' || level === 'error')) {
    persistLogLine(line);
  }
}

addSink(appLogSink);

/**
 * Emit a structured, levelled event to every sink.
 *
 * @param name      - dotted event name, e.g. `call.qos`
 * @param data    - structured payload (redacted by the app logger)
 * @returns the emitted event
 */
export function emitEvent(level: 'debug' | 'info' | 'warn' | 'error', name: string, data: object = {}): object {
  const event = {
    level: LEVEL_LOGGERS[level] ? level : 'info',
    name: typeof name === 'string' && name ? name : 'unknown',
    correlationId: getCorrelationId(),
    at: new Date().toISOString(),
    ...data,
  };

  sinks.forEach(sink => {
    try {
      sink(event);
    } catch {
      // A failing sink must never break the caller (or recurse into logging).
    }
  });

  return event;
}

/**
 * Emit a metric sample (call setup latency, ICE failures, reconnects, …).
 *
 * @returns the emitted event
 */
export function emitMetric(metric: string, value: number = 1, data: object = {}): object {
  return emitEvent('info', `metric.${metric}`, { metric, value, ...data });
}

/**
 * Record a startup/runtime degradation: it is stored for the degraded-state
 * banner *and* emitted through the same pipeline as every other event.
 */
export function recordDegradation(source: string, message: string, data: object = {}) {
  recordStartupIssue(source, message);
  return emitEvent('error', 'startup.degraded', { source, message, ...data });
}

/**
 * Current startup degradations, for the banner in `AppShell`.
 */
export function getDegradations(): Array<{ source: string; message: string; }> {
  return getStartupIssues();
}

/**
 * Install crash handling, logging and the startup health checks.
 *
 * Registers the native background-push and CallKeep listeners at module scope
 * (they must exist before any component mounts, including in the headless JS
 * context a background push cold-starts) and reports any failure as a
 * degradation through the telemetry pipeline.
 *
 * Idempotent: repeated calls return the first result.
 */
export function initObservability(): ObservabilityInitResult {
  if (initialized && lastInitResult) {
    return lastInitResult;
  }
  initialized = true;

  // Required lazily so that emitting events never drags the native-only
  // startup dependencies (file system, Firebase messaging, CallKeep) into
  // modules that merely log.
  const { installCrashHandler } = require('./crashReporter');
  const { installBackgroundMessageHandler } = require('./pushNotifications');
  const { registerCallActionListeners, registerShowIncomingCallUiListener } = require('./callKeep');

  // Install the global JS / unhandled-rejection crash handler first so it is
  // in place before anything else can throw.
  installCrashHandler(getLogsAsText);

  emitEvent('info', 'app.startup', {});

  const backgroundPushRegistered = installBackgroundMessageHandler() !== false;
  if (!backgroundPushRegistered) {
    recordDegradation('backgroundPush', 'Background push handler unavailable');
    emitMetric('startup.registration_failed', 1, { component: 'backgroundPush' });
  }

  // Wire CallKeep's answer/end listeners at module scope - not inside a React
  // effect - so they exist even in the headless JS context a background push
  // cold-starts, before any component (and therefore `useCallFlow`) has
  // mounted. Otherwise a tap on the OS Answer button fires an event nothing is
  // listening for. See `setCallActionHandlers` in `src/callKeep.js` for how
  // `useCallFlow` takes over routing of these events without re-registering
  // (and, on unmount, removing) this subscription.
  const callActionsRegistered = registerCallActionListeners()?.registered !== false;
  if (!callActionsRegistered) {
    recordDegradation('callKeepActions', 'CallKeep action listeners unavailable');
    emitMetric('startup.registration_failed', 1, { component: 'callKeepActions' });
  }

  // Android CallKeep runs self-managed, so Telecom never draws its own ringing
  // UI and relies on this event to ask the app to draw (and ring) its own. See
  // `registerShowIncomingCallUiListener` in `src/callKeep.js`.
  const incomingCallUiRegistered = registerShowIncomingCallUiListener()?.registered !== false;
  if (!incomingCallUiRegistered) {
    recordDegradation('callKeepIncomingUi', 'CallKeep incoming-call UI listener unavailable');
    emitMetric('startup.registration_failed', 1, { component: 'callKeepIncomingUi' });
  }

  lastInitResult = {
    correlationId: getCorrelationId(),
    backgroundPushRegistered,
    callActionsRegistered,
    incomingCallUiRegistered,
  };
  return lastInitResult;
}

/** Reset the init latch; test-only. */
export function resetObservabilityForTests() {
  initialized = false;
  lastInitResult = null;
  clearSinks();
  addSink(appLogSink);
}
