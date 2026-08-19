// @ts-check
'use strict';

/**
 * Canonical Socket.IO event names.
 *
 * This module is the only place an event name is spelled out; the mobile hooks
 * and the server handlers both reference these constants, so a rename is a
 * single edit that the type checker/linter can follow instead of a silent
 * cross-process break.
 */

/** Events the client sends to the server. */
const CLIENT_EVENTS = Object.freeze({
  // Legacy room-based signaling (pre call.* protocol).
  JOIN_ROOM: 'join-room',
  ROOM_OFFER: 'offer',
  ROOM_ANSWER: 'answer',
  ROOM_ICE_CANDIDATE: 'ice-candidate',
  // Server-authoritative call lifecycle.
  CALL_INITIATE: 'call.initiate',
  CALL_INCOMING_ACK: 'call.incoming.ack',
  CALL_ACCEPT: 'call.accept',
  CALL_DECLINE: 'call.decline',
  CALL_CANCEL: 'call.cancel',
  CALL_END: 'call.end',
  CALL_STATE_REPORT: 'call.state.report',
  // WebRTC relay + in-call media flags.
  RTC_OFFER: 'rtc.offer',
  RTC_ANSWER: 'rtc.answer',
  RTC_CANDIDATE: 'rtc.candidate',
  CALL_MEDIA_STATE: 'call.media-state',
  // Text chat.
  MESSAGE_SEND: 'message.send',
  MESSAGE_DELETE: 'message.delete',
  MESSAGE_REACT: 'message.react',
  MESSAGE_TYPING: 'message.typing',
});

/** Events the server sends to the client. */
const SERVER_EVENTS = Object.freeze({
  // Legacy room-based signaling.
  PEER_JOINED: 'peer-joined',
  PEER_LEFT: 'peer-left',
  ROOM_FULL: 'room-full',
  ROOM_OFFER: 'offer',
  ROOM_ANSWER: 'answer',
  ROOM_ICE_CANDIDATE: 'ice-candidate',
  // Call lifecycle.
  CALL_INCOMING: 'call.incoming',
  CALL_RINGING: 'call.ringing',
  CALL_STATE_CHANGED: 'call.state_changed',
  // WebRTC relay + in-call media flags.
  RTC_OFFER: 'rtc.offer',
  RTC_ANSWER: 'rtc.answer',
  RTC_CANDIDATE: 'rtc.candidate',
  CALL_MEDIA_STATE: 'call.media-state',
  // Text chat.
  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_DELETED: 'message.deleted',
  MESSAGE_REACTION: 'message.reaction',
  MESSAGE_READ: 'message.read',
  MESSAGE_TYPING: 'message.typing',
  // Connection-level notices.
  SESSION_INVALID: 'session.invalid',
  SERVER_DRAINING: 'server.draining',
  SIGNALING_ERROR: 'signaling.error',
});

/** Socket.IO's own lifecycle events (not part of the application protocol). */
const TRANSPORT_EVENTS = Object.freeze({
  CONNECT: 'connect',
  CONNECT_ERROR: 'connect_error',
  DISCONNECT: 'disconnect',
});

/** Canonical acknowledgement error codes. */
const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad_request',
  BLOCKED: 'blocked',
  FORBIDDEN: 'forbidden',
  INTERNAL_ERROR: 'internal_error',
  NOT_FOUND: 'not_found',
  RATE_LIMITED: 'rate_limited',
  UNAUTHORIZED: 'unauthorized',
  UNSUPPORTED_VERSION: 'unsupported_version',
});

/** Protocol version carried by every `call.*`, `rtc.*` and `message.*` payload. */
const SIGNALING_VERSION = 1;

module.exports = {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  TRANSPORT_EVENTS,
  ERROR_CODES,
  SIGNALING_VERSION,
};
