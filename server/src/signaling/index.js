'use strict';

const { MAX_ROOM_SIZE } = require('../config');
const { normaliseId } = require('../lib/normalize');
const { isBlocked } = require('../security');
const { resolveSocketIdentity } = require('../lib/auth');
const {
  ensurePresenceRecord,
  upsertDevice,
  addConnection,
  removeConnection,
  userRoom,
} = require('../lib/state');
const { createCallRecord } = require('../domain/calls');
const {
  notifyCallCreated,
  markIncomingCallAcknowledged,
  notifyRingingCallsForDisconnectedDevice,
} = require('../domain/notifications');
const { handleSocketCallTransition, handleRtcRelay } = require('./callHandlers');
const { registerMessageHandlers } = require('./messageHandlers');
const {
  requireSocketSession,
  validateSignalingVersion,
  acknowledgeSuccess,
  acknowledgeError,
} = require('./ack');
const { isPlainObject } = require('../lib/normalize');
const { verboseLog } = require('../lib/verbose');

/**
 * Remove `socket` from a legacy signaling room, tidying up the room set and
 * notifying any remaining peer.
 *
 * @param {import('socket.io').Socket} socket
 * @param {string} roomId
 * @param {Map<string, Set<string>>} rooms
 */
function leaveRoom(socket, roomId, rooms) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.delete(socket.id);
  socket.leave(roomId);
  console.log(`[signaling] leave: socket ${socket.id} left room "${roomId}" (size=${room.size})`);

  if (room.size === 0) {
    rooms.delete(roomId);
  } else {
    // Notify remaining peer(s).
    socket.to(roomId).emit('peer-left', { id: socket.id });
  }
}

/**
 * Wire up all Socket.IO connection and event handlers.
 *
 * @param {import('socket.io').Server} io
 * @param {{ state: object, ringingTimeoutMs: number }} ctx
 */
