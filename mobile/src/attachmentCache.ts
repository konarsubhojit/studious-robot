import RNFS from 'react-native-fs';
import { logInfo, logWarn } from './appLogger';
import { errorMessage } from './errors';

/**
 * A local copy of attachments already fetched from object storage, so opening
 * the same file twice costs one download rather than two.
 *
 * Three properties make this safe to keep:
 *
 * - Entries are keyed by the attachment's *object key* (the URL path), not by
 *   its display name: the name is sender-controlled and not unique, while the
 *   key is stable across the signed URLs that are re-minted on every fetch.
 * - The cache is bounded, by age and by total size, so it can never grow into
 *   the storage complaint it exists to avoid.
 * - It is an optimisation, never a second copy of the record. A tombstoned
 *   message's bytes are deleted from here too (see
 *   {@link evictCachedAttachmentsForMessage}); a cached file that outlived its
 *   tombstone would let this device show content the sender has withdrawn.
 *
 * Cached files live in the app's caches directory under names with no
 * `wetalk-` prefix, which is precisely how `storageUsage.ts` classifies a file
 * as recoverable media — so they are counted in Settings' storage row and
 * removed by "Clear cached media" without either side needing to know about
 * the other.
 */

/** Where the bytes live. Under caches, so the OS may reclaim them too. */
function cacheDirectory(): string | null {
  const base = RNFS?.CachesDirectoryPath || RNFS?.DocumentDirectoryPath;
  return base ? `${base}/attachments` : null;
}

/** Where the bookkeeping lives: app state, so "clear media" leaves it alone. */
function indexFile(): string | null {
  const base = RNFS?.DocumentDirectoryPath || RNFS?.CachesDirectoryPath;
  return base ? `${base}/wetalk-attachment-cache.json` : null;
}

/** Total bytes the cache may hold before the least recently used entries go. */
export const MAX_ATTACHMENT_CACHE_BYTES = 64 * 1024 * 1024;

/** How long an entry may go unused before it is treated as stale. */
export const MAX_ATTACHMENT_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export type CachedAttachment = {
  /** The attachment's object key, stable across re-signed URLs. */
  key: string;
  /** The message the bytes belong to, so a tombstone can evict them. */
  messageId?: string | null;
  /** Absolute path of the cached copy. */
  path: string;
  /** Where the original download landed, for the status line on a hit. */
  label?: string | null;
  size: number;
  cachedAtMs: number;
  lastUsedAtMs: number;
};

type CacheIndex = Record<string, CachedAttachment>;

let indexCache: CacheIndex | null = null;

/**
 * Whether this platform gave us the filesystem calls the cache needs. Under a
 * partial `react-native-fs` (a test double, an unsupported platform) caching
 * degrades to "always a miss" rather than failing the download it wraps.
 */
function isCacheUsable(): boolean {
  return (
    Boolean(cacheDirectory() && indexFile()) &&
    ['exists', 'readFile', 'writeFile', 'unlink', 'mkdir', 'copyFile', 'stat'].every(
      method => typeof (RNFS as unknown as Record<string, unknown>)?.[method] === 'function',
    )
  );
}

/**
 * The attachment's identity: the URL's path, which is the R2 object key.
 *
 * Query parameters are dropped deliberately — a presigned URL carries a
 * different signature and expiry every time it is minted, and keying on those
 * would make every fetch a miss.
 *
 * @returns the key, or `null` when `url` is not a usable http(s) URL.
 */
export function attachmentCacheKey(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    return path ? `${parsed.host}/${path}` : null;
  } catch {
    return null;
  }
}

/**
 * Two multiplicative hashes of the key, for a 16-hex-character digest.
 *
 * A hash only names the file; the index still stores the full key and is what
 * a lookup matches on, so a collision costs a re-download rather than the
 * wrong file.
 */
