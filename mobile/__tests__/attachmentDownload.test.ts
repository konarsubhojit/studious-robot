jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

jest.mock('react-native-fs', () => ({
  DownloadDirectoryPath: '/downloads',
  ExternalDirectoryPath: '/external',
  DocumentDirectoryPath: '/docs',
  downloadFile: jest.fn(),
  stopDownload: jest.fn(),
  unlink: jest.fn(() => Promise.resolve()),
}));

import RNFS from 'react-native-fs';
import {
  attachmentDownloadFileName,
  describeAttachmentDownloadResult,
  downloadAttachment,
  isAttachmentDownloadRetryable,
} from '../src/attachmentDownload';

describe('attachmentDownload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sanitizes sender-controlled file names before writing to Downloads', async () => {
    (RNFS.downloadFile as jest.Mock).mockReturnValueOnce({
      promise: Promise.resolve({ statusCode: 200 }),
    });

    const result = await downloadAttachment({
      url: 'https://media.test/chatblobs/c/file.pdf',
      name: '../unsafe?.pdf',
      mimeType: 'application/pdf',
    });

    expect(result).toMatchObject({ success: true, label: 'Downloads', path: '/downloads/_unsafe_.pdf' });
    expect(RNFS.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fromUrl: 'https://media.test/chatblobs/c/file.pdf',
        toFile: '/downloads/_unsafe_.pdf',
      }),
    );
  });

  test('falls back to app storage when the Downloads write fails', async () => {
    (RNFS.downloadFile as jest.Mock)
      .mockReturnValueOnce({ promise: Promise.reject(new Error('permission denied')) })
      .mockReturnValueOnce({ promise: Promise.resolve({ statusCode: 200 }) });

    const result = await downloadAttachment({
      url: 'https://media.test/chatblobs/c/report.txt',
      mimeType: 'text/plain',
    });

    expect(result).toMatchObject({
      success: true,
      label: 'app external storage',
      path: '/external/report.txt',
      usedFallback: true,
    });
    expect(RNFS.downloadFile).toHaveBeenCalledTimes(2);
  });

  test('creates a timestamped fallback name when no usable name exists', () => {
    expect(
      attachmentDownloadFileName({
        mimeType: 'image/png',
        now: new Date('2026-08-21T13:27:00.000Z'),
      }),
    ).toBe('wetalk-attachment-20260821-132700.png');
  });

  test('describes success and failure for status banners', () => {
    expect(describeAttachmentDownloadResult({ success: true, label: 'Downloads' })).toBe(
      'Saved attachment to Downloads',
    );
    expect(describeAttachmentDownloadResult({ success: false })).toBe('Could not download attachment');
  });

  test('reports an unreadable object (HTTP 403) as a storage-access problem, without retrying', async () => {
    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      promise: Promise.resolve({ statusCode: 403 }),
    });

    const result = await downloadAttachment({
      url: 'https://media.test/chatblobs/c/blocked.pdf',
      mimeType: 'application/pdf',
    });

    expect(result).toMatchObject({ success: false, reason: 'unauthorized', statusCode: 403 });
    expect(result.message).toMatch(/refused access/i);
    // A refusal by storage is identical in every directory, so it is not retried.
    expect(RNFS.downloadFile).toHaveBeenCalledTimes(1);
  });

  test('reports an unreachable file server as a network failure', async () => {
    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      promise: Promise.reject(new Error('Unable to resolve host')),
    });

    const result = await downloadAttachment({ url: 'https://media.test/chatblobs/c/a.pdf' });

    expect(result).toMatchObject({ success: false, reason: 'network' });
    expect(describeAttachmentDownloadResult(result)).toMatch(/connection/i);
  });

  test('refuses an attachment with no URL, or one that is not http(s)', async () => {
    await expect(downloadAttachment({})).resolves.toMatchObject({
      success: false,
      reason: 'missing-url',
    });
    await expect(downloadAttachment({ url: 'file:///etc/passwd' })).resolves.toMatchObject({
      success: false,
      reason: 'unsupported-url',
    });
    expect(RNFS.downloadFile).not.toHaveBeenCalled();
  });

  test('reports progress for large downloads', async () => {
    const onProgress = jest.fn();
    (RNFS.downloadFile as jest.Mock).mockImplementationOnce((options: any) => {
      options.progress({ bytesWritten: 512, contentLength: 1024 });
      return { promise: Promise.resolve({ statusCode: 200 }) };
    });

    await downloadAttachment({ url: 'https://media.test/chatblobs/c/big.zip', onProgress });

    expect(onProgress).toHaveBeenCalledWith(0.5);
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });

  test('cancelling an in-flight download stops it, cleans up the partial file, and reports cancelled', async () => {
    let rejectJob: (error: unknown) => void = () => {};
    (RNFS.downloadFile as jest.Mock).mockReturnValueOnce({
      jobId: 42,
      promise: new Promise((_resolve, reject) => {
        rejectJob = reject;
      }),
    });
    (RNFS.stopDownload as jest.Mock).mockImplementationOnce(() => {
      rejectJob(new Error('Download has been aborted'));
    });

    let abort: (() => void) | undefined;
    const resultPromise = downloadAttachment({
      url: 'https://media.test/chatblobs/c/big.zip',
      name: 'big.zip',
      onAbortHandle: fn => {
        abort = fn;
      },
    });

    // Let the download actually start (the cache is consulted first) before
    // cancelling, so this exercises a mid-flight abort rather than a
    // never-started one.
    await new Promise(resolve => setImmediate(resolve));
    abort?.();

    const result = await resultPromise;

    expect(result).toMatchObject({ success: false, reason: 'cancelled', message: 'Download cancelled' });
    expect(RNFS.stopDownload).toHaveBeenCalledWith(42);
    expect(RNFS.unlink).toHaveBeenCalledWith('/downloads/big.zip');
    // A cancel must not fall back and retry in another directory.
    expect(RNFS.downloadFile).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['unauthorized', 403],
    ['server-error', 503],
    ['network', undefined],
  ] as const)('retries a %s failure the same way as the first attempt', async (reason, statusCode) => {
    (RNFS.downloadFile as jest.Mock).mockReturnValue(
      statusCode
        ? { promise: Promise.resolve({ statusCode }) }
        : { promise: Promise.reject(new Error('Unable to resolve host')) },
    );

    const first = await downloadAttachment({ url: 'https://media.test/chatblobs/c/a.pdf' });
    expect(first).toMatchObject({ success: false, reason });

    (RNFS.downloadFile as jest.Mock).mockClear();
    (RNFS.downloadFile as jest.Mock).mockReturnValue({ promise: Promise.resolve({ statusCode: 200 }) });

    const retry = await downloadAttachment({ url: 'https://media.test/chatblobs/c/a.pdf' });
    expect(retry).toMatchObject({ success: true });
  });

  test('does not offer a retry for unsupported-url or not-found failures', () => {
    expect(isAttachmentDownloadRetryable('unsupported-url')).toBe(false);
    expect(isAttachmentDownloadRetryable('not-found')).toBe(false);
    expect(isAttachmentDownloadRetryable('network')).toBe(true);
    expect(isAttachmentDownloadRetryable('unauthorized')).toBe(true);
    expect(isAttachmentDownloadRetryable('server-error')).toBe(true);
    expect(isAttachmentDownloadRetryable('storage')).toBe(true);
    expect(isAttachmentDownloadRetryable('cancelled')).toBe(true);
    expect(isAttachmentDownloadRetryable(undefined)).toBe(false);
  });
});
