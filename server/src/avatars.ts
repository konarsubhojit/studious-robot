/**
 * Avatar objects, backed by the same private Cloudflare R2 bucket as chat
 * attachments — and by a deliberately different authorisation model.
 *
 * `attachments.ts` authorises a download by *recomputing the object's expected
 * conversation scope from the caller's own identity*: a key is fetchable only
 * by the two people whose conversation minted it. An avatar has no
 * conversation. It is one object per person, shown to everyone who can see
 * that person in the directory — a materially wider audience than a 1:1
 * thread — so that rule cannot express it, and bending it (a "conversation"
 * with yourself, a shared pseudo-scope) would quietly widen chat media too.
 *
 * Avatars therefore live under their own key prefix (`avatars/<owner>/<uuid>`)
 * with their own rule, enforced in `routes/avatar.routes.ts`: the caller must
 * be able to see the owner in the directory, which is the block-aware
 * predicate `GET /users` already uses. Keeping the namespaces apart is what
 * makes the two rules non-interchangeable — a chat key can never be authorised
 * by directory visibility, and an avatar key can never be authorised by a
 * conversation scope, because each rule only ever resolves keys under its own
 * prefix.
 *
 * What does *not* change is the bucket: it stays private, with no custom
 * domain and no `r2.dev` binding (see `deploy/README.md`). Every read is a
 * short-lived presigned `GET` minted per authorised request, because the UUID
 * in a key is not a security boundary — avatar keys travel through directory
 * responses to every viewer, which makes that doubly true here.
 *
 * Two properties the owner segment must have, and why it is percent-encoded:
 * a username is a free-form string, so it could otherwise contain `/` (which
 * would forge extra key segments) or `..` (which a normalising proxy could use
 * to escape the prefix). Encoding makes the mapping injective, so
 * {@link avatarKeyOwner} recovers exactly the username that minted the key and
 * two different users can never produce the same owner segment.
 */

import crypto from 'crypto';
import {
  AVATAR_PATH_PREFIX,
  MAX_AVATAR_BYTES,
  isAllowedAvatarMimeType,
} from '../../shared/index.ts';
import { IMMUTABLE_CACHE_CONTROL, presignObjectRequest } from './attachments.ts';
import type { R2Config } from './attachments.ts';

/** File extension per accepted avatar MIME type; cosmetic, like chat media. */
const EXTENSION_BY_AVATAR_MIME_TYPE: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

/** Object names this module mints: a v4 UUID and an allowlisted extension. */
const AVATAR_OBJECT_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;

/**
 * How long a presigned avatar `GET` stays valid, in seconds.
 *
 * Longer than an attachment download (15 minutes) because of how often an
 * avatar is needed: a chat list renders dozens at once, and a link minted per
 * render would turn scrolling into a presigning storm. An hour lets a client
 * hold one link per contact for a session while it caches the *bytes* under
 * the stable `avatarKey` — caching the URL instead would break the moment it
 * expired.
 *
 * It is a deliberate trade, not an oversight: a leaked avatar link exposes a
 * profile picture its owner publishes to everyone in their directory, which is
 * a far smaller loss than a leaked link to a private conversation's media.
 */
const AVATAR_DOWNLOAD_TTL_SECONDS = 3600;

/**
 * Validate an avatar upload request against the allowlist and the size cap.
 *
 * Unlike chat attachments — whose bytes the server never sees in the clear —
 * an avatar is stored unencrypted and served to every viewer, so the MIME
 * allowlist here describes what viewers' decoders will really be handed. It is
 * signed onto the upload (see {@link presignAvatarUpload}), so object storage
 * rejects an upload that declares one type and sends another.
 */
function validateAvatarRequest({ mimeType, sizeBytes }: { mimeType?: unknown; sizeBytes?: unknown; } = {}):
  { mimeType: string; sizeBytes: number; } | { error: string; } {
  const normalisedMime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (!isAllowedAvatarMimeType(normalisedMime)) {
    return { error: `mimeType ${normalisedMime || '(missing)'} is not allowed for an avatar` };
  }
  const size = Number(sizeBytes);
  if (!Number.isInteger(size) || size <= 0) {
    return { error: 'sizeBytes must be a positive integer' };
  }
  if (size > MAX_AVATAR_BYTES) {
    return { error: `sizeBytes must be at most ${MAX_AVATAR_BYTES} for an avatar` };
  }
  return { mimeType: normalisedMime, sizeBytes: size };
}

/**
 * Build the object key for a new avatar: `avatars/<owner>/<uuid>.<ext>`.
 *
 * Server-generated, never client-supplied, so a caller cannot overwrite
 * somebody else's object or escape the prefix. A fresh UUID per upload also
 * means an avatar is never rewritten in place: a replacement is a new object
 * (and the old one is deleted), so viewers' caches cannot show a stale face.
 */
