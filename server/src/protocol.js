'use strict';

/**
 * Shared signaling protocol contract.
 *
 * Centralises the Socket.IO event names and the room-id validation rules so
 * the server (and the mobile client, which mirrors these constants in
 * `mobile/src/signalingEvents.js`) reference a single source of truth instead
 * of scattering duplicated string literals that silently drift apart.
 */

const SIGNALING_EVENTS = Object.freeze({
  // Client → server
  JOIN_ROOM: 'join-room',
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE_CANDIDATE: 'ice-candidate',
  // Server → client
  PEER_JOINED: 'peer-joined',
  PEER_LEFT: 'peer-left',
  ROOM_FULL: 'room-full',
});

// Allow URL-safe room identifiers of a reasonable length. Keeping this strict
// avoids unbounded keys in the in-memory room store and rejects obviously
// malformed input early.
const ROOM_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Validate a room id against the shared pattern.
 *
 * @param {unknown} roomId
 * @returns {boolean}
 */
function isValidRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_PATTERN.test(roomId);
}

module.exports = { SIGNALING_EVENTS, ROOM_ID_PATTERN, isValidRoomId };
