import { NativeModules } from 'react-native';
import { logInfo, logWarn } from './appLogger';
import {
  describeAttachmentDownloadResult,
  downloadAttachment,
  isAttachmentDownloadRetryable,
} from './attachmentDownload';
import { describeError } from './errors';
import type { AttachmentDownloadReason, AttachmentDownloadResult } from './attachmentDownload';

export type AttachmentOpenReason =
  | 'missing-path'
  | 'module-unavailable'
  | 'no-handler'
  | 'open-failed';

export type AttachmentOpenResult = {
  success: boolean;
  reason?: AttachmentOpenReason;
  message?: string;
  error?: unknown;
};

export type AttachmentOpenActionResult = {
  success?: boolean;
  reason?: AttachmentDownloadReason;
  message?: string;
  retryable?: boolean;
};

export type OpenableAttachmentMessage = {
  messageId?: string | null;
  deletedAt?: string | null;
  attachment?: {
    url?: string | null;
    name?: string | null;
    mimeType?: string | null;
  } | null;
};

type AttachmentOpenerModule = {
  open: (path: string, mimeType?: string | null, name?: string | null) => Promise<void>;
};

let _attachmentOpenerCache: AttachmentOpenerModule | null | undefined;

export function loadAttachmentOpener(): AttachmentOpenerModule | null {
  if (_attachmentOpenerCache !== undefined) return _attachmentOpenerCache;
  const module = NativeModules?.AttachmentOpener;
  _attachmentOpenerCache = module && typeof module.open === 'function' ? module : null;
  if (_attachmentOpenerCache) {
    logInfo('[Attachments] native opener module loaded');
  } else {
    logWarn('[Attachments] native opener module is not linked');
  }
  return _attachmentOpenerCache ?? null;
}

export function isAttachmentOpenerAvailable(): boolean {
  return Boolean(loadAttachmentOpener());
}

export function _resetAttachmentOpenerCache() {
  _attachmentOpenerCache = undefined;
}

export function describeAttachmentOpenResult(
  result: Pick<AttachmentOpenResult, 'success' | 'reason'> | null | undefined,
): string {
  if (result?.success) return 'Opening attachment';
  switch (result?.reason) {
    case 'missing-path':
      return 'Could not open this attachment because the file was not saved';
    case 'module-unavailable':
      return 'Opening attachments is not supported on this build';
    case 'no-handler':
      return 'No installed app can open this type of attachment';
    case 'open-failed':
    default:
      return 'Could not open this attachment';
  }
}

function classifyOpenFailure(error: unknown): AttachmentOpenReason {
  const code = (error as { code?: string })?.code;
  const message = describeError(error);
  if (code === 'NO_HANDLER' || /no.+handler|activity.+found|open-in.+menu/i.test(message)) {
    return 'no-handler';
  }
  if (code === 'MODULE_UNAVAILABLE') return 'module-unavailable';
  return 'open-failed';
}

export async function openDownloadedAttachment({
  path,
  mimeType,
  name,
}: {
  path?: string | null;
  mimeType?: string | null;
  name?: string | null;
}): Promise<AttachmentOpenResult> {
  if (!path) {
    const result: AttachmentOpenResult = { success: false, reason: 'missing-path' };
    return { ...result, message: describeAttachmentOpenResult(result) };
  }

  const opener = loadAttachmentOpener();
  if (!opener) {
    const result: AttachmentOpenResult = { success: false, reason: 'module-unavailable' };
    return { ...result, message: describeAttachmentOpenResult(result) };
  }

  try {
    await opener.open(path, mimeType ?? null, name ?? null);
    const result: AttachmentOpenResult = { success: true };
    return { ...result, message: describeAttachmentOpenResult(result) };
  } catch (error) {
    const reason = classifyOpenFailure(error);
    logWarn('[Attachments] native opener failed', { reason, error });
    const result: AttachmentOpenResult = { success: false, reason, error };
    return { ...result, message: describeAttachmentOpenResult(result) };
  }
}

export async function openChatAttachment({
  message,
  onProgress,
  onAbortHandle,
  isStillOpenable = () => true,
  download = downloadAttachment,
  open = openDownloadedAttachment,
}: {
  message: OpenableAttachmentMessage;
  onProgress?: (fraction: number) => void;
  onAbortHandle?: (abort: () => void) => void;
  isStillOpenable?: () => boolean;
  download?: typeof downloadAttachment;
  open?: typeof openDownloadedAttachment;
}): Promise<AttachmentOpenActionResult> {
  if (!isAttachmentOpenerAvailable()) {
    return {
      success: false,
      message: describeAttachmentOpenResult({ success: false, reason: 'module-unavailable' }),
      retryable: false,
    };
  }
  if (message.deletedAt || !isStillOpenable()) {
    return {
      success: false,
      reason: 'cancelled',
      message: describeAttachmentDownloadResult({ success: false, reason: 'cancelled' }),
      retryable: false,
    };
  }

  const result: AttachmentDownloadResult = await download({
    url: message.attachment?.url,
    name: message.attachment?.name,
    mimeType: message.attachment?.mimeType,
    messageId: message.messageId,
    onProgress,
    onAbortHandle,
  });
  if (!result.success) {
    return {
      ...result,
      message: describeAttachmentDownloadResult(result),
      retryable: isAttachmentDownloadRetryable(result.reason),
    };
  }
  if (!isStillOpenable()) {
    return {
      success: false,
      reason: 'cancelled',
      message: describeAttachmentDownloadResult({ success: false, reason: 'cancelled' }),
      retryable: false,
    };
  }

  const openResult = await open({
    path: result.path,
    mimeType: message.attachment?.mimeType,
    name: message.attachment?.name,
  });
  return openResult.success
    ? { success: true, message: openResult.message }
    : { success: false, message: openResult.message, retryable: false };
}
