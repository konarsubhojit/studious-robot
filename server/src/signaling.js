'use strict';

const { SIGNALING_EVENTS, isValidRoomId } = require('./protocol');

/**
 * Register Socket.IO signaling handlers on an `io` server instance.
 *
 * Behaviour mirrors the original inline implementation: one room per socket,
 * capacity enforced by the room store, and offer/answer/ICE relayed only to the
 * peer(s) sharing the room. Payloads are validated centrally and invalid
 * messages are counted and dropped.
 *
 * @param {import('socket.io').Server} io
 * @param {object} deps
 * @param {ReturnType<import('./roomStore').createRoomStore>} deps.rooms
 * @param {ReturnType<import('./metrics').createMetrics>} deps.metrics
 * @param {{ info?: Function, warn?: Function }} [deps.logger=console]
 */
function registerSignaling(io, { rooms, metrics, logger = console }) {
  const log = (...args) => logger.info?.(...args);

  io.on('connection', (socket) => {
    metrics.increment('connectionsTotal');
    log(`[signaling] socket connected: ${socket.id}`);

    // Track which room this socket is currently in (one room per socket).
    let currentRoom = null;

    socket.on(SIGNALING_EVENTS.JOIN_ROOM, (roomId) => {
      if (!isValidRoomId(roomId)) {
        metrics.increment('invalidPayloadsTotal');
        return;
      }

      if (rooms.isFull(roomId)) {
        metrics.increment('roomFullRejectionsTotal');
        log(`[signaling] room-full: socket ${socket.id} rejected from room "${roomId}"`);
        socket.emit(SIGNALING_EVENTS.ROOM_FULL, { roomId });
        return;
      }

      // Leave any previous room before joining a new one.
      if (currentRoom !== null) {
        leaveRoom(socket, currentRoom, rooms);
      }

      currentRoom = roomId;
      rooms.add(roomId, socket.id);
      socket.join(roomId);
      metrics.increment('joinsTotal');
      log(`[signaling] join: socket ${socket.id} joined room "${roomId}" (size=${rooms.size(roomId)})`);

      // Notify existing peer that a new participant joined.
      socket.to(roomId).emit(SIGNALING_EVENTS.PEER_JOINED, { id: socket.id });
    });

    socket.on(SIGNALING_EVENTS.OFFER, ({ roomId, sdp } = {}) => {
      if (!isValidRoomId(roomId)) {
        metrics.increment('invalidPayloadsTotal');
        return;
      }
      metrics.increment('offersRelayedTotal');
      log(`[signaling] relay offer: from ${socket.id} in room "${roomId}"`);
      socket.to(roomId).emit(SIGNALING_EVENTS.OFFER, { from: socket.id, sdp });
    });

    socket.on(SIGNALING_EVENTS.ANSWER, ({ roomId, sdp } = {}) => {
      if (!isValidRoomId(roomId)) {
        metrics.increment('invalidPayloadsTotal');
        return;
      }
      metrics.increment('answersRelayedTotal');
      log(`[signaling] relay answer: from ${socket.id} in room "${roomId}"`);
      socket.to(roomId).emit(SIGNALING_EVENTS.ANSWER, { from: socket.id, sdp });
    });

    socket.on(SIGNALING_EVENTS.ICE_CANDIDATE, ({ roomId, candidate } = {}) => {
      if (!isValidRoomId(roomId)) {
        metrics.increment('invalidPayloadsTotal');
        return;
      }
      metrics.increment('iceCandidatesRelayedTotal');
      log(`[signaling] relay ice-candidate: from ${socket.id} in room "${roomId}"`);
      socket.to(roomId).emit(SIGNALING_EVENTS.ICE_CANDIDATE, { from: socket.id, candidate });
    });

    socket.on('disconnect', (reason) => {
      metrics.increment('disconnectionsTotal');
      log(`[signaling] socket disconnected: ${socket.id}, reason=${reason}`);
      if (currentRoom !== null) {
        leaveRoom(socket, currentRoom, rooms);
        currentRoom = null;
      }
    });
  });
}

/**
 * Remove a socket from a room, notify the remaining peer, and clean up the
 * room entry if it becomes empty.
 *
 * @param {import('socket.io').Socket} socket
 * @param {string} roomId
 * @param {ReturnType<import('./roomStore').createRoomStore>} rooms
 */
function leaveRoom(socket, roomId, rooms) {
  const wasPresent = rooms.remove(roomId, socket.id);
  if (!wasPresent) return;

  socket.leave(roomId);

  // Notify remaining peer(s) when the room still has occupants.
  if (rooms.size(roomId) > 0) {
    socket.to(roomId).emit(SIGNALING_EVENTS.PEER_LEFT, { id: socket.id });
  }
}

module.exports = { registerSignaling, leaveRoom };
