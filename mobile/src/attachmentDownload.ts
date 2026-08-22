// @ts-check
import { Platform } from 'react-native';
import RNFS from 'react-native-fs';

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
 * @param {Date} [date]
 * @returns {string} `YYYYMMDD-HHmmss`, safe to embed in a file name.
 */
function formatDateForFile(date: Date = new Date()): string {
  /** @param {number} value */
  const pad = (value: number): number => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * @param {string | null | undefined} mimeType
 * @returns {string} a file extension, defaulting to `bin`.
 */
function extensionForMimeType(mimeType: string | null | undefined): string {
  const normalised = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  return (
    /** @type {Record<string, string|undefined>} */ (EXTENSION_BY_MIME_TYPE)[normalised] ?? 'bin'
  );
}

/**
 * @param {string | null | undefined} url
 * @returns {string} the last path segment, or '' when `url` is unparseable.
 */
function filenameFromUrl(url: string | null | undefined): string {
  try {
    const parsed = new URL(/** @type {string} */ (url));
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    return '';
  }
}

/**
 * Build a local filename for a downloaded attachment without trusting sender
 * controlled path separators or device-specific reserved characters.
 *
 * @param {{
 *   name?: string | null,
 *   url?: string | null,
 *   mimeType?: string | null,
 *   now?: Date,
 * }} [attachment]
 * @returns {string}
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
        { directory: RNFS.DownloadDirectoryPath, label: 'Downloads', primary: true },
        { directory: RNFS.ExternalDirectoryPath, label: 'app external storage', primary: false },
        { directory: RNFS.DocumentDirectoryPath, label: 'app documents', primary: false },
      ]
    : [{ directory: RNFS.DocumentDirectoryPath, label: 'app documents', primary: true }];
}

/**
 * Download a previously sent/received chat attachment into the most accessible
 * device storage location available.
 *
 * @param {{
 *   url?: string | null,
 *   name?: string | null,
 *   mimeType?: string | null,
 *   now?: Date,
 * }} [attachment]
 * @returns {Promise<{
 *   success: boolean,
 *   path?: string,
 *   label?: string,
 *   usedFallback?: boolean,
 *   error?: unknown,
 * }>}
 */
export async function downloadAttachment({ url, name, mimeType, now = new Date() }: {
    url?: string | null;
    name?: string | null;
    mimeType?: string | null;
    now?: Date;
} = {}): Promise<{
    success: boolean;
    path?: string;
    label?: string;
    usedFallback?: boolean;
    error?: unknown;
}> {
  if (!url || typeof url !== 'string') {
    return { success: false, error: new Error('Missing attachment URL') };
  }

  const fileName = attachmentDownloadFileName({ name, url, mimeType, now });
  let firstError;

  for (const target of downloadTargets()) {
    if (!target.directory) continue;
    const path = `${target.directory}/${fileName}`;
    try {
      const job = RNFS.downloadFile({ fromUrl: url, toFile: path });
      const result = await job.promise;
      if (!result || result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(`Download failed with status ${result?.statusCode ?? 'unknown'}`);
      }
      return { success: true, path, label: target.label, usedFallback: !target.primary };
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }

  return { success: false, error: firstError };
}

/**
 * @param {{ success?: boolean, label?: string } | null | undefined} result
 * @returns {string} a user-facing summary of the download outcome.
 */
export function describeAttachmentDownloadResult(result: { success?: boolean; label?: string; } | null | undefined): string {
  if (result?.success) return `Saved attachment to ${result.label}`;
  return 'Could not download attachment';
}
