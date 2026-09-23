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
 * Whether those bytes are *also* reachable without this server is a property of
 * the bucket, not of this module: an R2 bucket exposed through a custom domain
 * or its `r2.dev` URL is readable by anyone who learns an object's URL, and R2
 * public access is bucket-wide — there is no "private prefix" inside a public
 * bucket. `R2_BUCKET_PRIVATE` is the supported way to get the authorization
 * boundary `GET /attachments/download` is meant to be: a second bucket with no
 * public binding, reachable only through presigned URLs. New uploads go there,
 * while reads still resolve objects left behind in the public bucket.
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
 * Still far shorter than the upload TTL — a download link is minted on every
 * viewing/opening/downloading attempt (see `GET /attachments/download`), so a
 * leaked one (a forwarded chat export, a proxy log) should stop being useful
 * quickly. It nevertheless has to outlive the *transfer* it was minted for,
 * not just the request: R2 rejects the remainder of an in-flight `GET` once
 * the signature expires, which turned a real 18 MiB attachment on a mobile
 * link into a generic transport error mid-download. 15 minutes covers the
 * largest attachment this server accepts (25 MB, see `shared/messages.ts`) at
 * roughly 30 KB/s — a bad mobile link, not a broken one — while keeping the
 * exposure window of a leaked link in minutes rather than hours.
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
 * Hosts a stored attachment URL may legitimately carry besides the configured
 * (and explicitly configured legacy) public base URLs.
 *
 * `R2_PUBLIC_BASE_URL` is a deployment detail that changes — moving from the
 * bucket's `r2.dev` URL to a custom domain is the documented path — and every
 * message already sent keeps the base URL of the day. The key path underneath
 * (`chatblobs/<scope>/<uuid>.<ext>`) is identical across generations, so the
 * host is not what authorizes anything: the derived key is scope-checked
 * against the caller's session either way. These patterns keep the set of
 * accepted hosts bounded to R2's own public hostnames rather than opening
 * derivation up to an arbitrary attacker-chosen host.
 */
const R2_OWN_HOST_PATTERNS: readonly RegExp[] = Object.freeze([
  /^pub-[0-9a-f]+\.r2\.dev$/i,
  /^[0-9a-z]+\.r2\.cloudflarestorage\.com$/i,
]);

/** Strip a trailing slash so `${base}/${key}` never doubles it. */
function normaliseBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, '');
  return trimmed || undefined;
}

/**
 * Resolved R2 configuration.
 *
 * `privateBucket` and `legacyPublicBaseUrls` are optional so a caller (a test,
 * or a deployment predating them) can describe a single-bucket setup without
 * spelling out the parts it does not use.
 */
type R2Config = {
  accountId: string;
  bucket: string;
  /** Bucket with no public binding; when set, new uploads are written here. */
  privateBucket?: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  publicBaseUrl: string;
  /** Public base URLs this deployment published attachments under before. */
  legacyPublicBaseUrls?: string[];
  ttlSeconds: number;
};

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
  const publicBaseUrl = normaliseBaseUrl(env.R2_PUBLIC_BASE_URL);
  if (!bucket || !accessKeyId || !secretAccessKey || !publicBaseUrl) return null;

  // An optional second bucket with no public binding. When set, it is where
  // new objects are written; the public bucket stays readable so attachments
  // uploaded before the switch keep resolving.
  const privateBucket = env.R2_BUCKET_PRIVATE?.trim() || null;

  // Base URLs this deployment used to publish attachments under. Optional:
  // derivation already tolerates R2's own hostnames, this is for deployments
  // that fronted the bucket with a CDN/custom domain they have since retired.
  const legacyPublicBaseUrls = (env.R2_PUBLIC_BASE_URL_LEGACY ?? '')
    .split(',')
    .map((entry) => normaliseBaseUrl(entry))
    .filter((entry): entry is string => Boolean(entry) && entry !== publicBaseUrl);

  // The account-scoped endpoint is derivable from the account id; an explicit
  // `R2_ENDPOINT` (custom domain, or a MinIO/S3 stand-in in development) wins.
  const explicitEndpoint = normaliseBaseUrl(env.R2_ENDPOINT);
  if (!explicitEndpoint && !accountId) return null;
  const endpoint = explicitEndpoint || `https://${accountId}.r2.cloudflarestorage.com`;

  const requestedTtl = Number(env.R2_PRESIGN_TTL_SECONDS);
  const ttlSeconds =
    Number.isFinite(requestedTtl) && requestedTtl > 0
      ? Math.min(Math.floor(requestedTtl), MAX_PRESIGN_TTL_SECONDS)
      : DEFAULT_PRESIGN_TTL_SECONDS;

  return {
    accountId: accountId ?? '',
    bucket,
    privateBucket,
    accessKeyId,
    secretAccessKey,
    endpoint,
    publicBaseUrl,
    legacyPublicBaseUrls,
    ttlSeconds,
  };
}


/** Where new objects are written: the private bucket when one is configured. */
function attachmentWriteBucket(config: R2Config): string {
  return config.privateBucket ?? config.bucket;
}

