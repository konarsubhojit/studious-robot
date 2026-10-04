import { s } from '../schema.ts';
import { CLIENT_EVENTS, LEGACY_SIGNALING_VERSION, SERVER_EVENTS, SIGNALING_VERSION, SUPPORTED_SIGNALING_VERSIONS } from './events.ts';
import { KNOWN_MESSAGE_TYPES, MAX_REACTION_LENGTH } from '../messages.ts';

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

const versionField = s.union([
  s.literal(SUPPORTED_SIGNALING_VERSIONS[0]),
  s.literal(SUPPORTED_SIGNALING_VERSIONS[1]),
]);
const legacyVersionField = s.literal(LEGACY_SIGNALING_VERSION);
const currentVersionField = s.literal(SIGNALING_VERSION);
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
 */
export type CallRecord = {
  callId: string;
  mediaType?: 'audio' | 'video';
  callerId: string;
  calleeId: string;
  participants?: CallParticipant[];
  status: string;
  ringTimeoutAt?: string | null;
  endReason?: string | null;
  createdAt?: string;
};
export type CallParticipant = {
  userId: string;
  state: 'invited' | 'ringing' | 'joined' | 'left' | 'declined';
};
const callParticipant = s.object({
  userId: idField,
  state: s.enum(['invited', 'ringing', 'joined', 'left', 'declined']),
});
const callRecord = s.object(
  {
    callId: idField,
    mediaType: s.enum(['audio', 'video']).optional(),
    callerId: s.id().optional(),
    calleeId: s.id().optional(),
    participants: s.array(callParticipant).optional(),
    status: s.string({ min: 1 }).optional(),
  },
  { passthrough: true }
);

/**
 * An attachment stored in object storage and referenced by a message.
 *
 * Only `url` and `mimeType` are required: the optional dimensions/duration are
 * rendering hints the sender supplies when it knows them. `waveform`, when
 * present, is a fixed-length array of amplitudes (0–1) captured at record
 * time for voice notes; older messages and non-voice attachments omit it.
 */
export type AttachmentRecord = {
  url: string;
  mimeType: string;
  sizeBytes?: number;
  name?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  thumbnailUrl?: string | null;
  waveform?: number[] | null;
};

/**
 * The authoritative field list for {@link AttachmentRecord}, kept next to the
 * type so callers that need to compare two attachments field-by-field (e.g.
 * detecting a genuine `messageId` collision vs. a jsonb-round-tripped retry)
 * have one place to source it from instead of hand-copying the field names.
 */
const ATTACHMENT_RECORD_FIELDS = [
  'url',
  'mimeType',
  'sizeBytes',
  'name',
  'width',
  'height',
  'durationMs',
  'thumbnailUrl',
  'waveform',
] as const satisfies readonly (keyof AttachmentRecord)[];

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
    waveform: s
      .array(s.number({ min: 0, max: 1 }))
      .optional()
      .nullable(),
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
 */
