jest.mock('../src/appLogger', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

import RNFS from 'react-native-fs';
import { logWarn } from '../src/appLogger';
import {
  attachmentCacheKey,
  evictCachedAttachmentsForMessage,
  findCachedAttachment,
  MAX_ATTACHMENT_CACHE_AGE_MS,
  MAX_ATTACHMENT_CACHE_BYTES,
  pruneMissingCachedAttachments,
  rememberCachedAttachment,
  resetAttachmentCacheState,
} from '../src/attachmentCache';

const INDEX_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-attachment-cache.json`;
const CACHE_DIRECTORY = `${RNFS.CachesDirectoryPath}/attachments`;

const NOW = Date.parse('2024-05-01T12:00:00.000Z');

/** Seed the index directly, for states a single download cannot produce. */
async function writeIndex(entries: Record<string, unknown>[]) {
  const index: Record<string, unknown> = {};
  entries.forEach(entry => {
    index[(entry as { key: string }).key] = entry;
  });
  await RNFS.writeFile(INDEX_FILE, JSON.stringify(index), 'utf8');
  resetAttachmentCacheState();
}

/** @returns the persisted index, as the module last wrote it. */
async function readIndex(): Promise<Record<string, { path: string; size: number }>> {
  return JSON.parse(await RNFS.readFile(INDEX_FILE, 'utf8'));
}

beforeEach(async () => {
  jest.clearAllMocks();
  (RNFS as unknown as { __reset: () => void }).__reset();
  resetAttachmentCacheState();
});

describe('attachmentCacheKey', () => {
  test('keys on the object key, so a re-signed URL still hits', () => {
    const first = attachmentCacheKey(
      'https://media.test/chatblobs/c1/abc.jpg?X-Amz-Signature=one&X-Amz-Expires=900',
    );
    const second = attachmentCacheKey(
      'https://media.test/chatblobs/c1/abc.jpg?X-Amz-Signature=two&X-Amz-Expires=60',
    );
    expect(first).toBe('media.test/chatblobs/c1/abc.jpg');
    expect(second).toBe(first);
  });

  test('distinguishes two attachments that share a display name', () => {
    expect(attachmentCacheKey('https://media.test/chatblobs/c1/photo.jpg')).not.toBe(
      attachmentCacheKey('https://media.test/chatblobs/c2/photo.jpg'),
    );
  });

  test('refuses anything that is not an http(s) URL', () => {
    expect(attachmentCacheKey('file:///etc/passwd')).toBeNull();
    expect(attachmentCacheKey('not a url')).toBeNull();
    expect(attachmentCacheKey(null)).toBeNull();
  });
});

describe('attachment cache lookups', () => {
  test('an attachment that was never downloaded is a miss', async () => {
    await expect(
      findCachedAttachment({ url: 'https://media.test/chatblobs/c1/a.pdf', now: NOW }),
    ).resolves.toBeNull();
  });

  test('a remembered attachment is a hit, served from app-owned storage', async () => {
    await RNFS.writeFile('/downloads/a.pdf', 'pdf-bytes', 'utf8');
    const stored = await rememberCachedAttachment({
      url: 'https://media.test/chatblobs/c1/a.pdf?sig=one',
      sourcePath: '/downloads/a.pdf',
      messageId: 'm-1',
      label: 'Downloads',
      now: NOW,
    });

    expect(stored?.path.startsWith(`${CACHE_DIRECTORY}/attachment-`)).toBe(true);
    expect(stored?.path.endsWith('.pdf')).toBe(true);
    expect(stored?.size).toBe('pdf-bytes'.length);

    // A different signature on the same object still resolves to the copy.
    const hit = await findCachedAttachment({
      url: 'https://media.test/chatblobs/c1/a.pdf?sig=two',
      now: NOW + 1000,
    });
    expect(hit).toMatchObject({ path: stored?.path, label: 'Downloads', messageId: 'm-1' });
    expect(hit?.lastUsedAtMs).toBe(NOW + 1000);
  });

  test('an entry whose file has left the disk is a miss, not a broken open', async () => {
    await RNFS.writeFile('/downloads/gone.pdf', 'bytes', 'utf8');
    const stored = await rememberCachedAttachment({
      url: 'https://media.test/chatblobs/c1/gone.pdf',
      sourcePath: '/downloads/gone.pdf',
      now: NOW,
    });
    // "Clear cached media", or the OS reclaiming the caches directory.
    await RNFS.unlink((stored as { path: string }).path);

    await expect(
      findCachedAttachment({ url: 'https://media.test/chatblobs/c1/gone.pdf', now: NOW }),
    ).resolves.toBeNull();
    // The stale entry is dropped, so the next open downloads cleanly.
    expect(await readIndex()).toEqual({});
  });

  test('an entry left unused past the age cap is evicted on lookup', async () => {
    const path = `${CACHE_DIRECTORY}/attachment-stale.pdf`;
    await RNFS.writeFile(path, 'old-bytes', 'utf8');
    await writeIndex([
      {
        key: 'media.test/chatblobs/c1/old.pdf',
        path,
        size: 9,
        cachedAtMs: NOW,
        lastUsedAtMs: NOW,
      },
    ]);

    await expect(
      findCachedAttachment({
        url: 'https://media.test/chatblobs/c1/old.pdf',
        now: NOW + MAX_ATTACHMENT_CACHE_AGE_MS,
      }),
    ).resolves.toBeNull();
    expect(await RNFS.exists(path)).toBe(false);
    expect(await readIndex()).toEqual({});
  });
});

describe('attachment cache bounds', () => {
  test('caching past the size cap drops the least recently used entry', async () => {
    const coldPath = `${CACHE_DIRECTORY}/attachment-cold.bin`;
    const warmPath = `${CACHE_DIRECTORY}/attachment-warm.bin`;
    await RNFS.writeFile(coldPath, 'cold', 'utf8');
    await RNFS.writeFile(warmPath, 'warm', 'utf8');
    const half = Math.ceil(MAX_ATTACHMENT_CACHE_BYTES / 2);
    await writeIndex([
      {
        key: 'media.test/chatblobs/c1/cold.bin',
        path: coldPath,
        size: half,
        cachedAtMs: NOW - 2000,
        lastUsedAtMs: NOW - 2000,
      },
      {
        key: 'media.test/chatblobs/c1/warm.bin',
        path: warmPath,
        size: half,
        cachedAtMs: NOW - 1000,
        lastUsedAtMs: NOW - 1000,
      },
    ]);

    await RNFS.writeFile('/downloads/new.bin', 'new-bytes', 'utf8');
    await rememberCachedAttachment({
      url: 'https://media.test/chatblobs/c1/new.bin',
      sourcePath: '/downloads/new.bin',
      now: NOW,
    });

    const index = await readIndex();
    expect(Object.keys(index).sort()).toEqual([
      'media.test/chatblobs/c1/new.bin',
      'media.test/chatblobs/c1/warm.bin',
    ]);
    // The evicted entry's bytes go with it: a bounded cache that only forgets
    // would leave the files behind for ever.
    expect(await RNFS.exists(coldPath)).toBe(false);
    expect(await RNFS.exists(warmPath)).toBe(true);
  });

  test('a stale entry is pruned when another attachment is cached', async () => {
    const stalePath = `${CACHE_DIRECTORY}/attachment-stale.bin`;
    await RNFS.writeFile(stalePath, 'stale', 'utf8');
    await writeIndex([
      {
        key: 'media.test/chatblobs/c1/stale.bin',
        path: stalePath,
        size: 5,
        cachedAtMs: NOW - MAX_ATTACHMENT_CACHE_AGE_MS,
        lastUsedAtMs: NOW - MAX_ATTACHMENT_CACHE_AGE_MS,
      },
    ]);

    await RNFS.writeFile('/downloads/fresh.bin', 'fresh', 'utf8');
    await rememberCachedAttachment({
      url: 'https://media.test/chatblobs/c1/fresh.bin',
      sourcePath: '/downloads/fresh.bin',
      now: NOW,
    });

    expect(Object.keys(await readIndex())).toEqual(['media.test/chatblobs/c1/fresh.bin']);
    expect(await RNFS.exists(stalePath)).toBe(false);
  });

  test('files removed behind the cache are forgotten by the clear path', async () => {
    await RNFS.writeFile('/downloads/kept.pdf', 'kept', 'utf8');
    await RNFS.writeFile('/downloads/cleared.pdf', 'cleared', 'utf8');
    const kept = await rememberCachedAttachment({
      url: 'https://media.test/chatblobs/c1/kept.pdf',
      sourcePath: '/downloads/kept.pdf',
      now: NOW,
    });
    const cleared = await rememberCachedAttachment({
      url: 'https://media.test/chatblobs/c1/cleared.pdf',
      sourcePath: '/downloads/cleared.pdf',
      now: NOW,
    });
    await RNFS.unlink((cleared as { path: string }).path);

    await expect(pruneMissingCachedAttachments()).resolves.toBe(1);
    expect(Object.values(await readIndex()).map(entry => entry.path)).toEqual([
      (kept as { path: string }).path,
    ]);
  });
});

describe('evictCachedAttachmentsForMessage', () => {
  test('deletes the cached bytes of a tombstoned message', async () => {
    await RNFS.writeFile('/downloads/secret.pdf', 'secret', 'utf8');
    const stored = await rememberCachedAttachment({
      url: 'https://media.test/chatblobs/c1/secret.pdf',
      sourcePath: '/downloads/secret.pdf',
      messageId: 'm-9',
      now: NOW,
    });

    await expect(evictCachedAttachmentsForMessage('m-9')).resolves.toBe(1);
    expect(await RNFS.exists((stored as { path: string }).path)).toBe(false);
    expect(await readIndex()).toEqual({});
    // And the deletion holds: the next open cannot be served from cache.
    await expect(
      findCachedAttachment({ url: 'https://media.test/chatblobs/c1/secret.pdf', now: NOW }),
    ).resolves.toBeNull();
  });

  test('leaves other messages alone', async () => {
    await RNFS.writeFile('/downloads/keep.pdf', 'keep', 'utf8');
    await rememberCachedAttachment({
      url: 'https://media.test/chatblobs/c1/keep.pdf',
      sourcePath: '/downloads/keep.pdf',
      messageId: 'm-1',
      now: NOW,
    });

    await expect(evictCachedAttachmentsForMessage('m-2')).resolves.toBe(0);
    expect(
      await findCachedAttachment({ url: 'https://media.test/chatblobs/c1/keep.pdf', now: NOW }),
    ).not.toBeNull();
  });

  test('forgets an entry whose file could not be deleted, and says so', async () => {
    await RNFS.writeFile('/downloads/locked.pdf', 'locked', 'utf8');
    await rememberCachedAttachment({
      url: 'https://media.test/chatblobs/c1/locked.pdf',
      sourcePath: '/downloads/locked.pdf',
      messageId: 'm-3',
      now: NOW,
    });
    (RNFS.unlink as jest.Mock).mockRejectedValueOnce(new Error('EBUSY'));

    await expect(evictCachedAttachmentsForMessage('m-3')).resolves.toBe(1);
    // Bytes that survive a tombstone are privacy-relevant, so the failure is
    // logged rather than swallowed — and the entry still goes.
    expect(logWarn).toHaveBeenCalledWith(
      '[AttachmentCache] Failed to delete a cached attachment',
      expect.objectContaining({ why: 'tombstoned' }),
    );
    expect(await readIndex()).toEqual({});
  });
});
