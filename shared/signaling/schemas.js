// @ts-check
'use strict';

const { s } = require('../schema');
const { CLIENT_EVENTS, SERVER_EVENTS, SIGNALING_VERSION } = require('./events');
const { KNOWN_MESSAGE_TYPES, MAX_REACTION_LENGTH } = require('../messages');

/**
 * Payload schema for every signaling event, keyed by event name.
 *
 * Both edges validate against these: the server rejects a malformed inbound
 * payload with a `bad_request` acknowledgement instead of letting a handler
 * throw on `undefined`, and the mobile client drops (and logs) an inbound event
 * whose payload does not match rather than crashing a React hook.
 *
 * Schemas are deliberately structural rather than exhaustive: they pin the
 * fields a handler actually dereferences, and let records owned by one side
 * (SDP blobs, ICE candidates, persisted call/message rows) pass through.
 */

/** Maximum accepted chat message body length (mirrors the message store). */
const MAX_MESSAGE_BODY_LENGTH = 4000;

const versionField = s.literal(SIGNALING_VERSION);
/**
 * Server → client payloads treat `version` as advisory metadata: the client
 * does not branch on it, so a payload that omits it is still usable. Requests
 * in the other direction keep it mandatory (the server rejects mismatches with
 * `unsupported_version`).
 */
const inboundVersionField = versionField.optional();
const idField = s.id();
const optionalId = s.id().optional().nullable();

/** SDP / ICE / media-state blobs: shape is owned by WebRTC, keep them intact. */
const opaqueObject = s.opaque();

/**
 * A persisted call row as broadcast to participants.
 *
 * @typedef {object} CallRecord
 * @property {string} callId
 * @property {string} callerId
 * @property {string} calleeId
 * @property {string} status
 * @property {string | null} [ringTimeoutAt] - When an unanswered call stops
 *   ringing, for the ringing screens' countdown.
 */
const callRecord = s.object(
  {
    callId: idField,
    callerId: s.id().optional(),
    calleeId: s.id().optional(),
    status: s.string({ min: 1 }).optional(),
  },
  { passthrough: true }
);

/**
 * An attachment stored in object storage and referenced by a message.
 *
 * Only `url` and `mimeType` are required: the optional dimensions/duration are
 * rendering hints the sender supplies when it knows them.
 *
 * @typedef {object} AttachmentRecord
 * @property {string} url
 * @property {string} mimeType
 * @property {number} [sizeBytes]
 * @property {string | null} [name]
 * @property {number | null} [width]
 * @property {number | null} [height]
 * @property {number | null} [durationMs]
 * @property {string | null} [thumbnailUrl]
 */
const attachmentRecord = s.object(
  {
    url: s.string({ min: 1, max: 2048, trim: true }),
    mimeType: s.string({ min: 1, max: 255, trim: true }),
    sizeBytes: s.number({ min: 0, integer: true }).optional(),
    name: s.string({ max: 255 }).optional().nullable(),
    width: s.number({ min: 0, integer: true }).optional().nullable(),
    height: s.number({ min: 0, integer: true }).optional().nullable(),
    durationMs: s.number({ min: 0, integer: true }).optional().nullable(),
    thumbnailUrl: s.string({ max: 2048 }).optional().nullable(),
  },
  { passthrough: true }
);

/**
 * A persisted chat message row.
 *
 * `type` is deliberately a free-form string rather than an enum: a client must
 * be able to *receive* a type it does not understand (and render a neutral
 * placeholder) instead of dropping the event. Legacy rows carry no `type` at
 * all, which readers default to `"text"`.
 *
 * @typedef {object} MessageRecord
 * @property {string} messageId
 * @property {string} conversationId
 * @property {string} senderId
 * @property {string} recipientId
 * @property {string} body
 * @property {string} [type] - Message type; absent on legacy rows ("text").
 * @property {AttachmentRecord | null} [attachment]
 * @property {string | null} [replyTo]
 * @property {Record<string, string[]> | null} [reactions]
 * @property {string | null} [deletedAt]
 * @property {string} [createdAt]
 */
const messageRecord = s.object(
  {
    messageId: idField,
    conversationId: s.id().optional(),
    senderId: idField,
    recipientId: idField,
    body: s.string(),
    type: s.string({ max: 32 }).optional(),
    attachment: attachmentRecord.optional().nullable(),
    replyTo: s.string({ max: 128 }).optional().nullable(),
    reactions: s.record(s.array(s.id())).optional().nullable(),
    deletedAt: s.string().optional().nullable(),
  },
  { passthrough: true }
);

