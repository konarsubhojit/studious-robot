import RNFS from 'react-native-fs';
import { logWarn } from './appLogger';
import { errorMessage } from './errors';

/**
 * What the app is holding on this device, and how to give some of it back.
 *
 * Settings could show every preference the app owns but not a single byte it
 * had written, so "the app is using a lot of space" was a question only the
 * OS's own storage screen could answer — and its answer ("WeTalk, 214 MB")
 * came with no way to act on it beyond uninstalling.
 *
 * The split that matters to the user is *recoverable* versus *not*: a cached
 * photo can be downloaded again, a conversation cannot. Files are therefore
 * classified by name rather than by directory, because all three live side by
 * side in the app's own document directory (see `settingsStorage.ts`,
 * `storage/chatDb.ts`, and the app-private fallback targets in
 * `attachmentDownload.ts`).
 */

export type StorageCategory =
  /** Cached attachments and recorded voice notes: safe to delete, re-fetchable. */
  | 'media'
  /** Durable and crash logs: kept, because they exist to survive the failure. */
  | 'logs'
  /** Conversations, settings, identity: deleting these loses something. */
  | 'data';

export type StorageUsage = {
  totalBytes: number;
  mediaBytes: number;
  logBytes: number;
  dataBytes: number;
  /** How many files "Clear cached media" would remove. */
  mediaFileCount: number;
  /** `false` when the platform gave us no readable directory to measure. */
  measured: boolean;
};

export type ClearMediaResult = {
  removedFiles: number;
  freedBytes: number;
  /** Files that could not be removed (in use, or permission denied). */
  failedFiles: number;
  /** Files skipped because a recording or upload may still hold them. */
  skippedFiles: number;
};

export const EMPTY_STORAGE_USAGE: StorageUsage = {
  totalBytes: 0,
  mediaBytes: 0,
  logBytes: 0,
  dataBytes: 0,
  mediaFileCount: 0,
  measured: false,
};

/**
 * Files the app writes for itself. Everything named this way is state or a
 * log; anything else in these directories arrived as media.
 */
const APP_FILE_PREFIX = 'wetalk-';

/**
 * How deep to walk. The app writes flat, but the media cache is native
 * territory (the video player and the voice recorder both create their own
 * subdirectories), so a couple of levels are needed — and a hard stop keeps a
 * pathological tree from turning a Settings render into a filesystem crawl.
 */
const MAX_WALK_DEPTH = 3;

/**
 * A file younger than this is left alone by "Clear cached media".
 *
 * A voice note is uploaded *from* its cache path (`attachmentUpload` sends
 * `{ uri }` rather than bytes), so deleting one mid-upload would fail the send
 * that is already in flight. Age is the only signal available here.
 */
export const RECENT_FILE_GRACE_MS = 60_000;

/**
 * Classify a stored file by its name.
 *
 * @param name Base name, without its directory.
 */
export function categorizeStoredFile(name: string): StorageCategory {
  const lower = (name ?? '').toLowerCase();
  if (!lower.startsWith(APP_FILE_PREFIX)) return 'media';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'logs';
  if (lower.endsWith('.json')) return 'data';
  // A `wetalk-`-prefixed file of some other kind is app-written state we have
  // no claim to delete; count it as data rather than guessing.
  return 'data';
}

/**
 * Human-readable size, rounded the way a storage screen rounds: whole bytes,
 * then one decimal once the unit gets big enough for it to mean anything.
 */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB'];
  let scaled = value / 1024;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  // One decimal below 100, none above it: "1.4 MB" is informative, "1428.6 MB"
  // is noise.
  const rounded = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

type StoredFile = {
  path: string;
  name: string;
  size: number;
  modifiedAtMs: number;
};

/** Directories the app can read and is allowed to account for. */
function measurableDirectories(): string[] {
  return [
    RNFS?.DocumentDirectoryPath,
    RNFS?.CachesDirectoryPath,
    RNFS?.TemporaryDirectoryPath,
  ].filter((directory): directory is string => Boolean(directory));
}

