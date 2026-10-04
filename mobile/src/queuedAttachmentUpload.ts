import RNFS from 'react-native-fs';
import { API_ROUTES } from '../../shared';
import { bearerAuthHeaders } from './authHeaders';
import { AttachmentError, ATTACHMENT_CANCELLED_MESSAGE, putAttachment } from './attachmentUpload';
import type { OutboxItem } from './messaging/types';

type AuthedFetch = (build: (sessionId: string) => { url: string; options?: object }) => Promise<Response | null>;
type Upload = NonNullable<OutboxItem['upload']>;
type UploadResponse = {
  key: string; reference: string; completed?: boolean;
  uploadUrl: string; expiresAt: string; headers: Record<string, string>;
  uploadId?: string; partSize?: number; parts?: Upload['parts'];
  cleanupAfter?: number;
  cleanupComplete?: boolean;
  retryAfterMs?: number;
};

function assertUploadIdentity(messageId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(messageId)) throw new AttachmentError('Invalid attachment identity');
}

export async function queuedUploadRequest(authedFetch: AuthedFetch, signalingUrl: string, item: OutboxItem, action: string, extra: object = {}, isCurrent: () => boolean = () => true): Promise<UploadResponse> {
  const response = await authedFetch(sessionId => {
    // Session creation/401 refresh can await through an account switch. Check
    // inside the builder as well as the worker before using those credentials.
    if (!isCurrent()) throw new AttachmentError(ATTACHMENT_CANCELLED_MESSAGE);
    return {
      url: `${signalingUrl.trim()}${API_ROUTES.ATTACHMENTS_UPLOAD}`,
      options: {
        method: 'POST', headers: bearerAuthHeaders(sessionId, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          action, clientId: item.clientMessageId ?? item.messageId,
          ...(item.targetKind === 'group' ? { groupId: item.conversationId } : { peerId: item.recipientId }),
          type: item.type, mimeType: item.attachment?.mimeType, sizeBytes: item.attachment?.sizeBytes, ...extra,
        }),
      },
    };
  });
  if (!response) throw new AttachmentError('Could not reach the server');
  if (!response.ok) {
    const error = new AttachmentError('Could not process attachment upload', response.status);
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      const seconds = Number(body.retryAfter);
      Object.assign(error, { retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000 });
    }
    throw error;
  }
  return response.json();
}

/** Each PUT gets at most two renewals. Network errors retain the checkpoint. */
async function putWithRenewal(
  sign: () => Promise<UploadResponse>, body: Parameters<typeof putAttachment>[0]['body'],
  check: () => void, onProgress: (progress: number) => void, onAbortHandle: (abort: () => void) => void,
  initial?: UploadResponse,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    check();
    const signed = attempt === 0 && initial ? initial : await sign();
    check();
    try {
      if (Date.parse(signed.expiresAt) <= Date.now()) throw new AttachmentError('Upload grant expired', 403);
      return await putAttachment({ uploadUrl: signed.uploadUrl, headers: signed.headers, body, onProgress, onAbortHandle });
    } catch (error) {
      check();
      if (!(error instanceof AttachmentError) || error.status !== 403 || attempt >= 2) throw error;
    }
  }
}