/** Client → server payloads. */
const CLIENT_EVENT_SCHEMAS = Object.freeze({
  [CLIENT_EVENTS.JOIN_ROOM]: s.id(),
  [CLIENT_EVENTS.ROOM_OFFER]: s.object({ roomId: idField, sdp: opaqueObject }),
  [CLIENT_EVENTS.ROOM_ANSWER]: s.object({ roomId: idField, sdp: opaqueObject }),
  [CLIENT_EVENTS.ROOM_ICE_CANDIDATE]: s.object({ roomId: idField, candidate: opaqueObject }),

  [CLIENT_EVENTS.CALL_INITIATE]: s.object({ version: versionField, calleeId: idField }),
  [CLIENT_EVENTS.CALL_INCOMING_ACK]: s.object({
    version: versionField,
    callId: idField,
    deviceId: s.id().optional(),
  }),
  [CLIENT_EVENTS.CALL_ACCEPT]: s.object({ version: versionField, callId: idField }),
  [CLIENT_EVENTS.CALL_DECLINE]: s.object({ version: versionField, callId: idField }),
  [CLIENT_EVENTS.CALL_CANCEL]: s.object({ version: versionField, callId: idField }),
  [CLIENT_EVENTS.CALL_END]: s.object({ version: versionField, callId: idField }),
  // `iceState` mirrors the peer connection state the client observed. Anything
  // other than a failure state advances the call to its connected steady
  // state; `disconnected` / `failed` end it without waiting for a sweep.
  [CLIENT_EVENTS.CALL_CONNECTED]: s.object({
    version: versionField,
    callId: idField,
    iceState: s.enum(['connected', 'completed', 'disconnected', 'failed']).optional(),
  }),
  [CLIENT_EVENTS.CALL_STATE_REPORT]: s.object({
    version: versionField,
    activeCallIds: s.array(s.id()).optional(),
    callId: optionalId,
  }),

  [CLIENT_EVENTS.RTC_OFFER]: s.object({
    version: versionField,
    callId: idField,
    sdp: opaqueObject,
  }),
  [CLIENT_EVENTS.RTC_ANSWER]: s.object({
    version: versionField,
    callId: idField,
    sdp: opaqueObject,
  }),
  [CLIENT_EVENTS.RTC_CANDIDATE]: s.object({
    version: versionField,
    callId: idField,
    candidate: opaqueObject,
  }),
  [CLIENT_EVENTS.CALL_MEDIA_STATE]: s.object({
    version: versionField,
    callId: idField,
    mediaState: opaqueObject,
  }),

  [CLIENT_EVENTS.MESSAGE_SEND]: s.object({
    version: versionField,
    recipientId: idField,
    // An attachment message may carry an empty body (the caption is optional),
    // so emptiness is checked by the handler against the message `type` rather
    // than here. Outbound `type` *is* an enum: a client may only ever send a
    // type this protocol version defines.
    body: s.string({ max: MAX_MESSAGE_BODY_LENGTH, trim: true }),
    type: s.enum(KNOWN_MESSAGE_TYPES).optional(),
    attachment: attachmentRecord.optional().nullable(),
    replyTo: s.id().optional().nullable(),
    // Client-generated id for the message, so a send that is replayed from the
    // sender's durable outbox (reconnect, app relaunch) is stored once instead
    // of once per attempt: the store upserts on `{ conversationId, messageId }`.
    // Optional so an older client that does not generate one still works.
    messageId: s.id().optional(),
  }),
  [CLIENT_EVENTS.MESSAGE_DELETE]: s.object({
    version: versionField,
    // The conversation is derived from the pair, so the peer identifies it
    // without the client having to know the server's conversation id.
    peerId: idField,
    messageId: idField,
  }),
  [CLIENT_EVENTS.MESSAGE_REACT]: s.object({
    version: versionField,
    peerId: idField,
    messageId: idField,
    emoji: s.string({ min: 1, max: MAX_REACTION_LENGTH, trim: true }),
    action: s.enum(['add', 'remove']),
  }),
  [CLIENT_EVENTS.MESSAGE_TYPING]: s.object({
    version: versionField,
    recipientId: idField,
    isTyping: s.boolean(),
  }),
});

/**
 * Server → client payloads.
 *
 * These pin the fields the client actually dereferences and leave the rest
 * optional, so a payload the app can safely render is never dropped just
 * because the server started (or stopped) sending an unrelated field.
 */