export type MessageRecord = {
  messageId: string;
  /** Compose-time retry identity, scoped to sender; distinct from the server id. */
  clientMessageId?: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  body: string;
  type?: string;
  attachment?: AttachmentRecord | null;
  replyTo?: string | null;
  reactions?: Record<string, string[]> | null;
  deletedAt?: string | null;
  createdAt?: string;
};
const messageRecord = s.object(
  {
    messageId: idField,
    clientMessageId: s.id().optional(),
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

/**
 * A server-authoritative snapshot of a group conversation.
 */
export type ConversationRecord = {
  conversationId: string;
  name: string;
  creatorId: string;
  ownerId?: string;
  memberIds: string[];
  membershipVersion: number;
};
const conversationRecord = s.object(
  {
    conversationId: idField,
    name: s.string({ min: 1, max: 128, trim: true }),
    creatorId: idField,
    ownerId: idField.optional(),
    memberIds: s.array(idField),
    membershipVersion: s.number({ min: 1, integer: true }),
  },
  { passthrough: true }
);

/** Client → server payloads. */
const CLIENT_EVENT_SCHEMAS = Object.freeze({
  [CLIENT_EVENTS.CALL_INITIATE]: s.object({
    version: versionField,
    calleeId: idField,
    mediaType: s.enum(['audio', 'video']).optional(),
  }),
  [CLIENT_EVENTS.CALL_INCOMING_ACK]: s.object({
    version: versionField,
    callId: idField,
    deviceId: s.id().optional(),
  }),
  [CLIENT_EVENTS.CALL_ACCEPT]: s.object({ version: versionField, callId: idField }),
  [CLIENT_EVENTS.CALL_DECLINE]: s.object({ version: versionField, callId: idField }),
  [CLIENT_EVENTS.CALL_CANCEL]: s.object({ version: versionField, callId: idField }),
  [CLIENT_EVENTS.CALL_END]: s.object({
    version: versionField,
    callId: idField,
    reason: s.enum(['user_hangup']).optional(),
  }),
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
  [CLIENT_EVENTS.CALL_STATS]: s.object({
    version: versionField,
    callId: idField,
    rttMs: s.number({ min: 0, max: 60_000 }),
    jitterMs: s.number({ min: 0, max: 10_000 }),
    packetLossPercent: s.number({ min: 0, max: 100 }),
    bitrateBps: s.number({ min: 0, max: 1_000_000_000 }),
    codec: s.string({ min: 1, max: 64, trim: true }),
  }),

  [CLIENT_EVENTS.RTC_OFFER]: s.union([
    s.object({ version: legacyVersionField, callId: idField, sdp: opaqueObject }),
    s.object({ version: currentVersionField, callId: idField, peerId: idField, sdp: opaqueObject }),
  ]),
  [CLIENT_EVENTS.RTC_ANSWER]: s.union([
    s.object({ version: legacyVersionField, callId: idField, sdp: opaqueObject }),
    s.object({ version: currentVersionField, callId: idField, peerId: idField, sdp: opaqueObject }),
  ]),
  [CLIENT_EVENTS.RTC_CANDIDATE]: s.object({
    version: legacyVersionField,
    callId: idField,
    candidate: opaqueObject,
  }),
  [CLIENT_EVENTS.RTC_ICE]: s.object({
    version: currentVersionField,
    callId: idField,
    peerId: idField,
    candidate: opaqueObject,
  }),
  [CLIENT_EVENTS.CALL_MEDIA_STATE]: s.object({
    version: versionField,
    callId: idField,
    mediaState: opaqueObject,
  }),

  [CLIENT_EVENTS.MESSAGE_SEND]: s.object({
    version: versionField,
    conversationId: idField.optional(),
    recipientId: idField.optional(),
    // An attachment message may carry an empty body (the caption is optional),
    // so emptiness is checked by the handler against the message `type` rather
    // than here. Outbound `type` *is* an enum: a client may only ever send a
    // type this protocol version defines.
    body: s.string({ max: MAX_MESSAGE_BODY_LENGTH, trim: true }),
    type: s.enum(KNOWN_MESSAGE_TYPES).optional(),
    attachment: attachmentRecord.optional().nullable(),
    replyTo: s.id().optional().nullable(),
    // New sends use a compose-time UUID; messageId remains a legacy retry path.
    clientMessageId: s.id().optional(),
    messageId: s.id().optional(),
  }, { exclusive: [['conversationId', 'recipientId']] }),
  [CLIENT_EVENTS.MESSAGE_DELETE]: s.object({
    version: versionField,
    conversationId: idField.optional(),
    // For a direct conversation the peer identifies the pair-derived id.
    peerId: idField.optional(),
    messageId: idField,
  }, { exclusive: [['conversationId', 'peerId']] }),
  [CLIENT_EVENTS.MESSAGE_REACT]: s.object({
    version: versionField,
    conversationId: idField.optional(),
    peerId: idField.optional(),
    messageId: idField,
    emoji: s.string({ min: 1, max: MAX_REACTION_LENGTH, trim: true }),
    action: s.enum(['add', 'remove']),
  }, { exclusive: [['conversationId', 'peerId']] }),
  [CLIENT_EVENTS.MESSAGE_TYPING]: s.object({
    version: versionField,
    conversationId: idField.optional(),
    recipientId: idField.optional(),
    isTyping: s.boolean(),
  }, { exclusive: [['conversationId', 'recipientId']] }),
  [CLIENT_EVENTS.CONVERSATION_CREATE]: s.object({
    version: versionField,
    name: s.string({ min: 1, max: 128, trim: true }),
    inviteeIds: s.array(idField),
  }),
  [CLIENT_EVENTS.CONVERSATION_UPDATE]: s.object({
    version: versionField,
    conversationId: idField,
    name: s.string({ min: 1, max: 128, trim: true }),
  }),
  [CLIENT_EVENTS.CONVERSATION_MEMBER_ADD]: s.object({
    version: versionField,
    conversationId: idField,
    userIds: s.array(idField),
  }),
  [CLIENT_EVENTS.CONVERSATION_MEMBER_REMOVE]: s.object({
    version: versionField,
    conversationId: idField,
    userId: idField,
  }),
  [CLIENT_EVENTS.CONVERSATION_LEAVE]: s.object({
    version: versionField,
    conversationId: idField,
  }),
  [CLIENT_EVENTS.CONVERSATION_CALL_START]: s.object({
    version: versionField,
    conversationId: idField,
    mediaType: s.enum(['audio', 'video']).optional(),
  }),
  [CLIENT_EVENTS.CONVERSATION_CALL_ACCEPT]: s.object({
    version: versionField,
    callId: idField,
  }),
  [CLIENT_EVENTS.CONVERSATION_CALL_DECLINE]: s.object({
    version: versionField,
    callId: idField,
  }),
  [CLIENT_EVENTS.CONVERSATION_CALL_LEAVE]: s.object({
    version: versionField,
    callId: idField,
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
  [SERVER_EVENTS.CALL_INCOMING]: s.object({
    version: inboundVersionField,
    callId: s.id().optional(),
    call: callRecord,
  }),
  [SERVER_EVENTS.CALL_RINGING]: s.object({
    version: inboundVersionField,
    callId: s.id().optional(),
    call: callRecord,
    // How the callee is being reached: a device that can ring now, or one that
    // has to be woken by a push first.
    delivery: s.enum(['ringing', 'push']).optional(),
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

  [SERVER_EVENTS.CALL_PARTICIPANT_JOINED]: s.object({
    version: currentVersionField,
    callId: idField,
    participantId: idField,
    state: s.literal('joined'),
  }),
  [SERVER_EVENTS.CALL_PARTICIPANT_LEFT]: s.object({
    version: currentVersionField,
    callId: idField,
    participantId: idField,
    state: s.enum(['left', 'declined']),
  }),
  [SERVER_EVENTS.RTC_OFFER]: s.union([
    s.object({ version: legacyVersionField.optional(), callId: idField, fromUserId: s.id().optional(), sdp: opaqueObject }),
    s.object({ version: currentVersionField, callId: idField, peerId: idField, fromUserId: s.id().optional(), sdp: opaqueObject }),
  ]),
  [SERVER_EVENTS.RTC_ANSWER]: s.union([
    s.object({ version: legacyVersionField.optional(), callId: idField, fromUserId: s.id().optional(), sdp: opaqueObject }),
    s.object({ version: currentVersionField, callId: idField, peerId: idField, fromUserId: s.id().optional(), sdp: opaqueObject }),
  ]),
  [SERVER_EVENTS.RTC_CANDIDATE]: s.object({
    version: legacyVersionField.optional(),
    callId: idField,
    fromUserId: s.id().optional(),
    candidate: opaqueObject,
  }),
  [SERVER_EVENTS.RTC_ICE]: s.object({
    version: currentVersionField,
    callId: idField,
    peerId: idField,
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
  [SERVER_EVENTS.CONVERSATION_UPDATED]: s.object({
    version: inboundVersionField,
    conversation: conversationRecord,
    updatedBy: idField,
  }),
  [SERVER_EVENTS.CONVERSATION_CALL_UPDATED]: s.object({
    version: inboundVersionField,
    conversationId: idField,
    callId: idField,
    call: s.object(
      {
        callId: idField,
        conversationId: idField,
        initiatorId: idField,
        mediaType: s.enum(['audio', 'video']),
        status: s.enum(['ringing', 'active', 'ended']),
        stateVersion: s.number({ min: 1, integer: true }),
        ringTimeoutAt: s.string().optional().nullable(),
      },
      { passthrough: true }
    ),
    participants: s.array(s.object({
      callId: idField,
      userId: idField,
      status: s.enum(['ringing', 'accepted', 'declined', 'left']),
      invitedAt: s.string(),
      acceptedAt: s.string().optional().nullable(),
      leftAt: s.string().optional().nullable(),
    }, { passthrough: true })),
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
 * @param direction - Which side *sends* the payload.
 * @returns the schema, or `null` when the
 *   event carries no contract (e.g. transport events).
 */
function getEventSchema(eventName: string, direction: 'client' | 'server' = 'client'): import('../schema.ts').Schema | null {
  const table = ((direction === 'server' ? SERVER_EVENT_SCHEMAS : CLIENT_EVENT_SCHEMAS) as Record<string, import('../schema.ts').Schema>);
  return table[eventName] ?? null;
}

/**
 * Validate an event payload against its contract.
 *
 * Events without a schema are passed through untouched, so adding a new event
 * never silently drops traffic before its contract lands.
 *
 * @param direction - Which side *sends* the payload.
 */
function parseEventPayload(eventName: string, payload: unknown, direction: 'client' | 'server' = 'client'): { success: true; data: any; } | { success: false; error: { message: string; path: string; }; } {
  const schema = getEventSchema(eventName, direction);
  if (!schema) {
    return { success: true, data: payload };
  }
  return schema.safeParse(payload);
}

export {
  ACK_SCHEMA,
  ATTACHMENT_RECORD_FIELDS,
  CALL_TRANSITION_NOTIFICATION,
  CLIENT_EVENT_SCHEMAS,
  MAX_MESSAGE_BODY_LENGTH,
  SERVER_EVENT_SCHEMAS,
  getEventSchema,
  parseEventPayload,
};
