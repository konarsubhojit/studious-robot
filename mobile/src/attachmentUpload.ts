import { logInfo, logWarn } from './appLogger';
import {
  API_ROUTES,
  isAllowedAttachmentMimeType,
  isAttachmentMessageType,
  maxAttachmentBytesFor,
} from '../../shared';

/**
 * Client half of the chat attachment pipeline: picker → presign → `PUT` to
 * R2 → `{ url, … }` ready to hand to `useMessaging.sendMessage`.
 *
 * The server enforces the MIME allowlist and size caps for real (both on
 * `POST /attachments/presign` and again on `message.send`), so the
 * client-side {@link validateAttachment} check here is a fast, friendly
 * rejection — never the control.
 *
 * `PUT`ting the binary uses `XMLHttpRequest` rather than `fetch`: it is the
 * only one of the two React Native ships with upload-progress events, which
 * the composer needs to render a progress bar.
 */

/**
 * Once a presign attempt is rejected with 503 (R2 not configured for this
 * deployment), every attempt in the same app session is doomed the same way.
 * Cached so the composer can disable/relabel the attach control after a
 * single failure instead of letting every subsequent pick dead-end the same
 * way (the failure must still be *visible*, just not repeated).
 */
let serverAttachmentsUnavailable = false;

/**
 * An attachment pipeline failure. Callers read `.status` (when the failure
 * came from an HTTP response) and `.message`, same as any other `Error`.
 */
export class AttachmentError extends Error {
  status?: number;
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AttachmentError';
    this.status = status;
  }
}

/** Reset the unavailability cache (tests only). */
export function _resetAttachmentAvailabilityCache() {
  serverAttachmentsUnavailable = false;
}

/** Whether a prior presign attempt already told us this server has no R2. */
export function isAttachmentUploadKnownUnavailable() {
  return serverAttachmentsUnavailable;
}

/**
 * Validate an attachment description against the shared allowlist/caps
 * before spending a round trip on it.
 *
 * @param {{ type?: unknown, mimeType?: unknown, sizeBytes?: unknown }} attachment
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateAttachment({ type, mimeType, sizeBytes }: { type?: unknown; mimeType?: unknown; sizeBytes?: unknown; } = {}): { ok: true; } | { ok: false; message: string; } {
  if (!isAttachmentMessageType(type)) {
    return { ok: false, message: 'Unsupported attachment type' };
  }
  const normalisedMime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (!isAllowedAttachmentMimeType((type as string), normalisedMime)) {
    return { ok: false, message: `File type ${normalisedMime || 'unknown'} isn't supported` };
  }
  const size = Number(sizeBytes);
  const cap = maxAttachmentBytesFor((type as string));
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, message: 'Could not determine the file size' };
  }
  if (size > cap) {
    return { ok: false, message: `That file is larger than the ${formatBytes(cap)} limit` };
  }
  return { ok: true };
}

/**
 * Human-readable size, e.g. `10 MB`.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Turn a failed presign/upload response into the message shown to the user.
 *
 * @param {{ status?: number, message?: string }} params
 * @returns {string}
 */
export function describeAttachmentError({ status, message }: { status?: number; message?: string; } = {}): string {
  if (status === 503) return "Attachments aren't available on this server";
  if (status === 413) return 'That file is too large to send';
  if (status === 429) return "You're sending too fast — try again in a moment";
  if (status === 403) return 'You cannot send attachments to this contact';
  if (status === 401) return 'Your session expired — try again';
  if (status && status >= 500) return 'The server could not process the upload — try again';
  if (status && status >= 400) return message || 'That attachment was rejected';
  return 'Network problem — check your connection and retry';
}

/**
 * `POST /attachments/presign` via the caller's authenticated fetch.
 *
 * @param {{
 *   authedFetch: (build: (sessionId: string) => { url: string, options?: object }) => Promise<Response|null>,
 *   signalingUrl: string,
 *   peerId: string,
 *   type: string,
 *   mimeType: string,
 *   sizeBytes: number,
 * }} params
 * @returns {Promise<{ conversationId: string, key: string, uploadUrl: string,
 *   publicUrl: string, expiresAt: string, headers: Record<string,string> }>}
 * @throws {AttachmentError}
 */
export async function presignAttachment({
  authedFetch,
  signalingUrl,
  peerId,
  type,
  mimeType,
  sizeBytes,
}: {
        authedFetch: (build: (sessionId: string) => { url: string; options?: object; }) => Promise<Response | null>;
        signalingUrl: string;
        peerId: string;
        type: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<{
    conversationId: string; key: string; uploadUrl: string;
    publicUrl: string; expiresAt: string; headers: Record<string, string>;
}> {
  const trimmedUrl = (signalingUrl ?? '').trim();
  const response = await authedFetch(sessionId => ({
    url: `${trimmedUrl}${API_ROUTES.ATTACHMENTS_PRESIGN}`,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, peerId, type, mimeType, sizeBytes }),
    },
  }));

  if (!response) {
    throw new AttachmentError('Could not reach the server');
  }

  if (!response.ok) {
    if (response.status === 503) serverAttachmentsUnavailable = true;
    const body = await response.json().catch(() => ({}));
    throw new AttachmentError(body?.error, response.status);
  }

  serverAttachmentsUnavailable = false;
  return response.json();
}

