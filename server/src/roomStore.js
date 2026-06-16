'use strict';

/**
 * In-memory room store.
 *
 * Encapsulates room membership behind a small interface so the underlying
 * storage (currently a `Map<roomId, Set<socketId>>`) can later be swapped for a
 * distributed backend (e.g. Redis) to enable horizontal scaling, without
 * touching the signaling handlers.
 *
 * @param {object} [options]
 * @param {number} [options.maxRoomSize=2] - Maximum participants per room.
 */
function createRoomStore({ maxRoomSize = 2 } = {}) {
  /** @type {Map<string, Set<string>>} */
  const rooms = new Map();

  /**
   * @param {string} roomId
   * @returns {number} Current number of participants in the room.
   */
  function size(roomId) {
    return rooms.get(roomId)?.size ?? 0;
  }

  /**
   * @param {string} roomId
   * @returns {boolean} Whether the room is at capacity.
   */
  function isFull(roomId) {
    return size(roomId) >= maxRoomSize;
  }

  /**
   * Add a socket to a room.
   *
   * @param {string} roomId
   * @param {string} socketId
   * @returns {boolean} `true` if added, `false` if the room was full.
   */
  function add(roomId, socketId) {
    if (isFull(roomId)) {
      return false;
    }
    let room = rooms.get(roomId);
    if (!room) {
      room = new Set();
      rooms.set(roomId, room);
    }
    room.add(socketId);
    return true;
  }

  /**
   * Remove a socket from a room, cleaning up empty rooms.
   *
   * @param {string} roomId
   * @param {string} socketId
   * @returns {boolean} `true` if the socket was present and removed.
   */
  function remove(roomId, socketId) {
    const room = rooms.get(roomId);
    if (!room) {
      return false;
    }
    const removed = room.delete(socketId);
    if (room.size === 0) {
      rooms.delete(roomId);
    }
    return removed;
  }

  /**
   * @returns {{ activeRooms: number, activeParticipants: number, maxRoomSize: number }}
   */
  function snapshot() {
    let activeParticipants = 0;
    for (const room of rooms.values()) {
      activeParticipants += room.size;
    }
    return { activeRooms: rooms.size, activeParticipants, maxRoomSize };
  }

  return { add, remove, size, isFull, snapshot, maxRoomSize };
}

module.exports = { createRoomStore };