function registerSocketHandlers(io, { state, ringingTimeoutMs }) {
  io.on('connection', (socket) => {
    // Reject connections that race in after shutdown has begun: tell the client
    // this instance is draining so it can reconnect elsewhere, then disconnect.
    if (state.draining) {
      socket.emit('server.draining', { reason: 'shutdown', ts: new Date().toISOString() });
      socket.disconnect(true);
      return;
    }

    const identity = resolveSocketIdentity(socket, state.sessions);
    socket.data.identity = identity;
    ensurePresenceRecord(state, identity.userId);
    upsertDevice(state, identity);
    addConnection(state, {
      userId: identity.userId,
      socketId: socket.id,
      deviceId: identity.deviceId,
      sessionId: identity.sessionId,
      connectedAt: new Date().toISOString(),
    });
    // Join a per-user room so call/RTC notifications can be addressed to the
    // user regardless of which instance their socket(s) live on (the Socket.IO
    // Redis adapter fans the emit out across instances).
    socket.join(userRoom(identity.userId));

    // The handshake presented a sessionId that no longer resolves to a live
    // session (server restart dropped the in-memory table, TTL expiry, …):
    // the connection still succeeds but as a guest. Tell the client
    // explicitly so it can re-mint a session and reconnect, instead of only
    // discovering the downgrade indirectly when an authenticated action like
    // `call.initiate` is later rejected with `unauthorized`.
    if (identity.sessionDowngraded) {
      socket.emit('session.invalid', { sessionId: identity.presentedSessionId });
      console.log(
        `[signaling] socket ${socket.id} presented stale sessionId=${identity.presentedSessionId}; downgraded to guest user=${identity.userId}`
      );
    }

    console.log(
      `[signaling] socket connected: ${socket.id} user=${identity.userId} device=${identity.deviceId}`
    );
    verboseLog('socket', 'connected', {
      socketId: socket.id,
      userId: identity.userId,
      deviceId: identity.deviceId,
      activeUserSockets: state.userConnections.get(identity.userId)?.size ?? 0,
    });
    socket.onAny((eventName, payload) => {
      verboseLog('socket', 'event.in', {
        socketId: socket.id,
        userId: identity.userId,
        eventName,
        payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
        callId: payload?.callId ?? null,
        version: payload?.version ?? null,
      });
    });
    // Track which room this socket is currently in (one room per socket).
    let currentRoom = null;

    socket.on('join-room', (roomId) => {
      if (!socket.data.identity.sessionId) return;
      if (typeof roomId !== 'string' || roomId.length === 0) return;

      if (!state.rooms.has(roomId)) {
        state.rooms.set(roomId, new Set());
      }
      const room = state.rooms.get(roomId);

      if (room.size >= MAX_ROOM_SIZE) {
        console.log(
          `[signaling] room-full: socket ${socket.id} rejected from room "${roomId}" (size=${room.size})`
        );
        socket.emit('room-full', { roomId });
        return;
      }

      // Leave any previous room before joining a new one.
      if (currentRoom !== null) {
        leaveRoom(socket, currentRoom, state.rooms);
      }

      currentRoom = roomId;
      room.add(socket.id);
      socket.join(roomId);
      console.log(
        `[signaling] join: socket ${socket.id} joined room "${roomId}" (size=${room.size})`
      );

      // Notify existing peer that a new participant joined.
      socket.to(roomId).emit('peer-joined', { id: socket.id });
    });

    socket.on('offer', ({ roomId, sdp } = {}) => {
      if (!socket.data.identity.sessionId || roomId !== currentRoom) return;
      console.log(`[signaling] relay offer: from ${socket.id} in room "${roomId}"`);
      socket.to(roomId).emit('offer', { from: socket.id, sdp });
    });

    socket.on('answer', ({ roomId, sdp } = {}) => {
      if (!socket.data.identity.sessionId || roomId !== currentRoom) return;
      console.log(`[signaling] relay answer: from ${socket.id} in room "${roomId}"`);
      socket.to(roomId).emit('answer', { from: socket.id, sdp });
    });

    socket.on('ice-candidate', ({ roomId, candidate } = {}) => {
      if (!socket.data.identity.sessionId || roomId !== currentRoom) return;
      console.log(`[signaling] relay ice-candidate: from ${socket.id} in room "${roomId}"`);
      socket.to(roomId).emit('ice-candidate', { from: socket.id, candidate });
    });

    socket.on('call.initiate', (payload = {}, ack) => {
      if (!requireSocketSession(socket, ack, 'call.initiate')) {
        return;
      }
      if (!validateSignalingVersion(socket, payload, ack, 'call.initiate')) {
        return;
      }

      const calleeId = normaliseId(payload.calleeId);
      if (!calleeId) {
        acknowledgeError(
          socket,
          ack,
          'call.initiate',
          'bad_request',
          'calleeId is required',
          state
        );
        return;
      }
      if (calleeId === socket.data.identity.userId) {
        acknowledgeError(
          socket,
          ack,
          'call.initiate',
          'bad_request',
          'cannot call yourself',
          state
        );
        return;
      }

      // Blocklist: reject when the callee has blocked this caller.
      if (isBlocked(state.blocks, calleeId, socket.data.identity.userId)) {
        state.auditLog.record({
          event: 'call.blocked',
          actor: socket.data.identity.userId,
          target: calleeId,
          outcome: 'rejected',
          details: { via: 'websocket' },
        });
        console.log(
          `[security] call.blocked callerId=${socket.data.identity.userId} calleeId=${calleeId} via=websocket`
        );
        acknowledgeError(
          socket,
          ack,
          'call.initiate',
          'blocked',
          'you are blocked by this user',
          state
        );
        return;
      }

      // Rate limit: cap call initiations per user per window.
      const rateCheck = state.callInitRateLimiter.check(socket.data.identity.userId);
      if (!rateCheck.allowed) {
        state.auditLog.record({
          event: 'call.rate_limited',
          actor: socket.data.identity.userId,
          outcome: 'rejected',
          details: { via: 'websocket' },
        });
        console.log(
          `[security] call.rate_limited userId=${socket.data.identity.userId} via=websocket`
        );
        acknowledgeError(
          socket,
          ack,
          'call.initiate',
          'rate_limited',
          'too many call attempts',
          state
        );
        return;
      }

      const call = createCallRecord(state, {
        callerId: socket.data.identity.userId,
        calleeId,
        ringingTimeoutMs,
      });
      notifyCallCreated(io, state, call);
      acknowledgeSuccess(socket, ack, 'call.initiate', { call });
    });

    socket.on('call.incoming.ack', (payload = {}, ack) => {
      if (!requireSocketSession(socket, ack, 'call.incoming.ack')) {
        return;
      }
      if (!validateSignalingVersion(socket, payload, ack, 'call.incoming.ack')) {
        return;
      }
      const callId = normaliseId(payload.callId);
      if (!callId) {
        acknowledgeError(
          socket,
          ack,
          'call.incoming.ack',
          'bad_request',
          'callId is required',
          state
        );
        return;
      }
      const identity = socket.data.identity;
      const deviceId = normaliseId(payload.deviceId) || identity.deviceId;
      markIncomingCallAcknowledged(state, callId, deviceId);
      acknowledgeSuccess(socket, ack, 'call.incoming.ack', { callId, deviceId });
    });

    socket.on('call.accept', (payload = {}, ack) => {
      handleSocketCallTransition(socket, ack, payload, {
        state,
        io,
        eventName: 'call.accept',
        nextStatus: 'accepted',
        authorize: (call, userId) =>
          call.calleeId === userId ? null : 'only the callee can accept a call',
      });
    });

    socket.on('call.decline', (payload = {}, ack) => {
      handleSocketCallTransition(socket, ack, payload, {
        state,
        io,
        eventName: 'call.decline',
        nextStatus: 'declined',
        reason: 'declined',
        authorize: (call, userId) =>
          call.calleeId === userId ? null : 'only the callee can decline a call',
      });
    });

    socket.on('call.cancel', (payload = {}, ack) => {
      handleSocketCallTransition(socket, ack, payload, {
        state,
        io,
        eventName: 'call.cancel',
        nextStatus: 'ended',
        reason: 'cancelled',
        authorize: (call, userId) =>
          call.callerId === userId ? null : 'only the caller can cancel a call',
      });
    });

    socket.on('call.end', (payload = {}, ack) => {
      handleSocketCallTransition(socket, ack, payload, {
        state,
        io,
        eventName: 'call.end',
        nextStatus: 'ended',
        reason: 'ended',
        authorize: (call, userId) =>
          call.callerId === userId || call.calleeId === userId
            ? null
            : 'not a participant in this call',
      });
    });

    socket.on('rtc.offer', (payload = {}, ack) => {
      handleRtcRelay(socket, ack, payload, {
        state,
        io,
        eventName: 'rtc.offer',
        dataKey: 'sdp',
        validateData: (value) => isPlainObject(value),
      });
    });

    socket.on('rtc.answer', (payload = {}, ack) => {
      handleRtcRelay(socket, ack, payload, {
        state,
        io,
        eventName: 'rtc.answer',
        dataKey: 'sdp',
        validateData: (value) => isPlainObject(value),
      });
    });

    socket.on('rtc.candidate', (payload = {}, ack) => {
      handleRtcRelay(socket, ack, payload, {
        state,
        io,
        eventName: 'rtc.candidate',
        dataKey: 'candidate',
        validateData: (value) => isPlainObject(value),
      });
    });

    // Best-effort relay of local media-state flags (currently just screen
    // sharing) to the other participant, so the UI can show a "X is
    // presenting" indicator on the remote side.  Reuses the generic RTC relay:
    // authorization/rate-limiting/call-state checks are identical to
    // rtc.offer/answer/candidate.
    socket.on('call.media-state', (payload = {}, ack) => {
      handleRtcRelay(socket, ack, payload, {
        state,
        io,
        eventName: 'call.media-state',
        dataKey: 'mediaState',
        validateData: (value) => isPlainObject(value),
      });
    });

    registerMessageHandlers(socket, { io, state });

    socket.on('disconnect', (reason) => {
      const identity = socket.data.identity;
      if (currentRoom !== null) {
        leaveRoom(socket, currentRoom, state.rooms);
        currentRoom = null;
      }
      removeConnection(state, identity?.userId, socket.id);
      const remainingConnections = identity?.userId
        ? state.userConnections.get(identity.userId)?.size ?? 0
        : 0;
      console.log(
        `[signaling] socket disconnected: ${socket.id}, reason=${reason}` +
          (identity ? ` user=${identity.userId} device=${identity.deviceId}` : '') +
          ` remainingUserSockets=${remainingConnections}`
      );
      verboseLog('socket', 'disconnected', {
        socketId: socket.id,
        reason,
        userId: identity?.userId ?? null,
        deviceId: identity?.deviceId ?? null,
        remainingUserSockets: remainingConnections,
      });
      notifyRingingCallsForDisconnectedDevice(state, identity?.userId, identity?.deviceId);
    });
  });
}

module.exports = {
  registerSocketHandlers,
  leaveRoom,
};
