import { logInfo, logWarn } from './appLogger';
import { API_ROUTES } from '../../shared';

/**
 * Client half of `GET /attachments/download`.
 *
 * Object storage is not publicly readable, so the `url` a message carries
 * (whether minted by today's `POST /attachments/presign` or stored by a
 * message sent before this endpoint existed) is only ever an opaque
 * reference: viewing, downloading or "Open with"-ing an attachment first
 * exchanges it here for a short-lived, participant-authorized link, and the
 * exchange is re-done every time — a resolved link is never cached past the
 * one download/view it was minted for.
 */
export class AttachmentAccessError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AttachmentAccessError';
    this.status = status;
  }
}

/**
 * Exchange a stored attachment reference for a short-lived download URL.
 *
 * @throws {AttachmentAccessError}
 */
export async function resolveAttachmentDownloadUrl({
  authedFetch,
  signalingUrl,
  peerId,
  url,
}: {
  authedFetch: (build: (sessionId: string) => { url: string; options?: object; }) => Promise<Response | null>;
  signalingUrl: string;
  peerId: string;
  url: string;
}): Promise<string> {
  const trimmedUrl = (signalingUrl ?? '').trim();
  const query = new URLSearchParams({ peerId, url });

  const response = await authedFetch(sessionId => ({
    url: `${trimmedUrl}${API_ROUTES.ATTACHMENTS_DOWNLOAD}?${query.toString()}`,
    options: { headers: { authorization: 'Bearer ' + sessionId } },
  }));

  if (!response) {
    logWarn('[Attachments] download-authorization response missing');
    throw new AttachmentAccessError('Could not reach the server');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    logWarn('[Attachments] download-authorization refused', { status: response.status });
    throw new AttachmentAccessError(body?.error ?? 'Attachment access refused', response.status);
  }

  const body = await response.json().catch(() => ({}));
  if (typeof body?.downloadUrl !== 'string' || !body.downloadUrl) {
    throw new AttachmentAccessError('Server did not return a download link');
  }
  logInfo('[Attachments] download authorized');
  return body.downloadUrl;
}
