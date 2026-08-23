jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

jest.mock('react-native-fs', () => ({
  DownloadDirectoryPath: '/downloads',
  ExternalDirectoryPath: '/external',
  DocumentDirectoryPath: '/docs',
  downloadFile: jest.fn(),
}));

import RNFS from 'react-native-fs';
import {
  attachmentDownloadFileName,
  describeAttachmentDownloadResult,
  downloadAttachment,
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
    expect(result.message).toMatch(/403/);
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
});
