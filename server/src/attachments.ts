/**
 * Chat attachment uploads, backed by Cloudflare R2.
 *
 * Message bodies never carry binary data: the client asks for a short-lived
 * presigned `PUT` URL, uploads straight to object storage, and then sends a
 * `message.send` carrying the *reference* to the stored object.
 *
 * That reference is the object key (`chatblobs/<scope>/<uuid>.<ext>`) and is
 * deliberately **not** a fetchable URL. The bucket holding chat media must
 * have no public binding — no custom domain, no `r2.dev` — because R2 public
 * access is bucket-level, not per-prefix: a bucket exposed publicly serves
 * every object in it to anyone who learns a URL, which bypasses the session,
 * block, rate-limit and conversation-scope checks `GET /attachments/download`
 * performs. A UUID in a key is not a security boundary; keys travel through
 * push payloads, exports and client logs.
 *
 * The presigned URL is the *enforcement point*, not just a convenience:
 * `cache-control`, `content-length`, and `content-type` are part of the
 * signature, so every object carries durable caching metadata and an upload
 * that exceeds the size cap or changes the MIME type is rejected by R2 itself
 * even if the client ignores the limits it was told about. The type/size/MIME
 * checks below run server-side on both `POST /attachments/presign` and
 * `message.send`.
 *
 * Signing is AWS SigV4 (R2's S3-compatible API) implemented with `crypto`, so
 * no SDK dependency is added for what is a few HMACs.
 */

import crypto from 'crypto';
import { ATTACHMENT_PATH_PREFIX, isAllowedAttachmentMimeType, isAttachmentMessageType, maxAttachmentBytesFor } from '../../shared/index.ts';

/** R2 has no regions; its S3 API expects the literal `auto`. */
const R2_REGION = 'auto';
const S3_SERVICE = 's3';
/** How long a presigned upload URL stays valid, in seconds. */
const DEFAULT_PRESIGN_TTL_SECONDS = 300;
/** Upper bound on the configurable TTL: a leaked URL should expire quickly. */
const MAX_PRESIGN_TTL_SECONDS = 3600;
/**
 * How long a presigned *download* URL stays valid, in seconds.
 *
 * Still far shorter than an upload TTL — a download link is minted on every
 * viewing/opening/downloading attempt (see `GET /attachments/download`), so a
 * link that leaks (a forwarded chat export, a proxy log) should stop being
 * useful quickly. It nevertheless has to outlive the *transfer* it was minted
 * for, not just the request that asked for it: R2 rejects the remainder of an
 * in-flight `GET` the moment the signature expires, which is how a real
 * 18 MiB (19,120,588 byte) attachment on a mobile link turned into an opaque
 * failure part-way through at the previous 120s. 15 minutes covers the
 * largest attachment this server accepts (25 MB, see `shared/messages.ts`) at
 * roughly 30 KB/s — a bad mobile link rather than a broken one — while
 * keeping the exposure window of a leaked link in minutes, not hours.
 */
const DOWNLOAD_PRESIGN_TTL_SECONDS = 900;
const ATTACHMENT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

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
  'application/x-zip-compressed': 'zip',
  'multipart/x-zip': 'zip',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
});

/**
 * Resolved R2 configuration for attachment storage.
 *
 * There is no public base URL: the bucket is reached only through presigned
 * requests, and what a message stores is an object key, not a link.
 */
type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  ttlSeconds: number;
};

/** Environment variables that must all be present for attachments to work. */
const REQUIRED_R2_VARIABLES = Object.freeze([
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]);

/**
 * Read the R2 configuration from the environment.
 *
 * @returns `null` when R2 is not configured, in which
 *   case attachment uploads are simply unavailable and the rest of chat is
 *   unaffected.
 */
function loadR2Config(env: Record<string, string | undefined> = process.env): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucket = env.R2_BUCKET?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return null;

  // The account-scoped endpoint is derivable from the account id; an explicit
  // `R2_ENDPOINT` (a MinIO/S3 stand-in in development) wins. Either way this
  // is the S3 API endpoint, which requires a signature — never a public
  // domain in front of the bucket.
  const explicitEndpoint = env.R2_ENDPOINT?.trim().replace(/\/+$/, '');
  if (!explicitEndpoint && !accountId) return null;
  const endpoint = explicitEndpoint || `https://${accountId}.r2.cloudflarestorage.com`;

  const requestedTtl = Number(env.R2_PRESIGN_TTL_SECONDS);
  const ttlSeconds =
    Number.isFinite(requestedTtl) && requestedTtl > 0
      ? Math.min(Math.floor(requestedTtl), MAX_PRESIGN_TTL_SECONDS)
      : DEFAULT_PRESIGN_TTL_SECONDS;

  return { accountId: accountId ?? '', bucket, accessKeyId, secretAccessKey, endpoint, ttlSeconds };
}

