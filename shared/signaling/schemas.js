'use strict';

const { s } = require('../schema');
const { CLIENT_EVENTS, SERVER_EVENTS, SIGNALING_VERSION } = require('./events');

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
const idField = s.id();
const optionalId = s.id().optional().nullable();

/** SDP / ICE / media-state blobs: shape is owned by WebRTC, keep them intact. */
const opaqueObject = s.object({}, { passthrough: true });

/**
 * A persisted call row as broadcast to participants.
 *
 * @typedef {object} CallRecord
 * @property {string} callId
 * @property {string} callerId
 * @property {string} calleeId
 * @property {string} status
 */
const callRecord = s.object(
  {
    callId: idField,
    callerId: idField,
    calleeId: idField,
    status: s.string({ min: 1 }),
  },
  { passthrough: true }
);

/**
 * A persisted chat message row.
 *
 * @typedef {object} MessageRecord
 * @property {string} messageId
 * @property {string} conversationId
 * @property {string} senderId
 * @property {string} recipientId
 * @property {string} body
 */
const messageRecord = s.object(
  {
    messageId: idField,
    conversationId: idField,
    senderId: idField,
    recipientId: idField,
    body: s.string(),
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
    mediaState: s.object({ isScreenSharing: s.boolean().optional() }, { passthrough: true }),
  }),

  [CLIENT_EVENTS.MESSAGE_SEND]: s.object({
    version: versionField,
    recipientId: idField,
    body: s.string({ min: 1, max: MAX_MESSAGE_BODY_LENGTH, trim: true }),
  }),
  [CLIENT_EVENTS.MESSAGE_TYPING]: s.object({
    version: versionField,
    recipientId: idField,
    isTyping: s.boolean(),
  }),
});

/** Server → client payloads. */
const SERVER_EVENT_SCHEMAS = Object.freeze({
  [SERVER_EVENTS.PEER_JOINED]: s.object({ id: idField }),
  [SERVER_EVENTS.PEER_LEFT]: s.object({ id: idField }),
  [SERVER_EVENTS.ROOM_FULL]: s.object({ roomId: idField }),

  [SERVER_EVENTS.CALL_INCOMING]: s.object({
    version: versionField,
    callId: s.id().optional(),
    call: callRecord,
  }),
  [SERVER_EVENTS.CALL_RINGING]: s.object({
    version: versionField,
    callId: s.id().optional(),
    call: callRecord,
  }),
  [SERVER_EVENTS.CALL_STATE_CHANGED]: s.object({
    version: versionField,
    callId: optionalId,
    previousStatus: s.string().nullable().optional(),
    status: s.string({ min: 1 }),
    actor: s.string().nullable().optional(),
    reason: s.string().nullable().optional(),
    call: callRecord.optional().nullable(),
  }),

  [SERVER_EVENTS.RTC_OFFER]: s.object({
    version: versionField,
    callId: idField,
    fromUserId: s.id().optional(),
    sdp: opaqueObject,
  }),
  [SERVER_EVENTS.RTC_ANSWER]: s.object({
    version: versionField,
    callId: idField,
    fromUserId: s.id().optional(),
    sdp: opaqueObject,
  }),
  [SERVER_EVENTS.RTC_CANDIDATE]: s.object({
    version: versionField,
    callId: idField,
    fromUserId: s.id().optional(),
    candidate: opaqueObject,
  }),
  [SERVER_EVENTS.CALL_MEDIA_STATE]: s.object({
    version: versionField,
    callId: idField,
    fromUserId: s.id().optional(),
    mediaState: s.object({ isScreenSharing: s.boolean().optional() }, { passthrough: true }),
  }),

  [SERVER_EVENTS.MESSAGE_RECEIVED]: s.object({
    version: versionField,
    conversationId: idField,
    message: messageRecord,
  }),
  [SERVER_EVENTS.MESSAGE_DELIVERED]: s.object({
    version: versionField,
    conversationId: idField,
    messageId: idField,
    message: messageRecord,
  }),
  [SERVER_EVENTS.MESSAGE_READ]: s.object({
    version: versionField,
    conversationId: idField,
    readerId: idField,
    readAt: s.string({ min: 1 }),
  }),
  [SERVER_EVENTS.MESSAGE_TYPING]: s.object({
    version: versionField,
    conversationId: idField,
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
      version: versionField,
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
 * @returns {object | null} the schema, or `null` when the event carries no
 *   contract (e.g. transport events).
 */
function getEventSchema(eventName, direction = 'client') {
  const table = direction === 'server' ? SERVER_EVENT_SCHEMAS : CLIENT_EVENT_SCHEMAS;
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