const SERVER_EVENT_SCHEMAS = Object.freeze({
  [SERVER_EVENTS.PEER_JOINED]: s.object({ id: idField }),
  [SERVER_EVENTS.PEER_LEFT]: s.object({ id: idField }),
  [SERVER_EVENTS.ROOM_FULL]: s.object({ roomId: idField }),

  [SERVER_EVENTS.CALL_INCOMING]: s.object({
    version: inboundVersionField,
    callId: s.id().optional(),
    call: callRecord,
  }),
  [SERVER_EVENTS.CALL_RINGING]: s.object({
    version: inboundVersionField,
    callId: s.id().optional(),
    call: callRecord,
  }),
  [SERVER_EVENTS.CALL_STATE_CHANGED]: s.object({
    version: inboundVersionField,
    callId: optionalId,
    previousStatus: s.string().nullable().optional(),
    status: s.string({ min: 1 }),
    actor: s.string().nullable().optional(),
    reason: s.string().nullable().optional(),
    call: callRecord.optional().nullable(),
  }),

  [SERVER_EVENTS.RTC_OFFER]: s.object({
    version: inboundVersionField,
    callId: idField,
    fromUserId: s.id().optional(),
    sdp: opaqueObject,
  }),
  [SERVER_EVENTS.RTC_ANSWER]: s.object({
    version: inboundVersionField,
    callId: idField,
    fromUserId: s.id().optional(),
    sdp: opaqueObject,
  }),
  [SERVER_EVENTS.RTC_CANDIDATE]: s.object({
    version: inboundVersionField,
    callId: idField,
    fromUserId: s.id().optional(),
    candidate: opaqueObject,
  }),
  [SERVER_EVENTS.CALL_MEDIA_STATE]: s.object({
    version: inboundVersionField,
    callId: idField,
    fromUserId: s.id().optional(),
    mediaState: opaqueObject,
  }),

  [SERVER_EVENTS.MESSAGE_RECEIVED]: s.object({
    version: inboundVersionField,
    conversationId: s.id().optional(),
    message: messageRecord,
  }),
  [SERVER_EVENTS.MESSAGE_DELIVERED]: s.object({
    version: inboundVersionField,
    conversationId: s.id().optional(),
    messageId: s.id().optional(),
    message: messageRecord,
  }),
  [SERVER_EVENTS.MESSAGE_DELETED]: s.object({
    version: inboundVersionField,
    conversationId: s.id().optional(),
    messageId: idField,
    deletedBy: idField,
    // The tombstone left behind by a "delete for everyone", so a client can
    // replace the bubble in place instead of dropping it (and so a reply that
    // quotes it still resolves).
    message: messageRecord.optional().nullable(),
  }),
  [SERVER_EVENTS.MESSAGE_REACTION]: s.object({
    version: inboundVersionField,
    conversationId: s.id().optional(),
    messageId: idField,
    reactions: s.record(s.array(s.id())),
    actorId: idField,
    emoji: s.string({ min: 1 }),
    action: s.enum(['add', 'remove']),
  }),
  [SERVER_EVENTS.MESSAGE_READ]: s.object({
    version: inboundVersionField,
    conversationId: s.id().optional(),
    readerId: idField,
    readAt: s.string({ min: 1 }),
  }),
  [SERVER_EVENTS.MESSAGE_TYPING]: s.object({
    version: inboundVersionField,
    conversationId: s.id().optional(),
    senderId: idField,
    isTyping: s.boolean(),
  }),

  [SERVER_EVENTS.SESSION_INVALID]: s.object({ sessionId: s.string().optional().nullable() }),
  [SERVER_EVENTS.SERVER_DRAINING]: s.object({
    reason: s.string().optional(),
    ts: s.string().optional(),
  }),
  [SERVER_EVENTS.SIGNALING_ERROR]: s.object(
    {
      ok: s.boolean(),
      version: inboundVersionField,
      event: s.string({ min: 1 }),
      error: s.object({ code: s.string({ min: 1 }), message: s.string() }),
    },
    { passthrough: true }
  ),
});

/**
 * `call.accept` / `call.decline` / `call.cancel` / `call.end` are also emitted
 * back to both participants as transition notifications, so they carry a
 * server→client shape in addition to their client→server request shape.
 */
const CALL_TRANSITION_NOTIFICATION = s.object({
  version: versionField,
  callId: idField,
  actor: s.string().nullable().optional(),
  reason: s.string().nullable().optional(),
  call: callRecord,
});

/** Acknowledgement envelope returned for every request-style event. */
const ACK_SCHEMA = s.object(
  {
    ok: s.boolean(),
    version: versionField,
    event: s.string({ min: 1 }),
    error: s
      .object({ code: s.string({ min: 1 }), message: s.string() }, { passthrough: true })
      .optional(),
  },
  { passthrough: true }
);

/**
 * Look up the schema for an event.
 *
 * @param {string} eventName
 * @param {'client'|'server'} [direction] - Which side *sends* the payload.
 * @returns {import('../schema').Schema | null} the schema, or `null` when the
 *   event carries no contract (e.g. transport events).
 */
function getEventSchema(eventName, direction = 'client') {
  const table = /** @type {Record<string, import('../schema').Schema>} */ (
    direction === 'server' ? SERVER_EVENT_SCHEMAS : CLIENT_EVENT_SCHEMAS
  );
  return table[eventName] ?? null;
}

/**
 * Validate an event payload against its contract.
 *
 * Events without a schema are passed through untouched, so adding a new event
 * never silently drops traffic before its contract lands.
 *
 * @param {string} eventName
 * @param {unknown} payload
 * @param {'client'|'server'} [direction] - Which side *sends* the payload.
 * @returns {{ success: true, data: any } | { success: false, error: { message: string, path: string } }}
 */
function parseEventPayload(eventName, payload, direction = 'client') {
  const schema = getEventSchema(eventName, direction);
  if (!schema) {
    return { success: true, data: payload };
  }
  return schema.safeParse(payload);
}

module.exports = {
  ACK_SCHEMA,
  CALL_TRANSITION_NOTIFICATION,
  CLIENT_EVENT_SCHEMAS,
  MAX_MESSAGE_BODY_LENGTH,
  SERVER_EVENT_SCHEMAS,
  getEventSchema,
  parseEventPayload,
};