function createAvatarKey({ userId, mimeType }: { userId: string; mimeType: string; }): string {
  const extension = EXTENSION_BY_AVATAR_MIME_TYPE[mimeType] ?? 'bin';
  return `${AVATAR_PATH_PREFIX}/${encodeURIComponent(userId)}/${crypto.randomUUID()}.${extension}`;
}

/**
 * Recover the user a well-formed avatar key belongs to.
 *
 * This is the whole of the key's shape check: the prefix, exactly three
 * segments, an object name this module could have minted, and an owner segment
 * that decodes back to a username. Anything else — a chat key, a URL, a
 * traversal attempt, a key with an extra segment — yields `null`, and callers
 * treat `null` as "not an avatar this deployment stored".
 *
 * @returns the owner's userId, or `null` when `key` is not an avatar key.
 */
function avatarKeyOwner(key: unknown): string | null {
  if (typeof key !== 'string') return null;
  const segments = key.trim().split('/');
  if (segments.length !== 3) return null;
  const [prefix, owner, objectName] = segments;
  if (prefix !== AVATAR_PATH_PREFIX) return null;
  if (!AVATAR_OBJECT_NAME_PATTERN.test(objectName)) return null;
  if (!owner) return null;
  try {
    const decoded = decodeURIComponent(owner);
    // The encoding is injective only if it round-trips: a key carrying an
    // alternative encoding of the same name must not pass as that name.
    return decoded && encodeURIComponent(decoded) === owner ? decoded : null;
  } catch {
    // A malformed percent-escape: not a key this module minted.
    return null;
  }
}

/**
 * Whether `key` is an avatar key owned by `userId`.
 */
function isAvatarKeyOwnedBy(key: unknown, userId: string): boolean {
  return Boolean(userId) && avatarKeyOwner(key) === userId;
}

/**
 * Presign an upload of exactly `sizeBytes` bytes of `mimeType` to `key`.
 *
 * `cache-control`, `content-length` and `content-type` are signed headers, so
 * the size cap and the image allowlist are enforced by object storage itself,
 * not merely by this server or by a cooperating client.
 */
function presignAvatarUpload({ config, key, mimeType, sizeBytes, now = new Date() }: {
  config: R2Config | null; key: string; mimeType: string; sizeBytes: number; now?: Date;
}): { key: string; uploadUrl: string; expiresAt: string; headers: Record<string, string>; } {
  if (!config) throw new Error('presignAvatarUpload: R2 is not configured');

  const signed = presignObjectRequest({
    config,
    method: 'PUT',
    key,
    signedHeaderValues: {
      'cache-control': IMMUTABLE_CACHE_CONTROL,
      'content-length': String(sizeBytes),
      'content-type': mimeType,
    },
    now,
  });

  return {
    key,
    uploadUrl: signed.url,
    expiresAt: signed.expiresAt,
    // The client must replay these verbatim, or R2 rejects the signature.
    headers: {
      'Cache-Control': IMMUTABLE_CACHE_CONTROL,
      'Content-Type': mimeType,
      'Content-Length': String(sizeBytes),
    },
  };
}

/**
 * Presign a download (`GET`) of an existing avatar object.
 *
 * The caller is responsible for the authorisation decision — this only mints
 * the link once that decision has been made.
 */
function presignAvatarDownload({ config, key, now = new Date() }: {
  config: R2Config | null; key: string; now?: Date;
}): { downloadUrl: string; expiresAt: string; } {
  if (!config) throw new Error('presignAvatarDownload: R2 is not configured');
  const signed = presignObjectRequest({
    config: { ...config, ttlSeconds: AVATAR_DOWNLOAD_TTL_SECONDS },
    method: 'GET',
    key,
    now,
  });
  return { downloadUrl: signed.url, expiresAt: signed.expiresAt };
}

/**
 * Delete an avatar object with a signed `DELETE`.
 *
 * Called whenever an avatar stops being the current one — replaced, removed,
 * or erased with its account. The bucket carries no lifecycle rule (see
 * `deploy/README.md` §13a), so an object nobody deletes here is an object that
 * lives forever.
 *
 * @returns `true` when the object is gone (including when it never existed),
 *   `false` when storage is unconfigured or `key` is not an avatar key.
 */
async function deleteAvatarObject({ config, key, fetchImpl = fetch, now = new Date() }: {
  config: R2Config | null; key: unknown; fetchImpl?: typeof fetch; now?: Date;
}): Promise<boolean> {
  if (!config || !avatarKeyOwner(key)) return false;

  const signed = presignObjectRequest({ config, method: 'DELETE', key: (key as string).trim(), now });
  const response = await fetchImpl(signed.url, { method: 'DELETE' });
  // S3/R2 answer an absent key with 204, so retrying a partial cleanup is not
  // an error; 404 is tolerated for stand-ins that report it instead.
  return response.ok || response.status === 404;
}

export {
  AVATAR_DOWNLOAD_TTL_SECONDS,
  avatarKeyOwner,
  createAvatarKey,
  deleteAvatarObject,
  isAvatarKeyOwnedBy,
  presignAvatarDownload,
  presignAvatarUpload,
  validateAvatarRequest,
};
