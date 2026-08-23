import { NativeModules, Platform } from 'react-native';
import RNFS from 'react-native-fs';
import appConfig from '../app.json';
import { getLogsForExport, logError, logInfo } from './appLogger';

/**
 * Diagnostic / logging helpers extracted from App.js.  These are framework
 * utilities (no React state) used by the call hook for status messages, ICE
 * candidate summaries, and the "Export Logs" feature.
 */

/**
 * @returns the error message, when there is one.
 */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

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
}: {
        signalingUrl?: string;
        callId?: string | null;
        status?: string;
        localStream?: object | null;
        remoteStream?: object | null;
        isInCall?: boolean;
        socket?: any;
        iceTransportPolicy?: string;
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
} = {}): Promise<{ ok: boolean; message: string; }> {
  try {
    logInfo('Export Logs button press');
    const header = buildExportHeader({
      ...context,
      signalingUrl: (context.signalingUrl ?? '').trim(),
    });
    const result = await writeLogsFile(`${header}\n${await getLogsForExport()}\n`);

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
