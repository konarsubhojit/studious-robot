/**
 * Client-side QoS telemetry.
 *
 * Tracks per-call metrics (setup latency, first-remote-frame latency,
 * reconnect count, ICE restart count) and produces a structured QoS summary
 * that is logged at call end.  All data is kept in-memory; reset on app
 * restart.
 *
 * Usage:
 *   import * as Telemetry from '../telemetry';
 *
 *   // When a call is initiated or accepted:
 *   Telemetry.trackCallStart(callId, sessionId);
 *
 *   // When the first remote media track arrives:
 *   Telemetry.trackFirstRemoteFrame(callId);
 *
 *   // When the call reaches the in_call phase (markCallConnected):
 *   Telemetry.trackCallConnected(callId);
 *
 *   // On each socket reconnect or ICE restart during a call:
 *   Telemetry.trackReconnect(callId);
 *   Telemetry.trackIceRestart(callId);
 *
 *   // When the call ends – returns the QoS summary for logging:
 *   const summary = Telemetry.trackCallEnd(callId);
 *
 *   // Cleanup (optional – pruning happens automatically):
 *   Telemetry.clearCallTelemetry(callId);
 */

/** Maximum number of concurrent/recent call entries to keep. */
const MAX_ENTRIES = 100;

export type CallQoSSummary = {
  callId: string;
  sessionId: string | null;
  setupLatencyMs: number | null;
  firstFrameLatencyMs: number | null;
  durationMs: number | null;
  reconnectCount: number;
  iceRestartCount: number;
  selectedCandidatePairType: string | null;
};
export type CallTelemetryEntry = {
  callId: string;
  sessionId: string | null;
  startedAtMs: number | null;
  connectedAtMs: number | null;
  firstRemoteFrameAtMs: number | null;
  endedAtMs: number | null;
  reconnectCount: number;
  iceRestartCount: number;
  selectedCandidatePairType: string | null;
};

const entries: Map<string, CallTelemetryEntry> = new Map();

// ─── Private helpers ──────────────────────────────────────────────────────────

function getOrCreate(callId: string): CallTelemetryEntry {
  let entry = entries.get(callId);
  if (!entry) {
    entry = {
      callId,
      sessionId: null,
      startedAtMs: null,
      connectedAtMs: null,
      firstRemoteFrameAtMs: null,
      endedAtMs: null,
      reconnectCount: 0,
      iceRestartCount: 0,
      selectedCandidatePairType: null,
    };
    entries.set(callId, entry);
    pruneOldEntries();
  }
  return entry;
}

/**
 * Drop the oldest entry once the map grows past {@link MAX_ENTRIES}.
 */
function pruneOldEntries(): void {
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Mark the beginning of a call (initiate or accept).
 */
export function trackCallStart(callId: string, sessionId: string | null) {
  const entry = getOrCreate(callId);
  entry.startedAtMs = Date.now();
  entry.sessionId = sessionId ?? null;
}

/**
 * Record when the call reaches the `in_call` phase (media connected).
 */
export function trackCallConnected(callId: string) {
  const entry = entries.get(callId);
  if (!entry) return;
  entry.connectedAtMs = Date.now();
}

/**
 * Record the timestamp of the first received remote video frame.
 * Only the first invocation per call has any effect.
 */
export function trackFirstRemoteFrame(callId: string) {
  const entry = entries.get(callId);
  if (!entry || entry.firstRemoteFrameAtMs !== null) return;
  entry.firstRemoteFrameAtMs = Date.now();
}

/**
 * Increment the socket reconnect counter for the call.
 */
export function trackReconnect(callId: string) {
  const entry = entries.get(callId);
  if (!entry) return;
  entry.reconnectCount += 1;
}

/**
 * Increment the ICE restart counter for the call.
 */
export function trackIceRestart(callId: string) {
  const entry = entries.get(callId);
  if (!entry) return;
  entry.iceRestartCount += 1;
}

/**
 * Record the local candidate type for the currently selected ICE pair.
 */
export function trackSelectedCandidatePair(callId: string, candidateType: string) {
  const entry = entries.get(callId);
  if (!entry) return;
  entry.selectedCandidatePairType = candidateType;
}

/**
 * Mark the call as ended and return the QoS summary.
 */
export function trackCallEnd(callId: string): CallQoSSummary | null {
  const entry = entries.get(callId);
  if (!entry) return null;
  entry.endedAtMs = Date.now();
  return buildSummary(entry);
}

/**
 * Return the current QoS summary for a call without ending it.
 */
export function getCallQoSSummary(callId: string): CallQoSSummary | null {
  const entry = entries.get(callId);
  return entry ? buildSummary(entry) : null;
}

/**
 * Remove telemetry data for a call.
 */
export function clearCallTelemetry(callId: string) {
  entries.delete(callId);
}

// ─── Private builder ──────────────────────────────────────────────────────────

function buildSummary(entry: CallTelemetryEntry): CallQoSSummary {
  const { startedAtMs, connectedAtMs, firstRemoteFrameAtMs, endedAtMs } = entry;

  return {
    callId: entry.callId,
    sessionId: entry.sessionId,
    setupLatencyMs:
      startedAtMs !== null && connectedAtMs !== null ? connectedAtMs - startedAtMs : null,
    firstFrameLatencyMs:
      startedAtMs !== null && firstRemoteFrameAtMs !== null
        ? firstRemoteFrameAtMs - startedAtMs
        : null,
    durationMs: startedAtMs !== null && endedAtMs !== null ? endedAtMs - startedAtMs : null,
    reconnectCount: entry.reconnectCount,
    iceRestartCount: entry.iceRestartCount,
    selectedCandidatePairType: entry.selectedCandidatePairType,
  };
}