/**
 * Buckets a stored object may live in, private one first.
 *
 * Configuring `R2_BUCKET_PRIVATE` does not move the objects already in the
 * public bucket, so a read has to consider both — see
 * `presignAttachmentDownload`, which probes rather than guesses.
 */
function attachmentReadBuckets(config: R2Config): string[] {
  return config.privateBucket && config.privateBucket !== config.bucket
    ? [config.privateBucket, config.bucket]
    : [config.bucket];
}

/**
 * Whether this deployment serves attachment bytes to anyone who learns a URL.
 *
 * R2 public access is bucket-level: if the bucket holding chat media is bound
 * to a custom domain or its `r2.dev` URL, the authorization performed by
 * `GET /attachments/download` is advisory — the object is fetchable without it.
 *
 * @returns the environment variable at fault, or `null` when reads are private.
 */
function publiclyReadableAttachmentVariable(config: ReturnType<typeof loadR2Config>): string | null {
  if (!config) return null;
  // With a private bucket configured, new uploads land somewhere with no
  // public binding; the public bucket only holds pre-switch objects.
  return config.privateBucket ? null : 'R2_PUBLIC_BASE_URL';
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
function presignObjectRequest({ config, method, key, bucket = attachmentWriteBucket(config), ttlSeconds = config.ttlSeconds, signedHeaderValues = {}, now = new Date() }: {
        config: R2Config; method: string; key: string; bucket?: string;
        ttlSeconds?: number;
        signedHeaderValues?: Record<string, string>; now?: Date;
    }): { url: string; expiresAt: string; } {
  const endpoint = new URL(config.endpoint);
  const canonicalUri = `/${[bucket, ...key.split('/')].map(encodeSegment).join('/')}`;
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
  query.set('X-Amz-Expires', String(ttlSeconds));
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
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
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
 * @param params
 */
function presignAttachmentUpload({ config, key, mimeType, sizeBytes, now = new Date() }: {
        config: ReturnType<typeof loadR2Config>; key: string; mimeType: string;
        sizeBytes: number; now?: Date;
    }): {
    uploadUrl: string; publicUrl: string; expiresAt: string;
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
    publicUrl: `${config.publicBaseUrl}/${key.split('/').map(encodeSegment).join('/')}`,
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
 * This is the authorization boundary the stored attachment reference on its
 * own cannot provide — *provided the bucket is not publicly readable*. R2
 * public access is bucket-wide, so a deployment that binds the media bucket
 * to a custom domain or its `r2.dev` URL serves those same bytes to anyone
 * who learns the URL, whatever this endpoint decides; `R2_BUCKET_PRIVATE`
 * (see `attachmentReadBuckets`) is what makes the signature the only way in.
 *
 * With both buckets configured, an object may live in either — switching to
 * a private bucket does not move what is already stored — so the bucket is
 * probed with a signed `HEAD` rather than guessed: handing the client a link
 * into the wrong bucket would 404 an attachment that exists. A deployment
 * with a single bucket never issues the probe.
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
async function presignAttachmentDownload({ config, key, fetchImpl = fetch, now = new Date() }: {
  config: ReturnType<typeof loadR2Config>; key: string;
  fetchImpl?: typeof fetch; now?: Date;
}): Promise<{ downloadUrl: string; expiresAt: string; }> {
  if (!config) throw new Error('presignAttachmentDownload: R2 is not configured');
  const candidates = attachmentReadBuckets(config);
  let bucket = candidates[0];

  if (candidates.length > 1) {
    for (const candidate of candidates) {
      const probe = presignObjectRequest({
        config,
        bucket: candidate,
        method: 'HEAD',
        key,
        ttlSeconds: DOWNLOAD_PRESIGN_TTL_SECONDS,
        now,
      });
      // The probe URL is used for exactly this request and then discarded; it
      // is never logged or handed to a client.
      const found = await fetchImpl(probe.url, { method: 'HEAD' })
        .then((response) => response.ok)
        .catch(() => false);
      if (found) {
        bucket = candidate;
        break;
      }
    }
  }

  const signed = presignObjectRequest({
    config,
    bucket,
    method: 'GET',
    key,
    ttlSeconds: DOWNLOAD_PRESIGN_TTL_SECONDS,
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
 * Whether `url` points at this deployment's chat-blob prefix.
 *
 * A message may only reference media this server handed out a presigned URL
 * for: an arbitrary URL would turn every chat bubble into a request to a host
 * of the sender's choosing (an IP-leak / tracking vector for the recipient).
 *
 * Deliberately stricter than `attachmentKeyFromUrl`: a *new* message has no
 * reason to carry anything but today's base URL, while a *stored* one may
 * predate a base-URL change.
 */
function isManagedAttachmentUrl(config: ReturnType<typeof loadR2Config>, url: unknown): url is string {
  if (!config || typeof url !== 'string') return false;
  if (!url.startsWith(`${config.publicBaseUrl}/${ATTACHMENT_PATH_PREFIX}/`)) return false;
  // `startsWith` alone would accept a URL that escapes the prefix again once a
  // proxy normalises it (`…/chatblobs/../elsewhere`).
  return !url.includes('..');
}

/**
 * The host of a stored attachment URL, for diagnostics.
 *
 * Only ever the host: a stored URL is not signed, but the same helper is used
 * where a signed one could be passed, and a host answers the only question a
 * log needs to ("which generation of base URL is this row from?").
 *
 * @returns the host, or `null` when `url` is not a parseable URL.
 */
function attachmentUrlHost(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * Whether attachment URLs on `host` may be resolved to an object key.
 *
 * The configured base URL, any explicitly configured legacy base URL, and
 * R2's own public hostnames (`pub-….r2.dev`, `<account>.r2.cloudflarestorage.com`)
 * — never an arbitrary host, so a client-supplied URL cannot steer key
 * derivation (and, through account erasure, object deletion) at something
 * this deployment never published.
 */
function isKnownAttachmentHost(config: R2Config, host: string): boolean {
  const known = [config.publicBaseUrl, ...(config.legacyPublicBaseUrls ?? [])]
    .map((base) => attachmentUrlHost(base))
    .filter((entry): entry is string => Boolean(entry));
  if (known.some((entry) => entry.toLowerCase() === host.toLowerCase())) return true;
  return R2_OWN_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

/**
 * Recover the object key from a stored attachment URL.
 *
 * Anchored on the chat-blob prefix and the scope rather than on an exact
 * base-URL match: `R2_PUBLIC_BASE_URL` changes over a deployment's life (the
 * `r2.dev` URL, then a custom domain), and every message sent before the
 * change keeps the base URL of its day while pointing at the *same* object.
 * Requiring today's base URL made all of that history undownloadable.
 *
 * The host is still constrained (`isKnownAttachmentHost`) and the path must
 * still be a well-formed key under the prefix, so an account erasure can
 * never be steered into deleting an object outside the chat-blob prefix, and
 * the derived key remains subject to the caller's scope check.
 *
 * @returns the key, or `null` when the URL is not one of ours.
 */
function attachmentKeyFromUrl(config: ReturnType<typeof loadR2Config>, url: unknown): string | null {
  if (!config || typeof url !== 'string') return null;
  // `..` cannot appear in a key this server minted, and would let a
  // normalising proxy escape the prefix after the check below.
  if (url.includes('..')) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!isKnownAttachmentHost(config, parsed.host)) return null;

  let path: string;
  try {
    path = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  // A base URL may carry a path of its own (a CDN mount point); the key
  // starts at the chat-blob prefix wherever that appears first.
  const prefixAt = path.indexOf(`${ATTACHMENT_PATH_PREFIX}/`);
  if (prefixAt < 0) return null;
  const key = path.slice(prefixAt);
  // `<prefix>/<scope>/<file>`, with a non-empty scope — the shape the scope
  // check the caller performs depends on.
  return attachmentScopeFromKey(key) && key.split('/').length >= 3 ? key : null;
}

/**
 * Delete the object behind a stored attachment URL.
 *
 * Used by account erasure: tombstoning a message clears the reference to its
 * attachment, but the bytes outlive the row unless they are removed here, and
 * the bucket carries no lifecycle rule that would collect them.
 *
 * Every bucket a read could resolve the key in is deleted from, because an
 * object predating `R2_BUCKET_PRIVATE` still sits in the public one and an
 * erasure that left it there would leave the bytes publicly readable. S3/R2
 * answer a `DELETE` for an absent key with 204, so the extra call costs a
 * round trip and never fails a deletion that did happen.
 *
 * @returns `true` when the object is gone (including when it never existed).
 */
async function deleteAttachmentObject({ config, url, fetchImpl = fetch, now = new Date() }: {
        config: ReturnType<typeof loadR2Config>; url: unknown;
        fetchImpl?: typeof fetch; now?: Date;
    }): Promise<boolean> {
  const key = attachmentKeyFromUrl(config, url);
  if (!config || !key) return false;

  let removed = true;
  for (const bucket of attachmentReadBuckets(config)) {
    const signed = presignObjectRequest({ config, bucket, method: 'DELETE', key, now });
    const response = await fetchImpl(signed.url, { method: 'DELETE' });
    // 404 is tolerated for stand-ins that report it instead of 204.
    removed = removed && (response.ok || response.status === 404);
  }
  return removed;
}

export {
  DEFAULT_PRESIGN_TTL_SECONDS,
  DOWNLOAD_PRESIGN_TTL_SECONDS,
  MAX_PRESIGN_TTL_SECONDS,
  attachmentKeyFromUrl,
  attachmentScopeFromKey,
  attachmentUrlHost,
  createAttachmentKey,
  deleteAttachmentObject,
  isManagedAttachmentUrl,
  loadR2Config,
  publiclyReadableAttachmentVariable,
  presignAttachmentDownload,
  presignAttachmentUpload,
  validateAttachmentRequest,
};
