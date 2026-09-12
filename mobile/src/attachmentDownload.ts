import { Platform } from 'react-native';
import RNFS from 'react-native-fs';
import { findCachedAttachment, rememberCachedAttachment } from './attachmentCache';
import { logError, logInfo, logVerbose, logWarn } from './appLogger';
import { ensureDownloadPermission } from './permissions';
import { describeError } from './errors';

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
  'application/x-zip-compressed': 'zip',
  'multipart/x-zip': 'zip',
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
  | 'storage'
  | 'cancelled';

/**
 * Reasons where trying again cannot succeed: the URL scheme is not
 * downloadable, or the object is gone from the server. Every other reason
 * (including a user cancel) is worth another tap.
 */
const NON_RETRYABLE_DOWNLOAD_REASONS: ReadonlySet<AttachmentDownloadReason> = new Set([
  'unsupported-url',
  'not-found',
]);

/**
 * @returns whether a failed download is worth offering a retry for.
 */
export function isAttachmentDownloadRetryable(reason?: AttachmentDownloadReason | null): boolean {
  return Boolean(reason) && !NON_RETRYABLE_DOWNLOAD_REASONS.has(reason as AttachmentDownloadReason);
}

export type AttachmentDownloadResult = {
  success: boolean;
  path?: string;
  label?: string;
  usedFallback?: boolean;
  error?: unknown;
  reason?: AttachmentDownloadReason;
  statusCode?: number;
  message?: string;
  /** The bytes were already on the device; no network request was made. */
  fromCache?: boolean;
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
  const message = describeError(error);
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
 * One attempt, at one directory.
 *
 * Never throws: a transport failure, a non-2xx status and a storage failure
 * all come back in the same result shape as a success, so the caller only has
 * to decide whether another directory is worth trying.
 */
async function downloadToTarget(
  target: { directory: string; label: string; primary: boolean; },
  { url, fileName, onProgress, registerAbort, isCancelled }: {
    url: string;
    fileName: string;
    onProgress?: (fraction: number) => void;
    /** Told the job's cancel function, so an outer abort can reach it. */
    registerAbort?: (abort: () => void) => void;
    /** Whether this attempt's abort has already been triggered. */
    isCancelled?: () => boolean;
  },
): Promise<AttachmentDownloadResult> {
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
    registerAbort?.(() => RNFS.stopDownload(job.jobId));
    const result = await job.promise;
    if (isCancelled?.()) {
      await RNFS.unlink(path).catch(() => {});
      return { success: false, path, reason: 'cancelled' };
    }
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
    if (isCancelled?.()) {
      await RNFS.unlink(path).catch(() => {});
      return { success: false, path, reason: 'cancelled' };
    }
    const statusCode = (error as { statusCode?: number })?.statusCode;
    const reason = classifyFailure({ statusCode, error });
    logWarn('[Attachments] download attempt failed', {
      label: target.label,
      reason,
      statusCode,
      error,
    });
    return { success: false, error, reason, statusCode };
  }
}

/**
 * Try every writable directory in turn, stopping as soon as one attempt
 * succeeds, is cancelled, or fails in a way another directory could not fix.
 */
