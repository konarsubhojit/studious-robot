// @ts-check
'use strict';

/**
 * Rich-message contract shared by `mobile/` and `server/`.
 *
 * A chat message used to be a `body` string and nothing else. It can now also
 * carry an attachment (image, file, voice note), quote another message, and
 * collect reactions. The contract lives here so both edges agree on the
 * vocabulary — the allowed types, the MIME allowlist, the per-type size caps
 * and the one-line description shown in a chat-list row or a push
 * notification.
 *
 * Backwards compatibility is the rule that shapes this module:
 *   - messages persisted before the schema change have no `type`, so every
 *     reader defaults to `"text"` ({@link messageTypeOf});
 *   - a `type` a client does not know about must render as a neutral
 *     placeholder rather than crash it ({@link describeMessagePreview}).
 */

/** Canonical message types. Anything else is "unsupported" to this build. */
const MESSAGE_TYPES = Object.freeze({
  TEXT: 'text',
  IMAGE: 'image',
  FILE: 'file',
  VOICE: 'voice',
  SYSTEM: 'system',
});

/** The type assumed for a message that carries none (i.e. every legacy row). */
const DEFAULT_MESSAGE_TYPE = MESSAGE_TYPES.TEXT;

/** Every type this build understands. */
const KNOWN_MESSAGE_TYPES = /** @type {ReadonlyArray<string>} */ (
  Object.freeze(Object.values(MESSAGE_TYPES))
);

/** Types whose payload lives in object storage rather than in `body`. */
const ATTACHMENT_MESSAGE_TYPES = /** @type {ReadonlyArray<string>} */ (
  Object.freeze([MESSAGE_TYPES.IMAGE, MESSAGE_TYPES.FILE, MESSAGE_TYPES.VOICE])
);

/**
 * Accepted MIME types per attachment type.
 *
 * Enforced by the server on both `POST /attachments/presign` and
 * `message.send` — a client-side check is a convenience, never the control.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const ATTACHMENT_MIME_ALLOWLIST = Object.freeze({
  [MESSAGE_TYPES.IMAGE]: Object.freeze([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
  ]),
  [MESSAGE_TYPES.VOICE]: Object.freeze([
    'audio/aac',
    'audio/mp4',
    'audio/mpeg',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
  ]),
  [MESSAGE_TYPES.FILE]: Object.freeze([
    'application/pdf',
    'application/zip',
    'text/plain',
    'video/mp4',
  ]),
});

/**
 * Maximum upload size per attachment type, in bytes.
 *
 * @type {Readonly<Record<string, number>>}
 */
const MAX_ATTACHMENT_BYTES = Object.freeze({
  [MESSAGE_TYPES.IMAGE]: 10 * 1024 * 1024,
  [MESSAGE_TYPES.VOICE]: 16 * 1024 * 1024,
  [MESSAGE_TYPES.FILE]: 25 * 1024 * 1024,
});

/**
 * Path segment every chat blob is stored and served under, appended to the
 * object-storage public base URL. Shared by all chat media, so a deployment
 * can point a single Cloudflare R2 bucket (or CDN hostname) at it.
 */
const ATTACHMENT_PATH_PREFIX = 'chatblobs';

/** Longest accepted reaction emoji, in UTF-16 code units (ZWJ sequences fit). */
const MAX_REACTION_LENGTH = 16;

/** Longest accepted voice note, so a stuck recorder cannot claim hours. */
const MAX_VOICE_DURATION_MS = 10 * 60 * 1000;

/**
 * The effective type of a message, defaulting legacy rows to `"text"`.
 *
 * @param {{ type?: unknown } | null | undefined} message
 * @returns {string}
 */
function messageTypeOf(message) {
  const type = message?.type;
  return typeof type === 'string' && type ? type : DEFAULT_MESSAGE_TYPE;
}

/**
 * Whether this build knows how to render `type`.
 *
 * @param {unknown} type
 * @returns {boolean}
 */
function isSupportedMessageType(type) {
  return KNOWN_MESSAGE_TYPES.includes(/** @type {string} */ (type));
}

/**
 * Whether a message of `type` must carry an attachment.
 *
 * @param {unknown} type
 * @returns {boolean}
 */
function isAttachmentMessageType(type) {
  return ATTACHMENT_MESSAGE_TYPES.includes(/** @type {string} */ (type));
}

/**
 * Whether `mimeType` is allowed for an attachment of `type`.
 *
 * @param {string} type
 * @param {unknown} mimeType
 * @returns {boolean}
 */
function isAllowedAttachmentMimeType(type, mimeType) {
  const allowed = ATTACHMENT_MIME_ALLOWLIST[type];
  if (!allowed) return false;
  return typeof mimeType === 'string' && allowed.includes(mimeType.toLowerCase());
}

/**
 * Size cap for an attachment of `type`, or `0` when the type takes none.
 *
 * @param {string} type
 * @returns {number}
 */
function maxAttachmentBytesFor(type) {
  return MAX_ATTACHMENT_BYTES[type] ?? 0;
}

/**
 * A one-line, human-readable description of a message.
 *
 * Used for chat-list previews, push notification bodies and accessibility
 * labels, so all three describe a rich message the same way. Crucially, an
 * unknown `type` — a message written by a newer client — yields a neutral
 * placeholder instead of an empty row or a crash.
 *
 * @param {{ type?: string, body?: string, deletedAt?: string|null,
 *   attachment?: { name?: string|null } | null } | null | undefined} message
 * @returns {string}
 */
function describeMessagePreview(message) {
  if (message?.deletedAt) return 'Message deleted';

  const type = messageTypeOf(message);
  const body = typeof message?.body === 'string' ? message.body.trim() : '';

  switch (type) {
    case MESSAGE_TYPES.TEXT:
    case MESSAGE_TYPES.SYSTEM:
      return body;
    case MESSAGE_TYPES.IMAGE:
      return body ? `📷 ${body}` : '📷 Photo';
    case MESSAGE_TYPES.VOICE:
      return '🎤 Voice message';
    case MESSAGE_TYPES.FILE:
      return `📎 ${message?.attachment?.name || body || 'Attachment'}`;
    default:
      return 'Unsupported message';
  }
}

module.exports = {
  ATTACHMENT_MESSAGE_TYPES,
  ATTACHMENT_MIME_ALLOWLIST,
  ATTACHMENT_PATH_PREFIX,
  DEFAULT_MESSAGE_TYPE,
  KNOWN_MESSAGE_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_REACTION_LENGTH,
  MAX_VOICE_DURATION_MS,
  MESSAGE_TYPES,
  describeMessagePreview,
  isAllowedAttachmentMimeType,
  isAttachmentMessageType,
  isSupportedMessageType,
  maxAttachmentBytesFor,
  messageTypeOf,
};
