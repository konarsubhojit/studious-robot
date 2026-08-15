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
 *   // When the socket connects after call start (caller → outgoing):
 *   Telemetry.trackSignalingConnected(callId);
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

/**
 * @typedef {Object} CallQoSSummary
 * @property {string}       callId
 * @property {string|null}  sessionId
 * @property {number|null}  setupLatencyMs        - call start → in_call (media connected)
 * @property {number|null}  firstFrameLatencyMs   - call start → first remote video frame
 * @property {number|null}  signalingLatencyMs    - call start → socket connected
 * @property {number|null}  durationMs            - call start → call end
 * @property {number}       reconnectCount        - number of socket reconnects mid-call
 * @property {number}       iceRestartCount       - number of ICE restarts mid-call
 */

/** @type {Map<string, object>} */
const entries = new Map();

// ─── Private helpers ──────────────────────────────────────────────────────────

function getOrCreate(callId) {
  if (!entries.has(callId)) {
    entries.set(callId, {
      callId,
      sessionId: null,
      startedAtMs: null,
      signalingConnectedAtMs: null,
      connectedAtMs: null,
      firstRemoteFrameAtMs: null,
      endedAtMs: null,
      reconnectCount: 0,
      iceRestartCount: 0,
    });
    pruneOldEntries();
  }
  return entries.get(callId);
}

function pruneOldEntries() {
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    entries.delete(oldest);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Mark the beginning of a call (initiate or accept).
 *
 * @param {string}      callId
 * @param {string|null} sessionId
 */
export function trackCallStart(callId, sessionId) {
  const entry = getOrCreate(callId);
  entry.startedAtMs = Date.now();
  entry.sessionId = sessionId ?? null;
}

/**
 * Record when the signaling socket first connects after a call starts.
 *
 * @param {string} callId
 */
export function trackSignalingConnected(callId) {
  const entry = entries.get(callId);
  if (!entry) return;
  entry.signalingConnectedAtMs = Date.now();
}

/**
 * Record when the call reaches the `in_call` phase (media connected).
 *
 * @param {string} callId
 */
export function trackCallConnected(callId) {
  const entry = entries.get(callId);
  if (!entry) return;
  entry.connectedAtMs = Date.now();
}

/**
 * Record the timestamp of the first received remote video frame.
 * Only the first invocation per call has any effect.
 *
 * @param {string} callId
 */
export function trackFirstRemoteFrame(callId) {
  const entry = entries.get(callId);
  if (!entry || entry.firstRemoteFrameAtMs !== null) return;
  entry.firstRemoteFrameAtMs = Date.now();
}

/**
 * Increment the socket reconnect counter for the call.
 *
 * @param {string} callId
 */
export function trackReconnect(callId) {
  const entry = entries.get(callId);
  if (!entry) return;
  entry.reconnectCount += 1;
}

/**
 * Increment the ICE restart counter for the call.
 *
 * @param {string} callId
 */
export function trackIceRestart(callId) {
  const entry = entries.get(callId);
  if (!entry) return;
  entry.iceRestartCount += 1;
}

/**
 * Mark the call as ended and return the QoS summary.
 *
 * @param {string} callId
 * @returns {CallQoSSummary|null}
 */
export function trackCallEnd(callId) {
  const entry = entries.get(callId);
  if (!entry) return null;
  entry.endedAtMs = Date.now();
  return buildSummary(entry);
}

/**
 * Return the current QoS summary for a call without ending it.
 *
 * @param {string} callId
 * @returns {CallQoSSummary|null}
 */
export function getCallQoSSummary(callId) {
  const entry = entries.get(callId);
  return entry ? buildSummary(entry) : null;
}

/**
 * Remove telemetry data for a call.
 *
 * @param {string} callId
 */
export function clearCallTelemetry(callId) {
  entries.delete(callId);
}

// ─── Private builder ──────────────────────────────────────────────────────────

function buildSummary(entry) {
  const { startedAtMs, signalingConnectedAtMs, connectedAtMs, firstRemoteFrameAtMs, endedAtMs } =
    entry;

  return {
    callId: entry.callId,
    sessionId: entry.sessionId,
    setupLatencyMs:
      startedAtMs !== null && connectedAtMs !== null ? connectedAtMs - startedAtMs : null,
    firstFrameLatencyMs:
      startedAtMs !== null && firstRemoteFrameAtMs !== null
        ? firstRemoteFrameAtMs - startedAtMs
        : null,
    signalingLatencyMs:
      startedAtMs !== null && signalingConnectedAtMs !== null
        ? signalingConnectedAtMs - startedAtMs
        : null,
    durationMs: startedAtMs !== null && endedAtMs !== null ? endedAtMs - startedAtMs : null,
    reconnectCount: entry.reconnectCount,
    iceRestartCount: entry.iceRestartCount,
  };
}