/** Resume from R2's authoritative part list, then checkpoint each completed part. */
export async function drainAttachmentUpload({
  item, authedFetch, signalingUrl, checkpoint, isCurrent, onProgress, onAbortHandle,
}: {
  item: OutboxItem; authedFetch: AuthedFetch; signalingUrl: string;
  checkpoint: (upload: Upload) => Promise<void>; isCurrent: () => boolean;
  onProgress: (fraction: number) => void; onAbortHandle: (abort: () => void) => void;
}): Promise<string> {
  const check = () => { if (!isCurrent()) throw new AttachmentError(ATTACHMENT_CANCELLED_MESSAGE); };
  check();
  assertUploadIdentity(item.messageId);
  let upload = item.upload!;
  if (upload.completed && upload.key) return upload.key;
  const request = (action: string, extra?: object) => queuedUploadRequest(authedFetch, signalingUrl, item, action, extra, isCurrent);
  const prepared = await request('prepare');
  check();
  upload = {
    ...upload, key: prepared.key, uploadId: prepared.uploadId, partSize: prepared.partSize,
    parts: prepared.parts ?? [], completed: Boolean(prepared.completed),
  };
  const total = Number(item.attachment?.sizeBytes);
  if (!Number.isInteger(total) || total <= 0) throw new AttachmentError('Invalid attachment size');
  upload.progress = prepared.completed ? 1 : upload.parts.reduce((bytes, part) => bytes + part.sizeBytes, 0) / total;
  await checkpoint(upload);
  check();
  onProgress(upload.progress);
  if (prepared.completed) return prepared.reference;
  if (!prepared.uploadId) {
    await putWithRenewal(() => request('prepare'), {
      uri: upload.uri, type: item.attachment!.mimeType, name: item.attachment!.name ?? undefined,
    }, check, onProgress, onAbortHandle, prepared);
    check();
  } else {
    const partSize = prepared.partSize!;
    const count = Math.ceil(total / partSize);
    const attemptId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (let partNumber = 1; partNumber <= count; partNumber++) {
      if (upload.parts.some(part => part.partNumber === partNumber)) continue;
      check();
      const offset = (partNumber - 1) * partSize;
      const sizeBytes = Math.min(partSize, total - offset);
      // RN Blob cannot be built from ArrayBuffers. Materialize only this 5MiB
      // slice, not the entire attachment, and let native XHR stream its URI.
      const path = `${RNFS.CachesDirectoryPath}/wetalk-part-${item.messageId}-${partNumber}-${attemptId}`;
      try {
        const bytes = await RNFS.read(upload.uri.replace(/^file:\/\//, ''), sizeBytes, offset, 'base64');
        check();
        await RNFS.writeFile(path, bytes, 'base64');
        check();
        const completedBytes = upload.parts.reduce((sum, part) => sum + part.sizeBytes, 0);
        const etag = await putWithRenewal(
          () => request('part', { uploadId: prepared.uploadId, partNumber }),
          { uri: `file://${path}`, type: item.attachment!.mimeType, name: item.attachment!.name ?? undefined },
          check, fraction => onProgress((completedBytes + fraction * sizeBytes) / total), onAbortHandle,
        );
        check();
        if (!etag) throw new AttachmentError('Storage did not return a part ETag');
        upload = {
          ...upload, parts: [...upload.parts, { partNumber, etag, sizeBytes }],
          progress: (completedBytes + sizeBytes) / total,
        };
        await checkpoint(upload);
      } finally {
        await RNFS.unlink(path).catch(() => {});
      }
    }
    check();
    await request('complete', { uploadId: prepared.uploadId });
    check();
  }
  await checkpoint({ ...upload, completed: true, progress: 1 });
  check();
  return prepared.reference;
}

/** Picker/cache URIs are ephemeral; queue only a copy in app-owned storage. */
export async function retainQueuedAttachment(uri: string, messageId: string): Promise<string> {
  assertUploadIdentity(messageId);
  if (!/^(file:|content:|\/)/.test(uri)) throw new AttachmentError('Attachment must be a local file');
  const path = `${RNFS.DocumentDirectoryPath}/wetalk-upload-${messageId}`;
  if (uri === `file://${path}`) return uri;
  await RNFS.copyFile(uri.replace(/^file:\/\//, ''), path);
  return `file://${path}`;
}

export async function releaseQueuedAttachment(uri: string): Promise<void> {
  const prefix = `file://${RNFS.DocumentDirectoryPath}/wetalk-upload-`;
  const identity = uri.slice(prefix.length);
  if (uri.startsWith(prefix) && /^[a-zA-Z0-9_-]{1,128}$/.test(identity)) {
    const unlink = async (path: string) => {
      try {
        await RNFS.unlink(path);
      } catch (error) {
        // A prior cleanup can succeed before the outbox removal commits.
        if (await RNFS.exists(path)) throw error;
      }
    };
    await unlink(uri.slice('file://'.length));
    // A process death bypasses finally. Remove only this upload's app-owned
    // slices when it is acknowledged or its durable cleanup completes.
    const entries = await RNFS.readDir(RNFS.CachesDirectoryPath);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith(`wetalk-part-${identity}-`)) {
        await unlink(entry.path);
      }
    }
  }
}