function hashKey(key: string): string {
  const MODULUS = 2147483647;
  const digest = (seed: number, multiplier: number) => {
    let hash = seed;
    for (let index = 0; index < key.length; index += 1) {
      hash = (hash * multiplier + key.charCodeAt(index)) % MODULUS;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return `${digest(7, 31)}${digest(2166136261, 16777619)}`;
}

/** @returns a safe extension taken from the source path, or `bin`. */
function extensionOf(path: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(path ?? '');
  return match ? match[1].toLowerCase() : 'bin';
}

/**
 * Coerce a parsed index file into usable entries, dropping anything malformed
 * so a corrupt file degrades to an empty cache instead of a crash.
 */
function sanitize(parsed: unknown): CacheIndex {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const index: CacheIndex = {};
  Object.values(parsed as Record<string, unknown>).forEach(value => {
    const entry = value as Partial<CachedAttachment>;
    if (typeof entry?.key !== 'string' || typeof entry?.path !== 'string') return;
    if (!entry.key || !entry.path) return;
    index[entry.key] = {
      key: entry.key,
      messageId: typeof entry.messageId === 'string' ? entry.messageId : null,
      path: entry.path,
      label: typeof entry.label === 'string' ? entry.label : null,
      size: Number(entry.size) || 0,
      cachedAtMs: Number(entry.cachedAtMs) || 0,
      lastUsedAtMs: Number(entry.lastUsedAtMs) || Number(entry.cachedAtMs) || 0,
    };
  });
  return index;
}

/** Read the index, memoised. Never rejects: an unreadable file is no cache. */
async function loadIndex(): Promise<CacheIndex> {
  if (indexCache) return indexCache;
  const file = indexFile();
  if (!file || !isCacheUsable()) {
    indexCache = {};
    return indexCache;
  }
  try {
    const exists = await RNFS.exists(file);
    indexCache = exists ? sanitize(JSON.parse(await RNFS.readFile(file, 'utf8'))) : {};
  } catch (error) {
    logWarn('[AttachmentCache] Failed to read the cache index', {
      message: errorMessage(error),
    });
    indexCache = {};
  }
  return indexCache;
}

/** Persist the index. Failures are logged: they only cost a re-download. */
async function saveIndex(index: CacheIndex): Promise<void> {
  indexCache = index;
  const file = indexFile();
  if (!file || !isCacheUsable()) return;
  try {
    await RNFS.writeFile(file, JSON.stringify(index), 'utf8');
  } catch (error) {
    logWarn('[AttachmentCache] Failed to persist the cache index', {
      message: errorMessage(error),
    });
  }
}

/**
 * Delete one entry's bytes.
 *
 * A file that could not be removed is privacy-relevant when the reason for
 * removing it was a tombstone, so it is logged rather than swallowed.
 */
async function removeFile(entry: CachedAttachment, why: string): Promise<boolean> {
  try {
    if (await RNFS.exists(entry.path)) await RNFS.unlink(entry.path);
    return true;
  } catch (error) {
    logWarn('[AttachmentCache] Failed to delete a cached attachment', {
      why,
      message: errorMessage(error),
    });
    return false;
  }
}

/**
 * Bring the cache back within its bounds: stale entries first, then the least
 * recently used ones until the total fits.
 *
 * @returns the pruned index.
 */
async function prune(index: CacheIndex, now: number): Promise<CacheIndex> {
  const kept: CachedAttachment[] = [];
  for (const entry of Object.values(index)) {
    if (now - entry.lastUsedAtMs >= MAX_ATTACHMENT_CACHE_AGE_MS) {
      await removeFile(entry, 'expired');
      continue;
    }
    kept.push(entry);
  }

  // Newest use first, so the tail that overflows the cap is the coldest.
  kept.sort((left, right) => right.lastUsedAtMs - left.lastUsedAtMs);
  const survivors: CacheIndex = {};
  let total = 0;
  for (const entry of kept) {
    total += entry.size;
    if (total > MAX_ATTACHMENT_CACHE_BYTES) {
      await removeFile(entry, 'over-capacity');
      continue;
    }
    survivors[entry.key] = entry;
  }
  return survivors;
}

/**
 * Look for an already-downloaded copy of an attachment.
 *
 * An entry whose file has since left the disk — cleared from Settings, or
 * reclaimed by the OS from the caches directory — is a miss, not a broken
 * open: the stale entry is dropped and the caller downloads again.
 *
 * @returns the cached entry, or `null` on a miss.
 */
export async function findCachedAttachment({ url, now = Date.now() }: {
  url?: string | null;
  now?: number;
} = {}): Promise<CachedAttachment | null> {
  const key = attachmentCacheKey(url);
  if (!key || !isCacheUsable()) return null;

  const index = await loadIndex();
  const entry = index[key];
  if (!entry) return null;

  const stale = now - entry.lastUsedAtMs >= MAX_ATTACHMENT_CACHE_AGE_MS;
  let onDisk = false;
  try {
    onDisk = await RNFS.exists(entry.path);
  } catch (error) {
    logWarn('[AttachmentCache] Failed to check a cached attachment', {
      message: errorMessage(error),
    });
  }

  if (stale || !onDisk) {
    if (stale && onDisk) await removeFile(entry, 'expired');
    const remaining = { ...index };
    delete remaining[key];
    await saveIndex(remaining);
    return null;
  }

  const used = { ...entry, lastUsedAtMs: now };
  await saveIndex({ ...index, [key]: used });
  logInfo('[AttachmentCache] cache hit', { size: used.size });
  return used;
}

/**
 * Keep a copy of a freshly downloaded attachment.
 *
 * The download's own destination is not reused as the cache entry: it can be
 * the shared Downloads folder, which the user owns and may move or delete at
 * will. The cache keeps its own copy in app-owned storage.
 *
 * @returns the stored entry, or `null` when nothing could be cached.
 */
export async function rememberCachedAttachment({ url, sourcePath, messageId, label, now = Date.now() }: {
  url?: string | null;
  sourcePath?: string | null;
  messageId?: string | null;
  label?: string | null;
  now?: number;
}): Promise<CachedAttachment | null> {
  const key = attachmentCacheKey(url);
  const directory = cacheDirectory();
  if (!key || !directory || !sourcePath || !isCacheUsable()) return null;

  const path = `${directory}/attachment-${hashKey(key)}.${extensionOf(sourcePath)}`;
  try {
    await RNFS.mkdir(directory);
    if (await RNFS.exists(path)) await RNFS.unlink(path);
    await RNFS.copyFile(sourcePath, path);
    const size = Number((await RNFS.stat(path))?.size) || 0;
    const entry: CachedAttachment = {
      key,
      messageId: messageId ?? null,
      path,
      label: label ?? null,
      size,
      cachedAtMs: now,
      lastUsedAtMs: now,
    };
    await saveIndex(await prune({ ...(await loadIndex()), [key]: entry }, now));
    return entry;
  } catch (error) {
    logWarn('[AttachmentCache] Failed to cache a downloaded attachment', {
      message: errorMessage(error),
    });
    return null;
  }
}

/**
 * Delete every cached file belonging to a tombstoned message.
 *
 * Called for both sides of a deletion — the local user's own delete and an
 * inbound `message.deleted` — and keyed by message id so it works just as well
 * for a message that has already been evicted from the in-memory timeline.
 *
 * @returns how many entries were removed from the index.
 */
export async function evictCachedAttachmentsForMessage(
  messageId: string | null | undefined,
): Promise<number> {
  if (!messageId || !isCacheUsable()) return 0;
  const index = await loadIndex();
  const doomed = Object.values(index).filter(entry => entry.messageId === messageId);
  if (doomed.length === 0) return 0;

  const survivors: CacheIndex = { ...index };
  for (const entry of doomed) {
    await removeFile(entry, 'tombstoned');
    // The entry goes regardless of whether the unlink worked: keeping it would
    // let a later open serve bytes the sender has withdrawn.
    delete survivors[entry.key];
  }
  await saveIndex(survivors);
  logInfo('[AttachmentCache] evicted cached attachments for a deleted message', {
    entries: doomed.length,
  });
  return doomed.length;
}

/**
 * Drop entries whose files are gone, after something outside this module
 * removed them ("Clear cached media", or the OS reclaiming the directory).
 *
 * @returns how many entries were dropped.
 */
export async function pruneMissingCachedAttachments(): Promise<number> {
  if (!isCacheUsable()) return 0;
  const index = await loadIndex();
  const survivors: CacheIndex = {};
  let dropped = 0;
  for (const entry of Object.values(index)) {
    let onDisk = false;
    try {
      onDisk = await RNFS.exists(entry.path);
    } catch {
      onDisk = false;
    }
    if (onDisk) survivors[entry.key] = entry;
    else dropped += 1;
  }
  if (dropped > 0) await saveIndex(survivors);
  return dropped;
}

/** Test seam: forget the in-memory index so the next read hits the file. */
export function resetAttachmentCacheState() {
  indexCache = null;
}
