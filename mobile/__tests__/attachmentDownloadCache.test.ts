jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

jest.mock('../src/permissions', () => ({
  ensureDownloadPermission: jest.fn(async () => ({ granted: true })),
}));

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logVerbose: jest.fn(),
  logWarn: jest.fn(),
}));

import RNFS from 'react-native-fs';
import { evictCachedAttachmentsForMessage, resetAttachmentCacheState } from '../src/attachmentCache';
import { downloadAttachment } from '../src/attachmentDownload';

/**
 * The download path's use of the local cache: what a second tap on the same
 * attachment costs, and what a tombstone takes away.
 *
 * Uses the automatic `react-native-fs` mock, whose in-memory filesystem lets a
 * download actually leave a file behind for the next call to find.
 */

const SIGNED_URL = 'https://media.test/chatblobs/c1/report.pdf?X-Amz-Signature=first';
const RESIGNED_URL = 'https://media.test/chatblobs/c1/report.pdf?X-Amz-Signature=second';

beforeEach(() => {
  jest.clearAllMocks();
  (RNFS as unknown as { __reset: () => void }).__reset();
  resetAttachmentCacheState();
  (RNFS.downloadFile as jest.Mock).mockImplementation(({ toFile }: { toFile: string }) => {
    RNFS.writeFile(toFile, 'report-bytes', 'utf8');
    return { promise: Promise.resolve({ statusCode: 200 }) };
  });
});

describe('downloadAttachment caching', () => {
  test('a second open is served from the cache without a network request', async () => {
    const first = await downloadAttachment({
      url: SIGNED_URL,
      name: 'report.pdf',
      messageId: 'm-1',
    });
    expect(first).toMatchObject({ success: true, path: `${RNFS.DocumentDirectoryPath}/report.pdf` });
    expect(first.fromCache).toBeFalsy();
    expect(RNFS.downloadFile).toHaveBeenCalledTimes(1);

    const second = await downloadAttachment({
      url: RESIGNED_URL,
      name: 'report.pdf',
      messageId: 'm-1',
    });
    expect(second).toMatchObject({
      success: true,
      fromCache: true,
      message: 'Attachment already saved to app documents',
    });
    expect(await RNFS.exists((second.path as string))).toBe(true);
    // The whole point: the bytes were already here.
    expect(RNFS.downloadFile).toHaveBeenCalledTimes(1);
  });

  test('a cached file deleted from disk falls back to a fresh download', async () => {
    const first = await downloadAttachment({ url: SIGNED_URL, name: 'report.pdf' });
    const cached = await downloadAttachment({ url: SIGNED_URL, name: 'report.pdf' });
    await RNFS.unlink((cached.path as string));
    expect(first.success && cached.fromCache).toBe(true);

    const refetched = await downloadAttachment({ url: SIGNED_URL, name: 'report.pdf' });

    expect(refetched).toMatchObject({ success: true });
    expect(refetched.fromCache).toBeFalsy();
    expect(RNFS.downloadFile).toHaveBeenCalledTimes(2);
  });

  test('a tombstoned message has no open path left in the cache', async () => {
    await downloadAttachment({ url: SIGNED_URL, name: 'report.pdf', messageId: 'm-9' });

    await evictCachedAttachmentsForMessage('m-9');

    // Nothing to open: the only way back to the bytes is another fetch, which
    // the server has already refused for a deleted attachment.
    (RNFS.downloadFile as jest.Mock).mockImplementation(() => ({
      promise: Promise.resolve({ statusCode: 404 }),
    }));
    await expect(
      downloadAttachment({ url: SIGNED_URL, name: 'report.pdf', messageId: 'm-9' }),
    ).resolves.toMatchObject({ success: false, reason: 'not-found' });
  });
});
