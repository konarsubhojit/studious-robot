import ImageResizer from '@bam.tech/react-native-image-resizer';
import { API_ROUTES, MAX_AVATAR_BYTES } from '../../shared';
import { pickPhoto } from './attachmentPicker';
import { putAttachment } from './attachmentUpload';
import { bearerAuthHeaders } from './authHeaders';
import { ensureAttachmentPermission } from './permissions';

type AuthedFetch = (build: (sessionId: string) => {
  url: string;
  options?: object;
}) => Promise<Response | null>;

async function responseError(response: Response | null, fallback: string): Promise<Error> {
  if (!response) return new Error('Could not reach the server');
  const body = await response.json().catch(() => ({}));
  return new Error(typeof body?.error === 'string' ? body.error : fallback);
}

/** Pick, square-crop, downscale, upload, and publish the signed-in user's avatar. */
export async function uploadAvatar({
  authedFetch,
  signalingUrl,
}: {
  authedFetch: AuthedFetch;
  signalingUrl: string;
}): Promise<string | null> {
  const permission = await ensureAttachmentPermission('photo');
  if (!permission.ok) throw new Error(permission.message || 'Photo permission is required');
  const picked = await pickPhoto({ maxWidth: 1024, maxHeight: 1024 });
  if (!picked) return null;

  const resized = await ImageResizer.createResizedImage(
    picked.uri,
    512,
    512,
    'JPEG',
    82,
    0,
    undefined,
    false,
    { mode: 'cover', onlyScaleDown: true },
  );
  if (!Number.isFinite(resized.size) || resized.size <= 0 || resized.size > MAX_AVATAR_BYTES) {
    throw new Error('The resized photo is too large to use as an avatar');
  }

  const server = signalingUrl.trim().replace(/\/+$/, '');
  if (!server) throw new Error('The signaling server is not configured');
  const mimeType = 'image/jpeg';
  const presignResponse = await authedFetch(sessionId => ({
    url: `${server}${API_ROUTES.AVATAR_PRESIGN}`,
    options: {
      method: 'POST',
      headers: bearerAuthHeaders(sessionId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ mimeType, sizeBytes: resized.size }),
    },
  }));
  if (!presignResponse?.ok) {
    throw await responseError(presignResponse, 'Could not prepare the avatar upload');
  }
  const presigned = await presignResponse.json();
  if (
    typeof presigned?.key !== 'string' ||
    typeof presigned?.uploadUrl !== 'string' ||
    !presigned?.headers ||
    typeof presigned.headers !== 'object'
  ) {
    throw new Error('The server returned an invalid avatar upload request');
  }

  await putAttachment({
    uploadUrl: presigned.uploadUrl,
    headers: presigned.headers,
    body: { uri: resized.uri, type: mimeType, name: resized.name },
  });

  const publishResponse = await authedFetch(sessionId => ({
    url: `${server}${API_ROUTES.AVATAR}`,
    options: {
      method: 'PUT',
      headers: bearerAuthHeaders(sessionId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ key: presigned.key }),
    },
  }));
  if (!publishResponse?.ok) {
    throw await responseError(publishResponse, 'Could not update the profile photo');
  }
  const published = await publishResponse.json();
  if (published?.avatarKey !== presigned.key) {
    throw new Error('The server did not confirm the profile photo update');
  }
  return published.avatarKey;
}