/** @param entry a `react-native-fs` `ReadDirItem`. */
function modifiedAtMs(entry: { mtime?: Date | string | number | null }): number {
  const mtime = entry?.mtime;
  if (!mtime) return 0;
  const parsed = mtime instanceof Date ? mtime.getTime() : new Date(mtime).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Every file under `directory`, depth-limited.
 *
 * Never throws, but does report whether the read worked: an empty directory
 * and an unreadable one are both "no files", and only the second one means the
 * total on screen would be a lie.
 */
async function listFiles(
  directory: string,
  depth = 0,
): Promise<{ files: StoredFile[]; readable: boolean }> {
  if (depth > MAX_WALK_DEPTH || typeof RNFS?.readDir !== 'function') {
    return { files: [], readable: false };
  }
  let entries;
  try {
    entries = await RNFS.readDir(directory);
  } catch {
    return { files: [], readable: false };
  }

  const files: StoredFile[] = [];
  for (const entry of entries ?? []) {
    const isDirectory =
      typeof entry?.isDirectory === 'function' ? entry.isDirectory() : false;
    if (isDirectory) {
      // A subdirectory we cannot read does not make its parent unreadable.
      files.push(...(await listFiles(entry.path, depth + 1)).files);
      continue;
    }
    files.push({
      path: entry.path,
      name: entry.name,
      size: Number(entry.size) || 0,
      modifiedAtMs: modifiedAtMs(entry),
    });
  }
  return { files, readable: true };
}

/**
 * Add one directory's files to the running totals, skipping any path already
 * counted.
 */
function accumulateFiles(
  usage: StorageUsage,
  files: StoredFile[],
  seenPaths: Set<string>,
): void {
  for (const file of files) {
    if (seenPaths.has(file.path)) continue;
    seenPaths.add(file.path);

    const category = categorizeStoredFile(file.name);
    usage.totalBytes += file.size;
    if (category === 'media') {
      usage.mediaBytes += file.size;
      usage.mediaFileCount += 1;
    } else if (category === 'logs') {
      usage.logBytes += file.size;
    } else {
      usage.dataBytes += file.size;
    }
  }
}

/**
 * Measure what the app is storing on this device.
 *
 * Reports zeroes with `measured: false` rather than rejecting when the
 * platform exposes no readable directory, so the caller can say "unavailable"
 * instead of drawing a confident "0 B".
 */
export async function measureStorageUsage(): Promise<StorageUsage> {
  const directories = measurableDirectories();
  if (directories.length === 0 || typeof RNFS?.readDir !== 'function') {
    return { ...EMPTY_STORAGE_USAGE };
  }

  const usage: StorageUsage = { ...EMPTY_STORAGE_USAGE };
  // Deduplicated because the platform can point two of these constants at the
  // same place (a cache directory nested inside documents, notably), and a
  // file counted twice reads as the app using twice the space it does.
  const seenPaths = new Set<string>();

  for (const directory of directories) {
    const { files, readable } = await listFiles(directory);
    // One readable directory is enough to report a real number; every
    // directory failing means the device told us nothing.
    if (readable) usage.measured = true;
    accumulateFiles(usage, files, seenPaths);
  }

  return usage;
}

async function clearMediaInDirectory(
  directory: string,
  now: number,
  seenPaths: Set<string>,
  result: ClearMediaResult,
) {
  for (const file of (await listFiles(directory)).files) {
    if (seenPaths.has(file.path)) continue;
    seenPaths.add(file.path);
    if (categorizeStoredFile(file.name) !== 'media') continue;
    if (file.modifiedAtMs && now - file.modifiedAtMs < RECENT_FILE_GRACE_MS) {
      result.skippedFiles += 1;
      continue;
    }
    try {
      await RNFS.unlink(file.path);
      result.removedFiles += 1;
      result.freedBytes += file.size;
    } catch (error) {
      result.failedFiles += 1;
      logWarn('[StorageUsage] Failed to remove cached file', {
        message: errorMessage(error),
      });
    }
  }
}

/**
 * Delete the cached media the app can recreate, leaving conversations,
 * settings and logs untouched.
 *
 * Reports per-file outcomes instead of throwing on the first failure: one
 * locked file must not stop the rest being freed, and the caller has to be
 * able to tell "nothing to clear" from "we tried and could not".
 */
export async function clearCachedMedia({
  now = Date.now(),
}: { now?: number } = {}): Promise<ClearMediaResult> {
  const result: ClearMediaResult = {
    removedFiles: 0,
    freedBytes: 0,
    failedFiles: 0,
    skippedFiles: 0,
  };
  if (typeof RNFS?.unlink !== 'function') return result;

  const seenPaths = new Set<string>();
  for (const directory of measurableDirectories()) {
    await clearMediaInDirectory(directory, now, seenPaths, result);
  }

  return result;
}

/** @param count */
function pluralizeFiles(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/**
 * One sentence describing what clearing achieved, for the status line.
 *
 * Every outcome is named, including the two that look like failures but are
 * not: nothing cached, and files held by an in-flight upload.
 */
export function describeClearMediaResult(result: ClearMediaResult): string {
  if (result.removedFiles > 0) {
    const skipped =
      result.skippedFiles > 0 ? `; ${pluralizeFiles(result.skippedFiles)} still in use` : '';
    const failed =
      result.failedFiles > 0
        ? `; ${pluralizeFiles(result.failedFiles)} could not be removed`
        : '';
    return `Freed ${formatBytes(result.freedBytes)}${skipped}${failed}.`;
  }
  if (result.failedFiles > 0) return 'Cached media could not be removed.';
  if (result.skippedFiles > 0) return 'Cached media is still in use; try again in a moment.';
  return 'No cached media to clear.';
}
