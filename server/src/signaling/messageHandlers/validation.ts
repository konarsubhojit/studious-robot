import { MAX_MESSAGE_BODY_LENGTH } from '../../messageStore.ts';
import { normaliseId } from '../../lib/normalize.ts';
import { isManagedAttachmentUrl, loadR2Config, validateAttachmentRequest } from '../../attachments.ts';
import {
  DEFAULT_MESSAGE_TYPE,
  MAX_REACTION_LENGTH,
  MAX_VOICE_DURATION_MS,
  MESSAGE_TYPES,
  isAttachmentMessageType,
  isSupportedMessageType,
} from '../../../../shared/index.ts';

function validateBody(
  value: unknown,
  { allowEmpty = false }: { allowEmpty?: boolean; } = {}
): { body: string; error?: undefined; message?: undefined; } | { body?: undefined; error: string; message: string; } {
  if (typeof value !== 'string') {
    return { error: 'bad_request', message: 'body must be a string' };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 && !allowEmpty) {
    return { error: 'bad_request', message: 'body must not be empty' };
  }
  if (trimmed.length > MAX_MESSAGE_BODY_LENGTH) {
    return {
      error: 'bad_request',
      message: `body must be at most ${MAX_MESSAGE_BODY_LENGTH} characters`,
    };
  }
  return { body: trimmed };
}

/**
 * Validate the optional voice-note duration, returning the rejection message or
 * `null` when the value is absent or in range.
 *
 * `Number.isInteger` short-circuits the range comparisons for non-numeric
 * values, so a string duration is rejected before it is ever compared.
 */
function validateDurationMs(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_VOICE_DURATION_MS
  ) {
    return `attachment.durationMs must be between 0 and ${MAX_VOICE_DURATION_MS}`;
  }
  return null;
}

/**
 * Project the caller-supplied attachment onto the stored shape: every optional
 * field is normalised to a value of its declared type or `null`, so nothing
 * unvalidated from the request reaches the store.
 */
function normaliseAttachmentFields(
  attachment: Record<string, any>,
  config: ReturnType<typeof loadR2Config>,
  mimeType: string
): Record<string, any> {
  return {
    url: String(attachment.url),
    mimeType,
    sizeBytes: Number.isInteger(attachment.sizeBytes) ? attachment.sizeBytes : null,
    name: typeof attachment.name === 'string' ? attachment.name.slice(0, 255) : null,
    width: Number.isInteger(attachment.width) ? attachment.width : null,
    height: Number.isInteger(attachment.height) ? attachment.height : null,
    durationMs: Number.isInteger(attachment.durationMs) ? attachment.durationMs : null,
    thumbnailUrl: isManagedAttachmentUrl(config, attachment.thumbnailUrl)
      ? attachment.thumbnailUrl
      : null,
  };
}

function validateAttachment(
  type: string,
  rawAttachment: unknown
): { attachment: Record<string, any>; error?: undefined; message?: undefined; } | { attachment?: undefined; error: string; message: string; } {
  if (!rawAttachment || typeof rawAttachment !== 'object' || Array.isArray(rawAttachment)) {
    return { error: 'bad_request', message: `${type} messages require an attachment` };
  }
  const attachment = rawAttachment as Record<string, any>;

  const config = loadR2Config();
  if (!config) {
    return { error: 'bad_request', message: 'attachment uploads are not enabled' };
  }
  if (!isManagedAttachmentUrl(config, attachment.url)) {
    return { error: 'bad_request', message: 'attachment.url is not a managed upload' };
  }

  const validated = validateAttachmentRequest({
    type,
    mimeType: attachment.mimeType,
    sizeBytes: Number.isInteger(attachment.sizeBytes) ? attachment.sizeBytes : 1,
  });
  if ('error' in validated) {
    return { error: 'bad_request', message: `attachment: ${validated.error}` };
  }

  const durationError = validateDurationMs(attachment.durationMs);
  if (durationError) {
    return { error: 'bad_request', message: durationError };
  }

  return {
    attachment: normaliseAttachmentFields(attachment, config, validated.mimeType),
  };
}

function validateMessageType(
  value: unknown
): { type: string; error?: undefined; message?: undefined; } | { type?: undefined; error: string; message: string; } {
  if (value === undefined || value === null) return { type: DEFAULT_MESSAGE_TYPE };
  if (!isSupportedMessageType(value) || value === MESSAGE_TYPES.SYSTEM) {
    return { error: 'bad_request', message: 'unsupported message type' };
  }
  return { type: value as string };
}

const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function parseClientMessageId(value: unknown): string | null {
  const normalised = normaliseId(value);
  return normalised && CLIENT_MESSAGE_ID_PATTERN.test(normalised) ? normalised : null;
}

function validateReactionEmoji(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REACTION_LENGTH) return null;
  return /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f]+$/u.test(trimmed)
    ? trimmed
    : null;
}

export {
  parseClientMessageId,
  validateAttachment,
  validateBody,
  validateMessageType,
  validateReactionEmoji,
  isAttachmentMessageType,
};
