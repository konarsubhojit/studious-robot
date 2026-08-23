import { Platform } from 'react-native';
import RNFS from 'react-native-fs';
import { logError, logInfo, logVerbose, logWarn } from './appLogger';
import { ensureDownloadPermission } from './permissions';

const EXTENSION_BY_MIME_TYPE = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
});

/**
 * @returns `YYYYMMDD-HHmmss`, safe to embed in a file name.
 */
function formatDateForFile(date: Date = new Date()): string {
  /** @param value */
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * @returns a file extension, defaulting to `bin`.
 */
function extensionForMimeType(mimeType: string | null | undefined): string {
  const normalised = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  return (
    (EXTENSION_BY_MIME_TYPE as Record<string, string|undefined>)[normalised] ?? 'bin'
  );
}

/**
 * @returns the last path segment, or '' when `url` is unparseable.
 */
function filenameFromUrl(url: string | null | undefined): string {
  try {
    const parsed = new URL((url as string));
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    return '';
  }
}

/**
 * Build a local filename for a downloaded attachment without trusting sender
 * controlled path separators or device-specific reserved characters.
 *
 * @param [attachment]
 */
export function attachmentDownloadFileName({ name, url, mimeType, now = new Date() }: {
    name?: string | null;
    url?: string | null;
    mimeType?: string | null;
    now?: Date;
} = {}): string {
  const raw = (typeof name === 'string' && name.trim()) || filenameFromUrl(url) || '';
  const safe = Array.from(raw)
    .map(character =>
      character.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(character) ? '_' : character,
    )
    .join('')
    .replace(/^\.+/, '')
    .trim();
  if (safe) return safe.slice(0, 120);
  return `wetalk-attachment-${formatDateForFile(now)}.${extensionForMimeType(mimeType)}`;
}

function downloadTargets() {
  return Platform.OS === 'android'
    ? [
        { directory: RNFS.DownloadDirectoryPath, label: 'Downloads', primary: true, shared: true },
        { directory: RNFS.ExternalDirectoryPath, label: 'app external storage', primary: false, shared: false },
        { directory: RNFS.DocumentDirectoryPath, label: 'app documents', primary: false, shared: false },
      ]
    : [{ directory: RNFS.DocumentDirectoryPath, label: 'app documents', primary: true, shared: false }];
}

/**
 * Why a download could not be completed. Every value maps to an actionable
 * user-facing message in {@link describeAttachmentDownloadResult}, so a
 * failure is never reported as a bare "something went wrong".
 */
export type AttachmentDownloadReason =
  | 'missing-url'
  | 'unsupported-url'
  | 'unauthorized'
  | 'not-found'
  | 'server-error'
  | 'network'
  | 'storage';

export type AttachmentDownloadResult = {
  success: boolean;
  path?: string;
  label?: string;
  usedFallback?: boolean;
  error?: unknown;
  reason?: AttachmentDownloadReason;
  statusCode?: number;
  message?: string;
};

/**
 * Turn a transport failure or an HTTP status into a reason code.
 *
 * The distinction that matters in practice: a `401`/`403` means the object in
 * R2 is not publicly readable (a bucket-policy/CORS problem no client change
 * can fix), while a transport error means the device could not reach storage
 * at all.
 */
function classifyFailure({ statusCode, error }: { statusCode?: number; error?: unknown; }): AttachmentDownloadReason {
  if (typeof statusCode === 'number' && statusCode > 0) {
    if (statusCode === 401 || statusCode === 403) return 'unauthorized';
    if (statusCode === 404 || statusCode === 410) return 'not-found';
    if (statusCode >= 500) return 'server-error';
    return 'server-error';
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/permission|EACCES|ENOSPC|EROFS|write/i.test(message)) return 'storage';
  return 'network';
}

/**
 * @returns the URL host, for logs that must not carry the full (signed) URL.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/**
 * Download a previously sent/received chat attachment into the most accessible
 * device storage location available.
 *
 * Android below API 29 needs an explicit storage grant to write into the
 * shared Downloads folder; a denial degrades to app-private storage instead of
 * failing the download. Every failure path logs its reason — a silent
 * degradation is what made this class of bug impossible to characterise.
 *
 * @param [attachment]
 */
export async function downloadAttachment({ url, name, mimeType, now = new Date(), onProgress }: {
    url?: string | null;
    name?: string | null;
    mimeType?: string | null;
    now?: Date;
    /** Called with a 0..1 fraction as bytes arrive, for large files. */
    onProgress?: (fraction: number) => void;
} = {}): Promise<AttachmentDownloadResult> {
  if (!url || typeof url !== 'string') {
    logWarn('[Attachments] download skipped: no URL on the attachment', { mimeType });
    return { success: false, reason: 'missing-url', error: new Error('Missing attachment URL') };
  }
  // Only ever fetch over HTTP(S): a sender-supplied `file://` (or any other
  // scheme) would turn a download into a local-file copy.
  if (!/^https?:\/\//i.test(url)) {
    logWarn('[Attachments] download refused an unsupported URL scheme', { host: hostOf(url) });
    return { success: false, reason: 'unsupported-url', error: new Error('Unsupported attachment URL') };
  }

  const fileName = attachmentDownloadFileName({ name, url, mimeType, now });
  const permission = await ensureDownloadPermission();
  if (!permission.granted) {
    logWarn('[Attachments] storage permission denied; saving inside the app instead', {
      message: permission.message,
    });
  }

  logInfo('[Attachments] download started', { host: hostOf(url), mimeType, fileName });

  let firstFailure: AttachmentDownloadResult | null = null;

  for (const target of downloadTargets()) {
    if (!target.directory) continue;
    // Without the grant the shared Downloads folder is not writable on legacy
    // Android, so skip straight to a directory this app always owns.
    if (target.shared && !permission.granted) continue;
    const path = `${target.directory}/${fileName}`;
    try {
      const job = RNFS.downloadFile({
        fromUrl: url,
        toFile: path,
        progressDivider: 5,
        progress: ({ bytesWritten, contentLength }: { bytesWritten?: number; contentLength?: number; }) => {
          if (!contentLength || contentLength <= 0) return;
          const fraction = Math.min(1, Math.max(0, (bytesWritten ?? 0) / contentLength));
          logVerbose('[Attachments] download progress', { fileName, fraction });
          onProgress?.(fraction);
        },
      });
      const result = await job.promise;
      const statusCode = result?.statusCode;
      if (!result || statusCode < 200 || statusCode >= 300) {
        throw Object.assign(new Error(`Download failed with status ${statusCode ?? 'unknown'}`), {
          statusCode,
        });
      }
      onProgress?.(1);
      logInfo('[Attachments] download saved', {
        label: target.label,
        fileName,
        usedFallback: !target.primary,
      });
      return { success: true, path, label: target.label, usedFallback: !target.primary };
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      const reason = classifyFailure({ statusCode, error });
      logWarn('[Attachments] download attempt failed', {
        label: target.label,
        reason,
        statusCode,
        error,
      });
      if (!firstFailure) firstFailure = { success: false, error, reason, statusCode };
      // A rejected fetch fails identically wherever the bytes would land, so
      // only a storage-side failure is worth retrying in another directory.
      if (reason !== 'storage') break;
    }
  }

  const failure =
    firstFailure ??
    ({
      success: false,
      reason: 'storage',
      error: new Error('No writable download directory'),
    } as AttachmentDownloadResult);
  logError('[Attachments] download failed', {
    host: hostOf(url),
    reason: failure.reason,
    statusCode: failure.statusCode,
    error: failure.error,
  });
  return { ...failure, message: describeAttachmentDownloadResult(failure) };
}

const FAILURE_MESSAGES: Record<AttachmentDownloadReason, string> = {
  'missing-url': 'This attachment has no file yet — it may still be uploading',
  'unsupported-url': "This attachment's link isn't supported by this app",
  unauthorized: 'The server refused access to this file (403). Ask the admin to check storage access.',
  'not-found': 'This file is no longer available on the server',
  'server-error': 'The file server could not deliver this attachment. Try again later.',
  network: 'Could not reach the file server. Check your connection and try again.',
  storage: 'Could not save the file to device storage. Free up space and try again.',
};

/**
 * @returns a user-facing summary of the download outcome.
 */
export function describeAttachmentDownloadResult(result: { success?: boolean; label?: string; reason?: AttachmentDownloadReason; } | null | undefined): string {
  if (result?.success) return `Saved attachment to ${result.label}`;
  return (result?.reason && FAILURE_MESSAGES[result.reason]) || 'Could not download attachment';
}