/**
 * `PUT` `body` (a `{ uri }` blob descriptor, or anything `fetch`/XHR accepts
 * as a body) to `uploadUrl`, replaying `headers` verbatim.
 *
 * `Content-Type` and `Content-Length` are part of the R2 signature — sending
 * anything other than exactly what the presign response specified yields
 * `SignatureDoesNotMatch`, so this never adds, drops, or normalises a header
 * of its own.
 *
 * @param {{
 *   uploadUrl: string,
 *   headers: Record<string, string>,
 *   body: Blob | { uri: string, type?: string, name?: string },
 *   onProgress?: (fraction: number) => void,
 * }} params
 * @returns {Promise<void>}
 */
export function putAttachment({ uploadUrl, headers, body, onProgress }: {
        uploadUrl: string;
        headers: Record<string, string>;
        body: Blob | { uri: string; type?: string; name?: string; };
        onProgress?: (fraction: number) => void;
    }): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    Object.entries(headers ?? {}).forEach(([name, value]) => {
      xhr.setRequestHeader(name, value);
    });

    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
        return;
      }
      reject(new AttachmentError('Upload was rejected by storage', xhr.status));
    };
    xhr.onerror = () => reject(new AttachmentError('Network problem during upload'));
    xhr.onabort = () => reject(new AttachmentError('Upload cancelled'));
    xhr.send(body);
  });
}

/**
 * Full send-side attachment pipeline: validate → presign → `PUT` → the
 * attachment fields `useMessaging.sendMessage` expects.
 *
 * @param {{
 *   authedFetch: (build: (sessionId: string) => { url: string, options?: object }) => Promise<Response|null>,
 *   signalingUrl: string,
 *   peerId: string,
 *   type: string,
 *   uri: string,
 *   mimeType: string,
 *   sizeBytes: number,
 *   name?: string,
 *   width?: number,
 *   height?: number,
 *   durationMs?: number,
 *   onProgress?: (fraction: number) => void,
 * }} params
 * @returns {Promise<{ url: string, mimeType: string, sizeBytes: number,
 *   name?: string, width?: number, height?: number, durationMs?: number }>}
 * @throws {AttachmentError} `message` is already the user-facing text
 *   ({@link describeAttachmentError}).
 */
export async function uploadAttachment({
  authedFetch,
  signalingUrl,
  peerId,
  type,
  uri,
  mimeType,
  sizeBytes,
  name,
  width,
  height,
  durationMs,
  onProgress,
}: {
        authedFetch: (build: (sessionId: string) => { url: string; options?: object; }) => Promise<Response | null>;
        signalingUrl: string;
        peerId: string;
        type: string;
        uri: string;
        mimeType: string;
        sizeBytes: number;
        name?: string;
        width?: number;
        height?: number;
        durationMs?: number;
        onProgress?: (fraction: number) => void;
    }): Promise<{
    url: string; mimeType: string; sizeBytes: number;
    name?: string; width?: number; height?: number; durationMs?: number;
}> {
  const validation = validateAttachment({ type, mimeType, sizeBytes });
  if (!validation.ok) {
    throw new AttachmentError(validation.message);
  }

  let presigned;
  try {
    presigned = await presignAttachment({
      authedFetch,
      signalingUrl,
      peerId,
      type,
      mimeType,
      sizeBytes,
    });
  } catch (error) {
    const failure = ((error ?? {}) as { status?: number, message?: string });
    logWarn('[Attachments] presign failed', {
      status: failure.status,
      message: failure.message,
    });
    throw new AttachmentError(describeAttachmentError(failure), failure.status);
  }

  try {
    await putAttachment({
      uploadUrl: presigned.uploadUrl,
      headers: presigned.headers,
      body: { uri, type: mimeType, name },
      onProgress,
    });
  } catch (error) {
    const failure = ((error ?? {}) as { status?: number, message?: string });
    logWarn('[Attachments] upload failed', {
      status: failure.status,
      message: failure.message,
    });
    throw new AttachmentError(describeAttachmentError(failure), failure.status);
  }

  logInfo('[Attachments] uploaded', { type, sizeBytes });
  return {
    url: presigned.publicUrl,
    mimeType,
    sizeBytes,
    ...(name ? { name } : {}),
    ...(Number.isFinite(width) ? { width } : {}),
    ...(Number.isFinite(height) ? { height } : {}),
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
  };
}
