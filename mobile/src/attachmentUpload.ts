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
 */
export function validateAttachment({ type, mimeType, sizeBytes }: { type?: unknown; mimeType?: unknown; sizeBytes?: unknown; } = {}): { ok: true; } | { ok: false; message: string; } {
  const normalisedMime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  const resolvedType = isAttachmentMessageType(type) ? type as string : '';
  const size = Number(sizeBytes);
  const cap = resolvedType ? maxAttachmentBytesFor(resolvedType) : 0;
  const reject = (message: string) => {
    logWarn('[Attachments] validation rejected', {
      rawMimeType: mimeType,
      mimeType: normalisedMime,
      type: resolvedType,
      sizeBytes,
      cap,
      message,
    });
    return { ok: false as const, message };
  };

  if (!isAttachmentMessageType(type)) {
    return reject('Unsupported attachment type');
  }
  if (!isAllowedAttachmentMimeType(resolvedType, normalisedMime)) {
    return reject(`File type ${normalisedMime || 'unknown'} isn't supported`);
  }
  if (!Number.isFinite(size) || size <= 0) {
    return reject('Could not determine the file size');
  }
  if (size > cap) {
    return reject(`That file is larger than the ${formatBytes(cap)} limit`);
  }
  logInfo('[Attachments] validation accepted', {
    rawMimeType: mimeType,
    mimeType: normalisedMime,
    type: resolvedType,
    sizeBytes: size,
    cap,
  });
  return { ok: true };
}

/**
 * Human-readable size, e.g. `10 MB`.
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * The message carried by the {@link AttachmentError} raised when an upload is
 * aborted by the user, rather than failing. Callers compare against this to
 * tell "cancelled" apart from "broken".
 */
export const ATTACHMENT_CANCELLED_MESSAGE = 'Upload cancelled';

/**
 * Turn a failed presign/upload response into the message shown to the user.
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
 * @param params
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
  logInfo('[Attachments] presign requested', { type, mimeType, sizeBytes });
  const response = await authedFetch(sessionId => ({
    url: `${trimmedUrl}${API_ROUTES.ATTACHMENTS_PRESIGN}`,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, peerId, type, mimeType, sizeBytes }),
    },
  }));

  if (!response) {
    logWarn('[Attachments] presign response missing', { type, mimeType, sizeBytes });
    throw new AttachmentError('Could not reach the server');
  }

  logInfo('[Attachments] presign response', { type, mimeType, sizeBytes, status: response.status });
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
 * @param params
 */
export function putAttachment({ uploadUrl, headers, body, onProgress, onAbortHandle }: {
        uploadUrl: string;
        headers: Record<string, string>;
        body: Blob | { uri: string; type?: string; name?: string; };
        onProgress?: (fraction: number) => void;
        onAbortHandle?: (abort: () => void) => void;
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
        logInfo('[Attachments] upload completed', { status: xhr.status });
        onProgress?.(1);
        resolve();
        return;
      }
      logWarn('[Attachments] upload rejected by storage', { status: xhr.status });
      reject(new AttachmentError('Upload was rejected by storage', xhr.status));
    };
    xhr.onerror = () => {
      logWarn('[Attachments] upload network failure');
      reject(new AttachmentError('Network problem during upload'));
    };
    xhr.onabort = () => {
      logInfo('[Attachments] upload cancelled');
      reject(new AttachmentError(ATTACHMENT_CANCELLED_MESSAGE));
    };
    onAbortHandle?.(() => xhr.abort());
    xhr.send(body);
  });
}

/**
 * Full send-side attachment pipeline: validate → presign → `PUT` → the
 * attachment fields `useMessaging.sendMessage` expects.
 *
 * @param params
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
  waveform,
  onProgress,
  onAbortHandle,
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
        waveform?: number[];
        onProgress?: (fraction: number) => void;
        onAbortHandle?: (abort: () => void) => void;
    }): Promise<{
    url: string; mimeType: string; sizeBytes: number;
    name?: string; width?: number; height?: number; durationMs?: number; waveform?: number[];
}> {
  const validation = validateAttachment({ type, mimeType, sizeBytes });
  if (!validation.ok) {
    throw new AttachmentError(validation.message);
  }
  const validatedMimeType = mimeType.trim().toLowerCase();

  let presigned;
  try {
    presigned = await presignAttachment({
      authedFetch,
      signalingUrl,
      peerId,
      type,
      mimeType: validatedMimeType,
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
      body: { uri, type: validatedMimeType, name },
      onProgress,
      onAbortHandle,
    });
  } catch (error) {
    const failure = ((error ?? {}) as { status?: number, message?: string });
    // A user-initiated abort is not a failure: keep its message intact rather
    // than letting describeAttachmentError report it as a network problem.
    if (failure.message === ATTACHMENT_CANCELLED_MESSAGE) {
      throw new AttachmentError(ATTACHMENT_CANCELLED_MESSAGE);
    }
    logWarn('[Attachments] upload failed', {
      status: failure.status,
      message: failure.message,
    });
    throw new AttachmentError(describeAttachmentError(failure), failure.status);
  }

  logInfo('[Attachments] uploaded', { type, mimeType: validatedMimeType, sizeBytes });
  return {
    url: presigned.publicUrl,
    mimeType: validatedMimeType,
    sizeBytes,
    ...(name ? { name } : {}),
    ...(Number.isFinite(width) ? { width } : {}),
    ...(Number.isFinite(height) ? { height } : {}),
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    ...(Array.isArray(waveform) && waveform.length ? { waveform } : {}),
  };
}
