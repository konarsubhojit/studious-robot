import { MAX_ROOM_SIZE, DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS } from '../config.ts';
import { normaliseId } from '../lib/normalize.ts';
import { isBlocked } from '../security.ts';
import { resolveSocketIdentity } from '../lib/auth.ts';
import { ensurePresenceRecord, upsertDevice, addConnection, removeConnection, userRoom } from '../lib/state.ts';
import { createCallRecord, endCallsForDisconnectedParticipant, reconcileClientCallState, describeActiveCallsForUser } from '../domain/calls.ts';
import { notifyCallCreated, notifyCallTransition, markIncomingCallAcknowledged, notifyRingingCallsForDisconnectedDevice } from '../domain/notifications.ts';
import { handleSocketCallTransition, handleRtcRelay, handleCallConnected } from './callHandlers.ts';
import { registerMessageHandlers } from './messageHandlers.ts';
import { requireSocketSession, validateSignalingVersion, parseInboundPayload, acknowledgeSuccess, acknowledgeError } from './ack.ts';
import { CLIENT_EVENTS, SERVER_EVENTS, ERROR_CODES, TRANSPORT_EVENTS } from '../../../shared/index.ts';
import { verboseLog } from '../lib/verbose.ts';

/**
 * Remove `socket` from a legacy signaling room, tidying up the room set and
 * notifying any remaining peer.
 */
function leaveRoom(socket: import('socket.io').Socket, roomId: string, rooms: Map<string, Set<string>>) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.delete(socket.id);
  // `join`/`leave` are synchronous with the in-memory adapter and return a
  // promise only with the Redis one; the room bookkeeping above is what this
  // code depends on, so the result is deliberately not awaited.
  void socket.leave(roomId);
  console.log(`[signaling] leave: socket ${socket.id} left room "${roomId}" (size=${room.size})`);

  if (room.size === 0) {
    rooms.delete(roomId);
  } else {
    // Notify remaining peer(s).
    socket.to(roomId).emit(SERVER_EVENTS.PEER_LEFT, { id: socket.id });
  }
}

/**
 * After a grace period (long enough for an ordinary reconnect), end any
 * in-progress call of `userId` whose participants have all lost their sockets.
 *
 * Without this, a call that reaches `accepted` / `connecting_media` and then
 * loses both peers stays non-terminal forever and permanently marks both
 * participants busy.
 */
function scheduleParticipantDisconnectCleanup(io: import('socket.io').Server, state: import('../stores/contracts.ts').ServerState, userId: string | undefined, graceMs: number) {
  if (!userId) return;
  const timer = setTimeout(() => {
    endCallsForDisconnectedParticipant(state, userId, {
      onTransition: (call, previousStatus, reason) =>
        notifyCallTransition(io, state, call, { previousStatus, actor: null, reason }),
    });
  }, graceMs);
  // Never keep the process (or a test run) alive just for this cleanup.
  timer.unref?.();
}

/**
 * Emit the callId ↔ correlationId link so a call can be followed from the
 * client log (which stamps every event with the same correlation id) into the
 * server log, where subsequent lines are keyed by callId.
 */
function logCallCorrelation(socket: import('socket.io').Socket, callId: string, eventName: string) {
  const correlationId = socket.data.identity?.correlationId;
  if (!callId || !correlationId) return;
  console.log(
    `[signaling] call.correlation callId=${callId} correlationId=${correlationId}` +
      ` userId=${socket.data.identity.userId} event=${eventName}`
  );
}

/**
 * Wire up all Socket.IO connection and event handlers.
 *
 * @param ctx
 */
