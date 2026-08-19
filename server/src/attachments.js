'use strict';

/**
 * Chat attachment uploads, backed by Cloudflare R2.
 *
 * Message bodies never carry binary data: the client asks for a short-lived
 * presigned `PUT` URL, uploads straight to object storage, and then sends a
 * `message.send` that references the resulting public URL.
 *
 * Everything is served from one shared prefix — `<public base>/chatblobs/…` —
 * because all chat media lives in the same bucket, so a deployment only has to
 * point one hostname (bucket domain or CDN) at it.
 *
 * The presigned URL is the *enforcement point*, not just a convenience:
 * `content-length` and `content-type` are part of the signature, so an upload
 * that exceeds the size cap or changes the MIME type is rejected by R2 itself
 * even if the client ignores the limits it was told about. The type/size/MIME
 * checks below run server-side on both `POST /attachments/presign` and
 * `message.send`.
 *
 * Signing is AWS SigV4 (R2's S3-compatible API) implemented with `crypto`, so
 * no SDK dependency is added for what is a few HMACs.
 */

const crypto = require('crypto');
const {
  ATTACHMENT_PATH_PREFIX,
  isAllowedAttachmentMimeType,
  isAttachmentMessageType,
  maxAttachmentBytesFor,
} = require('../../shared');

/** R2 has no regions; its S3 API expects the literal `auto`. */
const R2_REGION = 'auto';
const S3_SERVICE = 's3';
/** How long a presigned upload URL stays valid, in seconds. */
const DEFAULT_PRESIGN_TTL_SECONDS = 300;
/** Upper bound on the configurable TTL: a leaked URL should expire quickly. */
const MAX_PRESIGN_TTL_SECONDS = 3600;

/** File extension per accepted MIME type, purely cosmetic for the object key. */
const EXTENSION_BY_MIME_TYPE = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
});

/**
 * Read the R2 configuration from the environment.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ accountId: string, bucket: string, accessKeyId: string,
 *   secretAccessKey: string, endpoint: string, publicBaseUrl: string,
 *   ttlSeconds: number } | null} `null` when R2 is not configured, in which
 *   case attachment uploads are simply unavailable and the rest of chat is
 *   unaffected.
 */
function loadR2Config(env = process.env) {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucket = env.R2_BUCKET?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const publicBaseUrl = env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (!bucket || !accessKeyId || !secretAccessKey || !publicBaseUrl) return null;

  // The account-scoped endpoint is derivable from the account id; an explicit
  // `R2_ENDPOINT` (custom domain, or a MinIO/S3 stand-in in development) wins.
  const explicitEndpoint = env.R2_ENDPOINT?.trim().replace(/\/+$/, '');
  if (!explicitEndpoint && !accountId) return null;
  const endpoint = explicitEndpoint || `https://${accountId}.r2.cloudflarestorage.com`;

  const requestedTtl = Number(env.R2_PRESIGN_TTL_SECONDS);
  const ttlSeconds =
    Number.isFinite(requestedTtl) && requestedTtl > 0
      ? Math.min(Math.floor(requestedTtl), MAX_PRESIGN_TTL_SECONDS)
      : DEFAULT_PRESIGN_TTL_SECONDS;

  return { accountId: accountId ?? '', bucket, accessKeyId, secretAccessKey, endpoint, publicBaseUrl, ttlSeconds };
}

/**
 * Validate an attachment description against the shared allowlist and caps.
 *
 * @param {{ type?: unknown, mimeType?: unknown, sizeBytes?: unknown }} request
 * @returns {{ type: string, mimeType: string, sizeBytes: number } | { error: string }}
 */
function validateAttachmentRequest({ type, mimeType, sizeBytes } = {}) {
  if (!isAttachmentMessageType(type)) {
    return { error: 'type must be one of image, file, voice' };
  }
  const normalisedMime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (!isAllowedAttachmentMimeType(/** @type {string} */ (type), normalisedMime)) {
    return { error: `mimeType ${normalisedMime || '(missing)'} is not allowed for ${type}` };
  }
  const size = Number(sizeBytes);
  if (!Number.isInteger(size) || size <= 0) {
    return { error: 'sizeBytes must be a positive integer' };
  }
  const cap = maxAttachmentBytesFor(/** @type {string} */ (type));
  if (size > cap) {
    return { error: `sizeBytes must be at most ${cap} for ${type}` };
  }
  return { type: /** @type {string} */ (type), mimeType: normalisedMime, sizeBytes: size };
}