async function downloadWithFallback({ url, fileName, onProgress, permission, isCancelled, registerAbort }: {
  url: string;
  fileName: string;
  onProgress?: (fraction: number) => void;
  permission: { granted: boolean; };
  isCancelled: () => boolean;
  registerAbort: (abort: () => void) => void;
}): Promise<AttachmentDownloadResult> {
  let firstFailure: AttachmentDownloadResult | null = null;

  for (const target of downloadTargets()) {
    if (isCancelled()) break;
    if (!target.directory) continue;
    // Without the grant the shared Downloads folder is not writable on legacy
    // Android, so skip straight to a directory this app always owns.
    if (target.shared && !permission.granted) continue;
    const attempt = await downloadToTarget(target, { url, fileName, onProgress, registerAbort, isCancelled });
    if (attempt.reason === 'cancelled' || attempt.success) return attempt;
    if (!firstFailure) firstFailure = attempt;
    // A rejected fetch fails identically wherever the bytes would land, so
    // only a storage-side failure is worth retrying in another directory.
    if (attempt.reason !== 'storage') break;
  }

  if (isCancelled()) return { success: false, reason: 'cancelled' };
  return (
    firstFailure ?? {
      success: false,
      reason: 'storage',
      error: new Error('No writable download directory'),
    }
  );
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
export async function downloadAttachment({ url, name, mimeType, messageId, now = new Date(), onProgress, onAbortHandle }: {
    url?: string | null;
    name?: string | null;
    mimeType?: string | null;
    /** The message the attachment belongs to, so a tombstone can evict it. */
    messageId?: string | null;
    now?: Date;
    /** Called with a 0..1 fraction as bytes arrive, for large files. */
    onProgress?: (fraction: number) => void;
    /** Handed an abort function that cancels the in-flight attempt, if any. */
    onAbortHandle?: (abort: () => void) => void;
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

  // Set before the first await, for the lifetime of the whole call: cancelling
  // must stop the download outright — and be honoured even while the cache is
  // still being consulted — rather than letting the fallback loop retry it in
  // another directory.
  let cancelled = false;
  let abortCurrentAttempt: (() => void) | null = null;
  onAbortHandle?.(() => {
    cancelled = true;
    abortCurrentAttempt?.();
  });

  // Already on the device: opening it again costs nothing, so neither the
  // network nor the storage permission prompt is reached.
  const cached = await findCachedAttachment({ url });
  if (cached && !cancelled) {
    onProgress?.(1);
    logInfo('[Attachments] served from cache', { host: hostOf(url), mimeType });
    const hit: AttachmentDownloadResult = {
      success: true,
      path: cached.path,
      label: cached.label ?? 'this device',
      fromCache: true,
    };
    return { ...hit, message: describeAttachmentDownloadResult(hit) };
  }
  if (cancelled) {
    const abandoned: AttachmentDownloadResult = { success: false, reason: 'cancelled' };
    return { ...abandoned, message: describeAttachmentDownloadResult(abandoned) };
  }

  const permission = await ensureDownloadPermission();
  if (!permission.granted) {
    logWarn('[Attachments] storage permission denied; saving inside the app instead', {
      message: permission.message,
    });
  }

  logInfo('[Attachments] download started', { host: hostOf(url), mimeType, fileName });

  const result = await downloadWithFallback({
    url,
    fileName,
    onProgress,
    permission,
    isCancelled: () => cancelled,
    registerAbort: abort => {
      abortCurrentAttempt = abort;
    },
  });

  if (result.reason === 'cancelled') {
    logInfo('[Attachments] download cancelled', { host: hostOf(url) });
    return { ...result, message: describeAttachmentDownloadResult(result) };
  }
  if (result.success) {
    await rememberCachedAttachment({
      url,
      sourcePath: result.path,
      messageId,
      label: result.label,
    });
    return result;
  }

  logError('[Attachments] download failed', {
    host: hostOf(url),
    reason: result.reason,
    statusCode: result.statusCode,
    error: result.error,
  });
  return { ...result, message: describeAttachmentDownloadResult(result) };
}

const FAILURE_MESSAGES: Record<AttachmentDownloadReason, string> = {
  'missing-url': 'This attachment has no file yet — it may still be uploading',
  'unsupported-url': "This attachment's link isn't supported by this app",
  unauthorized: 'The server refused access to this file. Ask the admin to check storage access.',
  'not-found': 'This file is no longer available on the server',
  'server-error': 'The file server could not deliver this attachment. Try again later.',
  network: 'Could not reach the file server. Check your connection and try again.',
  storage: 'Could not save the file to device storage. Free up space and try again.',
  cancelled: 'Download cancelled',
};

/**
 * @returns a user-facing summary of the download outcome.
 */
export function describeAttachmentDownloadResult(result: { success?: boolean; label?: string; reason?: AttachmentDownloadReason; fromCache?: boolean; } | null | undefined): string {
  if (result?.success) {
    return result.fromCache
      ? `Attachment already saved to ${result.label}`
      : `Saved attachment to ${result.label}`;
  }
  return (result?.reason && FAILURE_MESSAGES[result.reason]) || 'Could not download attachment';
}