function registerSocketHandlers(
  io: import('socket.io').Server,
  { state, ringingTimeoutMs, participantDisconnectGraceMs = DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS }: {
      state: import('../stores/contracts.ts').ServerState;
      ringingTimeoutMs: number;
      participantDisconnectGraceMs?: number;
  }
) {
  io.on('connection', (socket) => {
    // Reject connections that race in after shutdown has begun: tell the client
    // this instance is draining so it can reconnect elsewhere, then disconnect.
    if (state.draining) {
      socket.emit(SERVER_EVENTS.SERVER_DRAINING, {
        reason: 'shutdown',
        ts: new Date().toISOString(),
      });
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
    void socket.join(userRoom(identity.userId));

    // The handshake presented a sessionId that no longer resolves to a live
    // session (server restart dropped the in-memory table, TTL expiry, …):
    // the connection still succeeds but as a guest. Tell the client
    // explicitly so it can re-mint a session and reconnect, instead of only
    // discovering the downgrade indirectly when an authenticated action like
    // `call.initiate` is later rejected with `unauthorized`.
    if (identity.sessionDowngraded) {
      socket.emit(SERVER_EVENTS.SESSION_INVALID, { sessionId: identity.presentedSessionId });
      console.log(
        `[signaling] socket ${socket.id} presented stale sessionId=${identity.presentedSessionId}; downgraded to guest user=${identity.userId}`
      );
    }

    // The client's per-session correlation id is echoed into the server log so
    // a failed call can be traced from the device log to the server log.
    console.log(
      `[signaling] socket connected: ${socket.id} user=${identity.userId} device=${identity.deviceId}` +
        ` correlationId=${identity.correlationId ?? 'none'}`
    );
    verboseLog('socket', 'connected', {
      socketId: socket.id,
      userId: identity.userId,
      deviceId: identity.deviceId,
      correlationId: identity.correlationId,
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
    let currentRoom: string | null = null;

    socket.on(CLIENT_EVENTS.JOIN_ROOM, (roomId) => {
      if (!socket.data.identity.sessionId) return;
      if (typeof roomId !== 'string' || roomId.length === 0) return;

      let room = state.rooms.get(roomId);
      if (!room) {
        room = new Set();
        state.rooms.set(roomId, room);
      }

      if (room.size >= MAX_ROOM_SIZE) {
        console.log(
          `[signaling] room-full: socket ${socket.id} rejected from room "${roomId}" (size=${room.size})`
        );
        socket.emit(SERVER_EVENTS.ROOM_FULL, { roomId });
        return;
      }

      // Leave any previous room before joining a new one.
      if (currentRoom !== null) {
        leaveRoom(socket, currentRoom, state.rooms);
      }

      currentRoom = roomId;
      room.add(socket.id);
      void socket.join(roomId);
      console.log(
        `[signaling] join: socket ${socket.id} joined room "${roomId}" (size=${room.size})`
      );

      // Notify existing peer that a new participant joined.
      socket.to(roomId).emit(SERVER_EVENTS.PEER_JOINED, { id: socket.id });
    });

    socket.on(CLIENT_EVENTS.ROOM_OFFER, (payload = {}) => {
      if (!socket.data.identity.sessionId || payload?.roomId !== currentRoom) return;
      const parsed = parseInboundPayload(socket, undefined, CLIENT_EVENTS.ROOM_OFFER, payload);
      if (!parsed) return;
      console.log(`[signaling] relay offer: from ${socket.id} in room "${parsed.roomId}"`);
      socket
        .to(parsed.roomId)
        .emit(SERVER_EVENTS.ROOM_OFFER, { from: socket.id, sdp: parsed.sdp });
    });

    socket.on(CLIENT_EVENTS.ROOM_ANSWER, (payload = {}) => {
      if (!socket.data.identity.sessionId || payload?.roomId !== currentRoom) return;
      const parsed = parseInboundPayload(socket, undefined, CLIENT_EVENTS.ROOM_ANSWER, payload);
      if (!parsed) return;
      console.log(`[signaling] relay answer: from ${socket.id} in room "${parsed.roomId}"`);
      socket
        .to(parsed.roomId)
        .emit(SERVER_EVENTS.ROOM_ANSWER, { from: socket.id, sdp: parsed.sdp });
    });

    socket.on(CLIENT_EVENTS.ROOM_ICE_CANDIDATE, (payload = {}) => {
      if (!socket.data.identity.sessionId || payload?.roomId !== currentRoom) return;
      const parsed = parseInboundPayload(
        socket,
        undefined,
        CLIENT_EVENTS.ROOM_ICE_CANDIDATE,
        payload
      );
      if (!parsed) return;
      console.log(`[signaling] relay ice-candidate: from ${socket.id} in room "${parsed.roomId}"`);
      socket
        .to(parsed.roomId)
        .emit(SERVER_EVENTS.ROOM_ICE_CANDIDATE, { from: socket.id, candidate: parsed.candidate });
    });

    socket.on(CLIENT_EVENTS.CALL_INITIATE, (payload = {}, ack) => {
      if (!requireSocketSession(socket, ack, CLIENT_EVENTS.CALL_INITIATE)) {
        return;
      }
      if (!validateSignalingVersion(socket, payload, ack, CLIENT_EVENTS.CALL_INITIATE)) {
        return;
      }
      const parsed = parseInboundPayload(
        socket,
        ack,
        CLIENT_EVENTS.CALL_INITIATE,
        payload,
        state
      );
      if (!parsed) return;

      // `call.initiate` is schema-validated above, so `calleeId` is a
      // non-empty id by the time it reaches here.
      const calleeId = (normaliseId(parsed.calleeId) as string);
      if (calleeId === socket.data.identity.userId) {
        acknowledgeError(
          socket,
          ack,
          CLIENT_EVENTS.CALL_INITIATE,
          ERROR_CODES.BAD_REQUEST,
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
          CLIENT_EVENTS.CALL_INITIATE,
          ERROR_CODES.BLOCKED,
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
          CLIENT_EVENTS.CALL_INITIATE,
          ERROR_CODES.RATE_LIMITED,
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
      logCallCorrelation(socket, call.callId, CLIENT_EVENTS.CALL_INITIATE);
      notifyCallCreated(io, state, call);
      acknowledgeSuccess(socket, ack, CLIENT_EVENTS.CALL_INITIATE, { call });
    });

    socket.on(CLIENT_EVENTS.CALL_INCOMING_ACK, (payload = {}, ack) => {
      if (!requireSocketSession(socket, ack, CLIENT_EVENTS.CALL_INCOMING_ACK)) {
        return;
      }
      if (!validateSignalingVersion(socket, payload, ack, CLIENT_EVENTS.CALL_INCOMING_ACK)) {
        return;
      }
      const parsed = parseInboundPayload(
        socket,
        ack,
        CLIENT_EVENTS.CALL_INCOMING_ACK,
        payload,
        state
      );
      if (!parsed) return;

      const identity = socket.data.identity;
      const callId = parsed.callId;
      const deviceId = normaliseId(parsed.deviceId) || identity.deviceId;
      markIncomingCallAcknowledged(state, callId, deviceId);
      logCallCorrelation(socket, callId, CLIENT_EVENTS.CALL_INCOMING_ACK);
      acknowledgeSuccess(socket, ack, CLIENT_EVENTS.CALL_INCOMING_ACK, { callId, deviceId });
    });

    socket.on(CLIENT_EVENTS.CALL_ACCEPT, (payload = {}, ack) => {
      handleSocketCallTransition(socket, ack, payload, {
        state,
        io,
        eventName: CLIENT_EVENTS.CALL_ACCEPT,
        nextStatus: 'accepted',
        authorize: (call, userId) =>
          call.calleeId === userId ? null : 'only the callee can accept a call',
      });
    });

    socket.on(CLIENT_EVENTS.CALL_DECLINE, (payload = {}, ack) => {
      handleSocketCallTransition(socket, ack, payload, {
        state,
        io,
        eventName: CLIENT_EVENTS.CALL_DECLINE,
        nextStatus: 'declined',
        reason: 'declined',
        authorize: (call, userId) =>
          call.calleeId === userId ? null : 'only the callee can decline a call',
      });
    });

    socket.on(CLIENT_EVENTS.CALL_CANCEL, (payload = {}, ack) => {
      handleSocketCallTransition(socket, ack, payload, {
        state,
        io,
        eventName: CLIENT_EVENTS.CALL_CANCEL,
        nextStatus: 'ended',
        reason: 'cancelled',
        authorize: (call, userId) =>
          call.callerId === userId ? null : 'only the caller can cancel a call',
      });
    });

    socket.on(CLIENT_EVENTS.CALL_END, (payload = {}, ack) => {
      handleSocketCallTransition(socket, ack, payload, {
        state,
        io,
        eventName: CLIENT_EVENTS.CALL_END,
        nextStatus: 'ended',
        reason: 'ended',
        authorize: (call, userId) =>
          call.callerId === userId || call.calleeId === userId
            ? null
            : 'not a participant in this call',
      });
    });

    // Media established (or irrecoverably failed) on this device. This is the
    // only signal that advances a call out of `connecting_media`, so without
    // it every answered call is force-ended by the stale-call sweep.
    socket.on(CLIENT_EVENTS.CALL_CONNECTED, (payload = {}, ack) => {
      handleCallConnected(socket, ack, payload, { state, io });
    });

    socket.on(CLIENT_EVENTS.RTC_OFFER, (payload = {}, ack) => {
      handleRtcRelay(socket, ack, payload, {
        state,
        io,
        eventName: CLIENT_EVENTS.RTC_OFFER,
        dataKey: 'sdp',
      });
    });

    socket.on(CLIENT_EVENTS.RTC_ANSWER, (payload = {}, ack) => {
      handleRtcRelay(socket, ack, payload, {
        state,
        io,
        eventName: CLIENT_EVENTS.RTC_ANSWER,
        dataKey: 'sdp',
      });
    });

    socket.on(CLIENT_EVENTS.RTC_CANDIDATE, (payload = {}, ack) => {
      handleRtcRelay(socket, ack, payload, {
        state,
        io,
        eventName: CLIENT_EVENTS.RTC_CANDIDATE,
        dataKey: 'candidate',
      });
    });

    // Best-effort relay of local media-state flags (currently just screen
    // sharing) to the other participant, so the UI can show a "X is
    // presenting" indicator on the remote side.  Reuses the generic RTC relay:
    // authorization/rate-limiting/call-state checks are identical to
    // rtc.offer/answer/candidate.
    socket.on(CLIENT_EVENTS.CALL_MEDIA_STATE, (payload = {}, ack) => {
      handleRtcRelay(socket, ack, payload, {
        state,
        io,
        eventName: CLIENT_EVENTS.CALL_MEDIA_STATE,
        dataKey: 'mediaState',
        // Doubles as the in-call liveness heartbeat.
        recordsHeartbeat: true,
      });
    });

    // Self-heal: a client that was rejected as `busy` while holding no call of
    // its own reports what it believes is live, so the server can close out the
    // phantom calls that are blocking it.
    socket.on(CLIENT_EVENTS.CALL_STATE_REPORT, (payload = {}, ack) => {
      if (!requireSocketSession(socket, ack, CLIENT_EVENTS.CALL_STATE_REPORT)) {
        return;
      }
      if (!validateSignalingVersion(socket, payload, ack, CLIENT_EVENTS.CALL_STATE_REPORT)) {
        return;
      }
      const parsed = parseInboundPayload(
        socket,
        ack,
        CLIENT_EVENTS.CALL_STATE_REPORT,
        payload,
        state
      );
      if (!parsed) return;

      const userId = socket.data.identity.userId;
      const reported = Array.isArray(parsed.activeCallIds)
        ? parsed.activeCallIds
        : [parsed.callId];
      const activeCallIds = (reported.map((value: unknown) => normaliseId(value)).filter(Boolean) as string[]);
      const cleared = reconcileClientCallState(state, userId, activeCallIds, {
        onTransition: (call, previousStatus, reason) =>
          notifyCallTransition(io, state, call, { previousStatus, actor: userId, reason }),
      });
      acknowledgeSuccess(socket, ack, CLIENT_EVENTS.CALL_STATE_REPORT, {
        clearedCallIds: cleared.map((call) => call.callId),
        activeCalls: describeActiveCallsForUser(state, userId),
      });
    });

    registerMessageHandlers(socket, { io, state });

    socket.on(TRANSPORT_EVENTS.DISCONNECT, (reason) => {
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
      scheduleParticipantDisconnectCleanup(io, state, identity?.userId, participantDisconnectGraceMs);
    });
  });
}

export {
  registerSocketHandlers,
  leaveRoom,
};