/**
 * Explain why attachment storage is unusable or unsafe, if it is.
 *
 * Silence is only correct when nothing about R2 is configured (a text-only
 * deployment). A *half*-configured one, or one still pointing at a publicly
 * served bucket, has to say so at startup naming the variable at fault —
 * otherwise the first symptom is a `503` per upload, or bytes quietly
 * readable by anyone holding a URL.
 *
 * @returns messages to log, most serious first; empty when all is well.
 */
function describeR2Misconfiguration(env: Record<string, string | undefined> = process.env): string[] {
  const problems: string[] = [];
  const present = REQUIRED_R2_VARIABLES.filter((name) => env[name]?.trim());
  const missing = REQUIRED_R2_VARIABLES.filter((name) => !env[name]?.trim());

  if (present.length && missing.length) {
    problems.push(
      `attachment storage is half-configured: set ${missing.join(', ')} (attachments stay disabled until then)`
    );
  }
  if (present.length && !env.R2_ENDPOINT?.trim() && !env.R2_ACCOUNT_ID?.trim()) {
    problems.push(
      'attachment storage has no endpoint: set R2_ACCOUNT_ID (or R2_ENDPOINT) to reach the S3 API'
    );
  }
  if (env.R2_PUBLIC_BASE_URL?.trim()) {
    problems.push(
      'R2_PUBLIC_BASE_URL is set and ignored: attachments are served only through ' +
        'GET /attachments/download. If that hostname still fronts the attachments bucket, ' +
        'every attachment is readable by anyone who learns its key — R2 public access is ' +
        'bucket-level, so move chat media to a bucket with no custom domain and no r2.dev binding'
    );
  }
  return problems;
}

/**
 * Validate an attachment description against the shared allowlist and caps.
 */
function validateAttachmentRequest({ type, mimeType, sizeBytes }: { type?: unknown; mimeType?: unknown; sizeBytes?: unknown; } = {}): { type: string; mimeType: string; sizeBytes: number; } | { error: string; } {
  if (!isAttachmentMessageType(type)) {
    return { error: 'type must be one of image, file, voice' };
  }
  const normalisedMime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (!isAllowedAttachmentMimeType((type as string), normalisedMime)) {
    return { error: `mimeType ${normalisedMime || '(missing)'} is not allowed for ${type}` };
  }
  const size = Number(sizeBytes);
  if (!Number.isInteger(size) || size <= 0) {
    return { error: 'sizeBytes must be a positive integer' };
  }
  const cap = maxAttachmentBytesFor((type as string));
  if (size > cap) {
    return { error: `sizeBytes must be at most ${cap} for ${type}` };
  }
  return { type: (type as string), mimeType: normalisedMime, sizeBytes: size };
}

/**
 * Build the object key for a new attachment.
 *
 * The key is server-generated — never client-supplied — so a caller cannot
 * overwrite somebody else's object or escape the shared prefix. It is
 * namespaced by conversation so lifecycle rules (and manual cleanup) can work
 * per conversation.
 */
function createAttachmentKey({ conversationId, mimeType }: { conversationId: string; mimeType: string; }): string {
  const extension =
    (EXTENSION_BY_MIME_TYPE as Record<string, string>)[mimeType] ?? 'bin';
  // Keep the raw object key path-safe; presigning performs the URL encoding.
  const scope = conversationId.replace(/:/g, '_');
  return `${ATTACHMENT_PATH_PREFIX}/${scope}/${crypto.randomUUID()}.${extension}`;
}

/**
 * HMAC-SHA256 returning a Buffer.
 */
function hmac(key: crypto.BinaryLike | crypto.KeyObject, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
}

/**
 * Lowercase hex SHA-256 of a string.
 */
function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Percent-encode one path segment the way SigV4 canonicalisation requires
 * (`encodeURIComponent` leaves `!'()*` alone, which S3 does not).
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Presign one S3 request against the configured bucket.
 *
 * Query-string ("presigned URL") authentication rather than an `Authorization`
 * header, because the upload URL is handed to the client, and sharing one code
 * path with the server-side delete keeps a single SigV4 implementation.
 *
 * `signedHeaderValues` are the headers *besides* `host` that participate in the
 * signature; a request that omits or changes one of them is rejected by object
 * storage rather than by this server.
 */
