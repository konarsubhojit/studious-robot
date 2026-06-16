/**
 * Shared signaling protocol contract (client side).
 *
 * Mirrors `server/src/protocol.js` so the client and server reference the same
 * event names instead of duplicating string literals that silently drift apart.
 * The two packages are published independently, so the constants are mirrored
 * rather than imported across the package boundary — keep them in sync.
 */

export const SIGNALING_EVENTS = Object.freeze({
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

export default SIGNALING_EVENTS;
