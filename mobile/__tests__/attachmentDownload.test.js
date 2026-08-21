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
    RNFS.downloadFile.mockReturnValueOnce({ promise: Promise.resolve({ statusCode: 200 }) });

    const result = await downloadAttachment({
      url: 'https://media.test/chatblobs/c/file.pdf',
      name: '../secret?.pdf',
      mimeType: 'application/pdf',
    });

    expect(result).toMatchObject({ success: true, label: 'Downloads', path: '/downloads/_secret_.pdf' });
    expect(RNFS.downloadFile).toHaveBeenCalledWith({
      fromUrl: 'https://media.test/chatblobs/c/file.pdf',
      toFile: '/downloads/_secret_.pdf',
    });
  });

  test('falls back to app storage when the Downloads write fails', async () => {
    RNFS.downloadFile
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
});