function presignObjectRequest({ config, method, key, signedHeaderValues = {}, now = new Date() }: {
        config: R2Config; method: string; key: string;
        signedHeaderValues?: Record<string, string>; now?: Date;
    }): { url: string; expiresAt: string; } {
  const endpoint = new URL(config.endpoint);
  const canonicalUri = `/${[config.bucket, ...key.split('/')].map(encodeSegment).join('/')}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${R2_REGION}/${S3_SERVICE}/aws4_request`;

  // Signed headers must be sorted by lowercase name.
  const headerPairs = [...Object.entries(signedHeaderValues), ['host', endpoint.host]].sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  );
  const signedHeaders = headerPairs.map(([name]) => name).join(';');
  const canonicalHeaders = headerPairs.map(([name, value]) => `${name}:${value}\n`).join('');

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
    method,
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
    url: `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt: new Date(now.getTime() + config.ttlSeconds * 1000).toISOString(),
  };
}

/**
 * Presign an upload of exactly `sizeBytes` bytes of `mimeType` to `key`.
 *
 * `cache-control`, `content-length`, and `content-type` are signed headers, so
 * the client must send all three and they must match: durable caching metadata,
 * the size cap, and the MIME allowlist are therefore enforced by object
 * storage, not only by this server or the client.
 *
 * The `reference` returned alongside is what the client stores on the
 * message: the object key, not a link. Nothing but
 * `GET /attachments/download` can turn it into bytes.
 *
 * @param params
 */
function presignAttachmentUpload({ config, key, mimeType, sizeBytes, now = new Date() }: {
        config: ReturnType<typeof loadR2Config>; key: string; mimeType: string;
        sizeBytes: number; now?: Date;
    }): {
    uploadUrl: string; reference: string; expiresAt: string;
    headers: Record<string, string>; key: string;
} {
  if (!config) throw new Error('presignAttachmentUpload: R2 is not configured');

  const signed = presignObjectRequest({
    config,
    method: 'PUT',
    key,
    signedHeaderValues: {
      'cache-control': ATTACHMENT_CACHE_CONTROL,
      'content-length': String(sizeBytes),
      'content-type': mimeType,
    },
    now,
  });

  return {
    key,
    uploadUrl: signed.url,
    reference: key,
    expiresAt: signed.expiresAt,
    // The client must replay these verbatim, or R2 rejects the signature.
    headers: {
      'Cache-Control': ATTACHMENT_CACHE_CONTROL,
      'Content-Type': mimeType,
      'Content-Length': String(sizeBytes),
    },
  };
}

/**
 * Presign a short-lived download (`GET`) of an existing object.
 *
 * This is the authorization boundary the stored reference on its own cannot
 * provide: the bucket is not readable without a valid signature, so a client
 * can only ever fetch bytes for a key this deployment agreed, per request, to
 * hand out — never by guessing a key or replaying an old link. That holds
 * only as long as the bucket has no public binding; see the module header.
 *
 * What this *cannot* do: revoke a copy that already left the server. Once a
 * download link has been followed — or the resulting file saved, forwarded,
 * or screenshotted — those bytes are outside this system's control, the same
 * as any other file transfer. `DOWNLOAD_PRESIGN_TTL_SECONDS` bounds how long
 * an unused *link* stays valid; it says nothing about copies already made
 * from a link that was used before it expired.
 *
 * `config` is only accepted as possibly-null to match `loadR2Config`'s
 * return type; the throw below is defensive — callers are expected to have
 * already returned a 503 when R2 is unconfigured, as the route handler does.
 */
function presignAttachmentDownload({ config, key, now = new Date() }: {
  config: ReturnType<typeof loadR2Config>; key: string; now?: Date;
}): { downloadUrl: string; expiresAt: string; } {
  if (!config) throw new Error('presignAttachmentDownload: R2 is not configured');
  const signed = presignObjectRequest({
    config: { ...config, ttlSeconds: DOWNLOAD_PRESIGN_TTL_SECONDS },
    method: 'GET',
    key,
    now,
  });
  return { downloadUrl: signed.url, expiresAt: signed.expiresAt };
}

/**
 * The `<scope>` segment of an attachment key (`chatblobs/<scope>/<file>`).
 *
 * `createAttachmentKey` namespaces every object by conversation so a download
 * grant can be checked against the two participants the key was minted for
 * without a database round trip: the caller recomputes the scope it expects
 * from its own session and the peer it claims, and the two are compared for
 * exact equality.
 *
 * @returns the scope, or `null` when `key` is not a well-formed attachment key.
 */
function attachmentScopeFromKey(key: unknown): string | null {
  if (typeof key !== 'string') return null;
  const parts = key.split('/');
  if (parts.length < 3 || parts[0] !== ATTACHMENT_PATH_PREFIX) return null;
  return parts[1] || null;
}

/**
 * Whether `reference` is a reference to media this deployment stored.
 *
 * A message may only carry a reference this server handed out: an arbitrary
 * URL would turn every chat bubble into a request to a host of the sender's
 * choosing (an IP-leak / tracking vector for the recipient), and a key
 * outside the chat-blob prefix would point at storage that is not chat media.
 */
function isManagedAttachmentReference(config: ReturnType<typeof loadR2Config>, reference: unknown): reference is string {
  return Boolean(config) && attachmentKeyFromReference(config, reference) !== null;
}

/**
 * The host of an attachment reference, for diagnostics.
 *
 * A reference is a bare key and has no host; one that *does* parse as a URL
 * is a pre-private-bucket leftover, and its host is the only part a log may
 * carry — never the full (or signed) URL.
 *
 * @returns the host, or `null` when there is none to report.
 */
function attachmentReferenceHost(reference: unknown): string | null {
  if (typeof reference !== 'string') return null;
  try {
    return new URL(reference).host || null;
  } catch {
    return null;
  }
}

/**
 * Recover the object key from a stored attachment reference.
 *
 * The reference *is* the key (`chatblobs/<scope>/<uuid>.<ext>`); this
 * validates its shape rather than parsing a URL. Only well-formed keys under
 * the chat-blob prefix are accepted, so neither a download grant nor an
 * account erasure can be steered at an object outside it.
 *
 * `onUnresolved` is called with a reason and the reference's host (never the
 * reference itself) when derivation fails, because a reference that no longer
 * resolves — a row predating the private bucket, say — is otherwise invisible
 * without a database query.
 *
 * @returns the key, or `null` when the reference is not one of ours.
 */
function attachmentKeyFromReference(
  config: ReturnType<typeof loadR2Config>,
  reference: unknown,
  { onUnresolved }: { onUnresolved?: (details: { reason: string; host: string | null; }) => void; } = {}
): string | null {
  /** @param reason */
  const refuse = (reason: string) => {
    onUnresolved?.({ reason, host: attachmentReferenceHost(reference) });
    return null;
  };

  if (!config) return refuse('attachments are not configured');
  if (typeof reference !== 'string' || !reference.trim()) return refuse('reference is empty');

  const segments = reference.trim().split('/');
  if (segments[0] !== ATTACHMENT_PATH_PREFIX) {
    // A full URL lands here too: attachments are no longer published under a
    // public base URL, so a stored link is a leftover, not a key.
    return refuse(`reference is not under ${ATTACHMENT_PATH_PREFIX}/`);
  }
  if (segments.length < 3) return refuse('reference is missing a scope or object name');
  // `.`/`..`/empty segments cannot appear in a key this server minted, and
  // would let a normalising proxy escape the prefix.
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return refuse('reference contains a relative path segment');
  }
  return attachmentScopeFromKey(reference.trim()) ? reference.trim() : refuse('reference has no scope');
}

/**
 * Delete the object behind a stored attachment reference.
 *
 * Used by account erasure: tombstoning a message clears the reference to its
 * attachment, but the bytes outlive the row unless they are removed here, and
 * the bucket carries no lifecycle rule that would collect them.
 *
 * @returns `true` when the object is gone (including when it never existed).
 */
async function deleteAttachmentObject({ config, url, fetchImpl = fetch, now = new Date() }: {
        config: ReturnType<typeof loadR2Config>; url: unknown;
        fetchImpl?: typeof fetch; now?: Date;
    }): Promise<boolean> {
  const key = attachmentKeyFromReference(config, url);
  if (!config || !key) return false;

  const signed = presignObjectRequest({ config, method: 'DELETE', key, now });
  const response = await fetchImpl(signed.url, { method: 'DELETE' });
  // S3/R2 answer an absent key with 204, so a retry after a partial erasure is
  // not an error; 404 is tolerated for stand-ins that report it instead.
  return response.ok || response.status === 404;
}

export {
  DEFAULT_PRESIGN_TTL_SECONDS,
  DOWNLOAD_PRESIGN_TTL_SECONDS,
  MAX_PRESIGN_TTL_SECONDS,
  attachmentKeyFromReference,
  attachmentReferenceHost,
  attachmentScopeFromKey,
  createAttachmentKey,
  deleteAttachmentObject,
  describeR2Misconfiguration,
  isManagedAttachmentReference,
  loadR2Config,
  presignAttachmentDownload,
  presignAttachmentUpload,
  validateAttachmentRequest,
};
