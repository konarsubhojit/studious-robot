import { NativeModules } from 'react-native';
import {
  _resetAttachmentOpenerCache,
  describeAttachmentOpenResult,
  isAttachmentOpenerAvailable,
  openChatAttachment,
  openDownloadedAttachment,
} from '../src/attachmentOpen';
import { downloadAttachment } from '../src/attachmentDownload';

jest.mock('../src/appLogger', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('react-native', () => ({
  NativeModules: {},
}));

jest.mock('../src/attachmentDownload', () => ({
  describeAttachmentDownloadResult: jest.requireActual('../src/attachmentDownload')
    .describeAttachmentDownloadResult,
  isAttachmentDownloadRetryable: jest.requireActual('../src/attachmentDownload')
    .isAttachmentDownloadRetryable,
  downloadAttachment: jest.fn(),
}));

const mockDownloadAttachment = downloadAttachment as jest.Mock;

const message = {
  messageId: 'file-1',
  attachment: {
    url: 'https://media.test/chatblobs/c/report.pdf',
    name: 'report.pdf',
    mimeType: 'application/pdf',
  },
};

beforeEach(() => {
  _resetAttachmentOpenerCache();
  NativeModules.AttachmentOpener = {
    open: jest.fn().mockResolvedValue(undefined),
  };
  mockDownloadAttachment.mockReset();
});

afterEach(() => {
  delete NativeModules.AttachmentOpener;
  jest.clearAllMocks();
});

describe('attachment opener availability', () => {
  test('degrades when the native module is not linked', async () => {
    delete NativeModules.AttachmentOpener;
    _resetAttachmentOpenerCache();

    expect(isAttachmentOpenerAvailable()).toBe(false);
    await expect(openChatAttachment({ message })).resolves.toMatchObject({
      success: false,
      retryable: false,
      message: 'Opening attachments is not supported on this build',
    });
    expect(mockDownloadAttachment).not.toHaveBeenCalled();
  });
});

describe('openChatAttachment', () => {
  test('opens a cached attachment path returned by downloadAttachment', async () => {
    mockDownloadAttachment.mockResolvedValue({
      success: true,
      path: '/cache/attachments/report.pdf',
      label: 'this device',
      fromCache: true,
    });

    await expect(openChatAttachment({ message })).resolves.toMatchObject({
      success: true,
      message: 'Opening attachment',
    });
    expect(mockDownloadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        url: message.attachment.url,
        messageId: message.messageId,
      }),
    );
    expect(NativeModules.AttachmentOpener.open).toHaveBeenCalledWith(
      '/cache/attachments/report.pdf',
      'application/pdf',
      'report.pdf',
    );
  });

  test('downloads a missing attachment once and opens the saved path', async () => {
    const onProgress = jest.fn();
    const onAbortHandle = jest.fn();
    mockDownloadAttachment.mockResolvedValue({
      success: true,
      path: '/documents/report.pdf',
      label: 'app documents',
    });

    await openChatAttachment({ message, onProgress, onAbortHandle });

    expect(mockDownloadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ onProgress, onAbortHandle }),
    );
    expect(NativeModules.AttachmentOpener.open).toHaveBeenCalledWith(
      '/documents/report.pdf',
      'application/pdf',
      'report.pdf',
    );
  });

  test('does not open after an in-flight open is cancelled', async () => {
    mockDownloadAttachment.mockResolvedValue({ success: false, reason: 'cancelled' });

    await expect(openChatAttachment({ message })).resolves.toMatchObject({
      success: false,
      reason: 'cancelled',
      retryable: true,
      message: 'Download cancelled',
    });
    expect(NativeModules.AttachmentOpener.open).not.toHaveBeenCalled();
  });

  test('reports no installed handler as a clear non-retryable failure', async () => {
    mockDownloadAttachment.mockResolvedValue({
      success: true,
      path: '/documents/report.unknown',
    });
    NativeModules.AttachmentOpener.open.mockRejectedValue(
      Object.assign(new Error('No activity found'), { code: 'NO_HANDLER' }),
    );

    await expect(openChatAttachment({ message })).resolves.toMatchObject({
      success: false,
      retryable: false,
      message: 'No installed app can open this type of attachment',
    });
  });

  test('does not open a cached file when a tombstone arrives before launch', async () => {
    mockDownloadAttachment.mockResolvedValue({
      success: true,
      path: '/documents/report.pdf',
      fromCache: true,
    });
    const isStillOpenable = jest.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);

    await expect(openChatAttachment({ message, isStillOpenable })).resolves.toMatchObject({
      success: false,
      reason: 'cancelled',
    });
    expect(NativeModules.AttachmentOpener.open).not.toHaveBeenCalled();
  });

  test('does not resolve bytes for an already tombstoned attachment', async () => {
    await expect(
      openChatAttachment({ message: { ...message, deletedAt: '2026-09-08T14:20:00.000Z' } }),
    ).resolves.toMatchObject({
      success: false,
      reason: 'cancelled',
    });
    expect(mockDownloadAttachment).not.toHaveBeenCalled();
    expect(NativeModules.AttachmentOpener.open).not.toHaveBeenCalled();
  });
});

describe('openDownloadedAttachment', () => {
  test('maps native no-handler errors to a user-facing message', async () => {
    NativeModules.AttachmentOpener.open.mockRejectedValue(
      Object.assign(new Error('Activity not found'), { code: 'NO_HANDLER' }),
    );

    await expect(openDownloadedAttachment({ path: '/documents/a.bin' })).resolves.toMatchObject({
      success: false,
      reason: 'no-handler',
      message: 'No installed app can open this type of attachment',
    });
  });

  test('describes unavailable builds', () => {
    expect(
      describeAttachmentOpenResult({ success: false, reason: 'module-unavailable' }),
    ).toBe('Opening attachments is not supported on this build');
  });
});