/**
 * Build the object key for a new attachment.
 *
 * The key is server-generated — never client-supplied — so a caller cannot
 * overwrite somebody else's object or escape the shared prefix. It is
 * namespaced by conversation so lifecycle rules (and manual cleanup) can work
 * per conversation.
 *
 * @param {{ conversationId: string, mimeType: string }} params
 * @returns {string}
 */
function createAttachmentKey({ conversationId, mimeType }) {
  const extension = EXTENSION_BY_MIME_TYPE[mimeType] ?? 'bin';
  // The conversation id is derived from two user ids, which are already
  // restricted to safe characters, but encode it anyway: the key ends up in a
  // URL path.
  const scope = encodeURIComponent(conversationId);
  return `${ATTACHMENT_PATH_PREFIX}/${scope}/${crypto.randomUUID()}.${extension}`;
}

/** HMAC-SHA256 returning a Buffer. */
function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
}

/** Lowercase hex SHA-256 of a string. */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Percent-encode one path segment the way SigV4 canonicalisation requires
 * (`encodeURIComponent` leaves `!'()*` alone, which S3 does not).
 *
 * @param {string} segment
 * @returns {string}
 */
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Presign an upload of exactly `sizeBytes` bytes of `mimeType` to `key`.
 *
 * `content-length` and `content-type` are signed headers, so the client must
 * send both and they must match: the size cap and MIME allowlist are therefore
 * enforced by object storage, not only by this server or the client.
 *
 * @param {{ config: ReturnType<typeof loadR2Config>, key: string, mimeType: string,
 *   sizeBytes: number, now?: Date }} params
 * @returns {{ uploadUrl: string, publicUrl: string, expiresAt: string,
 *   headers: Record<string, string>, key: string }}
 */
function presignAttachmentUpload({ config, key, mimeType, sizeBytes, now = new Date() }) {
  if (!config) throw new Error('presignAttachmentUpload: R2 is not configured');

  const endpoint = new URL(config.endpoint);
  const canonicalUri = `/${[config.bucket, ...key.split('/')].map(encodeSegment).join('/')}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${R2_REGION}/${S3_SERVICE}/aws4_request`;

  // Signed headers must be sorted by lowercase name.
  const signedHeaders = 'content-length;content-type;host';
  const canonicalHeaders =
    `content-length:${sizeBytes}\n` + `content-type:${mimeType}\n` + `host:${endpoint.host}\n`;

  const query = new URLSearchParams();
  query.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  query.set('X-Amz-Credential', `${config.accessKeyId}/${scope}`);
  query.set('X-Amz-Date', amzDate);
  query.set('X-Amz-Expires', String(config.ttlSeconds));
  query.set('X-Amz-SignedHeaders', signedHeaders);
  // `URLSearchParams` serialises in insertion order; SigV4 needs the canonical
  // query string sorted by key.
  const canonicalQuery = [...query.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${encodeSegment(name)}=${encodeSegment(value)}`)
    .join('&');

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), R2_REGION), S3_SERVICE),
    'aws4_request'
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    key,
    uploadUrl: `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    publicUrl: `${config.publicBaseUrl}/${key.split('/').map(encodeSegment).join('/')}`,
    expiresAt: new Date(now.getTime() + config.ttlSeconds * 1000).toISOString(),
    // The client must replay these verbatim, or R2 rejects the signature.
    headers: { 'Content-Type': mimeType, 'Content-Length': String(sizeBytes) },
  };
}

/**
 * Whether `url` points at this deployment's chat-blob prefix.
 *
 * A message may only reference media this server handed out a presigned URL
 * for: an arbitrary URL would turn every chat bubble into a request to a host
 * of the sender's choosing (an IP-leak / tracking vector for the recipient).
 *
 * @param {ReturnType<typeof loadR2Config>} config
 * @param {unknown} url
 * @returns {boolean}
 */
function isManagedAttachmentUrl(config, url) {
  if (!config || typeof url !== 'string') return false;
  if (!url.startsWith(`${config.publicBaseUrl}/${ATTACHMENT_PATH_PREFIX}/`)) return false;
  // `startsWith` alone would accept a URL that escapes the prefix again once a
  // proxy normalises it (`…/chatblobs/../elsewhere`).
  return !url.includes('..');
}

module.exports = {
  DEFAULT_PRESIGN_TTL_SECONDS,
  MAX_PRESIGN_TTL_SECONDS,
  createAttachmentKey,
  isManagedAttachmentUrl,
  loadR2Config,
  presignAttachmentUpload,
  validateAttachmentRequest,
};
