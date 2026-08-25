import { NativeModules, Platform } from 'react-native';
import RNFS from 'react-native-fs';
import appConfig from '../app.json';
import { API_ROUTES } from '../../shared';
import { getLogsForExport, logError, logInfo } from './appLogger';
import { errorMessage } from './errors';

export type IceCandidatePairSummary = {
  local: string;
  remote: string;
  protocol: string;
  relayProtocol?: string;
  usingTurn: boolean;
  /** Which side of the pair is a relay, when the call traverses TURN. */
  relaySide?: 'local' | 'remote' | 'both';
};

/**
 * Diagnostic / logging helpers extracted from App.js.  These are framework
 * utilities (no React state) used by the call hook for status messages, ICE
 * candidate summaries, and the "Export Logs" feature.
 */

/**
 * @returns `YYYYMMDD-HHmmss`, safe to embed in a file name.
 */
export function formatDateForFile(date: Date = new Date()): string {
  /** @param value */
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function getReactNativeVersion() {
  const version = Platform.constants?.reactNativeVersion;
  if (!version) {
    return 'unknown';
  }
  const major = version.major ?? '?';
  const minor = version.minor ?? '?';
  const patch = version.patch ?? '?';
  return `${major}.${minor}.${patch}`;
}

export function getApplicationId() {
  const maybeBundleId =
    NativeModules?.PlatformConstants?.bundleIdentifier ||
    NativeModules?.SettingsManager?.settings?.CFBundleIdentifier ||
    NativeModules?.PlatformConstants?.applicationId;

  return maybeBundleId || 'unknown';
}

/**
 * @param socket socket.io client, or anything falsy.
 */
export function getSocketTransportName(socket: any): string {
  return socket?.io?.engine?.transport?.name || 'unknown';
}

/**
 * @returns the URL without query/fragment, or the input when unparseable.
 */
export function sanitizeUrlForLog(urlValue: string | null | undefined): string {
  if (!urlValue) {
    return '';
  }

  try {
    const parsed = new URL(urlValue);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return urlValue;
  }
}

export function summarizeIceCandidate(candidate: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null; } | null | undefined): { hasCandidate: boolean; protocol?: string; candidateType?: string; sdpMid?: string | null; sdpMLineIndex?: number | null; } {
  if (!candidate) {
    return { hasCandidate: false };
  }

  const candidateText = candidate.candidate || '';
  const parts = candidateText.split(' ');
  const protocol = parts[2] ? parts[2].toLowerCase() : undefined;
  const typeMatch = candidateText.match(/\btyp\s+([a-z0-9]+)/i);

  return {
    hasCandidate: true,
    protocol: protocol || 'unknown',
    candidateType: typeMatch?.[1] || 'unknown',
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
  };
}

/**
 * @param stream a media stream exposing `toURL()`, or anything falsy.
 * @param context label used when the conversion fails.
 */
export function getStreamUrl(stream: any, context?: string): string | null {
  if (!stream || typeof stream.toURL !== 'function') {
    return null;
  }

  try {
    return stream.toURL();
  } catch (error) {
    logError('Failed to build stream URL', {
      context,
      message: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}

/**
 * @returns a user-facing explanation of a getUserMedia failure.
 */
export function getMediaAccessStatus(error: unknown): string {
  const failure = (error as { name?: string, message?: string } | null | undefined);
  const name = `${failure?.name || ''}`.toLowerCase();
  const message = `${failure?.message || ''}`.toLowerCase();
  const combined = `${name} ${message}`;

  if (
    combined.includes('notallowed') ||
    combined.includes('permission denied') ||
    combined.includes('securityerror') ||
    combined.includes('permission')
  ) {
    return 'Camera/microphone permission denied';
  }

  if (
    combined.includes('notreadable') ||
    combined.includes('trackstart') ||
    combined.includes('already in use') ||
    combined.includes('camera is in use') ||
    combined.includes('device in use') ||
    combined.includes('busy')
  ) {
    return 'Camera is already in use';
  }

  if (
    combined.includes('notfound') ||
    combined.includes('devices not found') ||
    combined.includes('device not found')
  ) {
    return 'Camera or microphone unavailable';
  }

  return 'Failed to access camera/microphone';
}

/**
 * @param context
 */
export function buildExportHeader({
  signalingUrl,
  callId,
  status,
  localStream,
  remoteStream,
  isInCall,
  socket,
  iceTransportPolicy,
  selectedCandidatePair,
}: {
        signalingUrl?: string;
        callId?: string | null;
        status?: string;
        localStream?: object | null;
        remoteStream?: object | null;
        isInCall?: boolean;
        socket?: any;
        iceTransportPolicy?: string;
        selectedCandidatePair?: IceCandidatePairSummary | null;
    }): string {
  const lines = [
    'WeTalk diagnostic logs',
    `exportedAt: ${new Date().toISOString()}`,
    `appName: ${appConfig?.displayName || appConfig?.name || 'unknown'}`,
    `applicationId: ${getApplicationId()}`,
    `platform: ${Platform.OS}`,
    `osVersion: ${Platform.Version}`,
    `reactNativeVersion: ${getReactNativeVersion()}`,
    `signalingUrl: ${sanitizeUrlForLog(signalingUrl)}`,
    `callId: ${callId || ''}`,
    `appStatus: ${status || ''}`,
    `hasLocalStream: ${Boolean(localStream)}`,
    `hasRemoteStream: ${Boolean(remoteStream)}`,
    `isInCall: ${Boolean(isInCall)}`,
    `socketConnected: ${Boolean(socket?.connected)}`,
    `socketId: ${socket?.id || 'none'}`,
    `socketTransport: ${getSocketTransportName(socket)}`,
    `iceTransportPolicy: ${iceTransportPolicy || 'all'}`,
    `selectedCandidatePair: ${
      selectedCandidatePair ? JSON.stringify(selectedCandidatePair) : 'none'
    }`,
    '',
    '--- logs ---',
  ];

  return lines.join('\n');
}

export async function writeLogsFile(content: string): Promise<{ success: boolean; path?: string; label?: string; usedFallback?: boolean; error?: unknown; }> {
  const fileName = `wetalk-logs-${formatDateForFile()}.txt`;
  const targets =
    Platform.OS === 'android'
      ? [
          { directory: RNFS.DownloadDirectoryPath, label: 'Downloads', primary: true },
          { directory: RNFS.ExternalDirectoryPath, label: 'app external storage', primary: false },
          { directory: RNFS.DocumentDirectoryPath, label: 'app documents', primary: false },
        ]
      : [{ directory: RNFS.DocumentDirectoryPath, label: 'app documents', primary: true }];

  let firstError;

  for (const target of targets) {
    if (!target.directory) {
      continue;
    }

    const path = `${target.directory}/${fileName}`;
    try {
      await RNFS.writeFile(path, content, 'utf8');
      return {
        success: true,
        path,
        label: target.label,
        usedFallback: !target.primary,
      };
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
    }
  }

  return { success: false, error: firstError };
}


/**
 * How long the export waits for the server's metrics snapshot.
 *
 * Kept short on purpose: the export is used precisely when something is
 * broken, which is when the signaling server is most likely unreachable, and
 * the user is staring at an unchanged screen for the whole timeout.  Better a
 * log file that says "metrics unavailable" quickly than one that arrives late.
 */
const QUERY_TIMINGS_TIMEOUT_MS = 2500;

/** Per-operation rows kept in the export, slowest first. */
const MAX_EXPORTED_QUERY_ROWS = 25;

export type ServerQueryTiming = {
  backend?: string;
  operation?: string;
  kind?: string;
  count?: number;
  errors?: number;
  slow?: number;
  totalMs?: number;
  meanMs?: number;
  maxMs?: number;
};

/**
 * Render the server's per-operation query timings as fixed-width text.
 *
 * Rows arrive sorted by total time (see the server's `/metrics` handler), so
 * the operation costing the most is the first line — which is the question the
 * export exists to answer.
 */
export function formatQueryTimings(
  snapshot: { counters?: Record<string, number>; dbQueries?: ServerQueryTiming[] } | null | undefined,
): string {
  const rows = Array.isArray(snapshot?.dbQueries) ? snapshot.dbQueries : [];
  const counters = snapshot?.counters ?? {};
  const lines = [
    '',
    '--- server query timings (slowest total first) ---',
    `totalQueries: ${counters.db_queries_total ?? 0}` +
      ` reads: ${counters.db_reads_total ?? 0}` +
      ` writes: ${counters.db_writes_total ?? 0}` +
      ` slow: ${counters.db_slow_queries_total ?? 0}` +
      ` errors: ${counters.db_query_errors_total ?? 0}`,
  ];

  if (rows.length === 0) {
    lines.push('(no queries recorded yet)');
    return lines.join('\n');
  }

  lines.push('backend  kind   operation                  count   totalMs    meanMs     maxMs  slow');
  for (const row of rows.slice(0, MAX_EXPORTED_QUERY_ROWS)) {
    lines.push(
      [
        String(row.backend ?? '?').padEnd(8),
        String(row.kind ?? '?').padEnd(6),
        String(row.operation ?? '?').slice(0, 24).padEnd(25),
        String(row.count ?? 0).padStart(5),
        String(row.totalMs ?? 0).padStart(9),
        String(row.meanMs ?? 0).padStart(9),
        String(row.maxMs ?? 0).padStart(9),
        String(row.slow ?? 0).padStart(5),
      ].join(' '),
    );
  }
  return lines.join('\n');
}

/**
 * Best-effort fetch of the server's query-timing snapshot for the export file.
 *
 * Never throws and never blocks the export for long: an unreachable or
 * out-of-date server simply yields an explanatory line instead of timings.
 */
export async function fetchServerQueryTimings(signalingUrl?: string): Promise<string> {
  const baseUrl = (signalingUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    return '\n--- server query timings (slowest total first) ---\n(no signaling URL configured)';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMINGS_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${API_ROUTES.METRICS}`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      return `\n--- server query timings (slowest total first) ---\n(metrics unavailable: HTTP ${response.status})`;
    }
    return formatQueryTimings(await response.json());
  } catch (error) {
    return (
      '\n--- server query timings (slowest total first) ---\n' +
      `(metrics unavailable: ${errorMessage(error) || 'unknown error'})`
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collect the in-memory log buffer, prepend a diagnostic header and write it
 * to disk.  Shared by every "Export logs" affordance; the caller only has to
 * surface the returned message to the user.
 *
 * @param [context]
 */
export async function exportDiagnosticLogs(context: {
    signalingUrl?: string;
    callId?: string | null;
    status?: string;
    localStream?: object | null;
    remoteStream?: object | null;
    isInCall?: boolean;
    socket?: object | null;
    iceTransportPolicy?: string;
    selectedCandidatePair?: IceCandidatePairSummary | null;
} = {}): Promise<{ ok: boolean; message: string; }> {
  try {
    logInfo('Export Logs button press');
    const signalingUrl = (context.signalingUrl ?? '').trim();
    const header = buildExportHeader({ ...context, signalingUrl });
    // The server keeps the SQL/Mongo/Redis query timings in-process, so the
    // export pulls them in: the written file is then the single artefact that
    // answers "which query is slow?" without shell access to the server.
    // This deliberately blocks the export for up to
    // `QUERY_TIMINGS_TIMEOUT_MS`; it never rejects, so the file is always
    // written, with or without the timings.
    const queryTimings = await fetchServerQueryTimings(signalingUrl);
    const result = await writeLogsFile(
      `${header}\n${await getLogsForExport()}\n${queryTimings}\n`,
    );

    if (!result.success) {
      logError('Failed to export logs', result.error);
      return {
        ok: false,
        message: `Failed to export logs: ${errorMessage(result.error) || 'Unknown error'}`,
      };
    }

    logInfo('Logs exported', {
      path: result.path,
      storage: result.label,
      usedFallback: result.usedFallback,
    });
    return {
      ok: true,
      message: result.usedFallback
        ? `Logs saved to fallback (${result.label}): ${result.path}`
        : `Logs saved: ${result.path}`,
    };
  } catch (error) {
    logError('Unexpected export logs failure', error);
    return {
      ok: false,
      message: `Failed to export logs: ${errorMessage(error) || 'Unknown error'}`,
    };
  }
}
