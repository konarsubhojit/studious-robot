import { MAX_ROOM_SIZE, DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS } from '../../config.ts';
import { normaliseId } from '../../lib/normalize.ts';
import { isBlocked } from '../../security.ts';
import { resolveSocketIdentity } from '../../lib/auth.ts';
import { ensurePresenceRecord, upsertDevice, addConnection, removeConnection, userRoom } from '../../lib/state.ts';
import { createCallRecord, reconcileClientCallState, describeActiveCallsForUser } from '../../domain/calls.ts';
import { notifyCallCreated, notifyIncomingCallAcknowledged, markIncomingCallAcknowledged, notifyRingingCallsForDisconnectedDevice, notifyCallTransition } from '../../domain/notifications.ts';
import { handleSocketCallTransition, handleRtcRelay, handleCallConnected } from '../callHandlers.ts';
import { registerMessageHandlers } from '../messageHandlers.ts';
import { requireSocketSession, validateSignalingVersion, parseInboundPayload, acknowledgeSuccess, acknowledgeError } from '../ack.ts';
import { CLIENT_EVENTS, SERVER_EVENTS, ERROR_CODES, TRANSPORT_EVENTS } from '../../../../shared/index.ts';
import { verboseLog } from '../../lib/verbose.ts';
import { decideRoomJoin, normaliseReportedActiveCallIds } from './state.ts';
import { leaveRoom, logCallCorrelation, scheduleParticipantDisconnectCleanup } from './lifecycle.ts';

function registerSocketHandlers(
  io: import('socket.io').Server,
  { state, ringingTimeoutMs, participantDisconnectGraceMs = DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS }: {
    state: import('../../stores/contracts.ts').ServerState;
    ringingTimeoutMs: number;
    participantDisconnectGraceMs?: number;
  }
) {
  io.on('connection', (socket) => {
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
    void socket.join(userRoom(identity.userId));

    if (identity.sessionDowngraded) {
      socket.emit(SERVER_EVENTS.SESSION_INVALID, { sessionId: identity.presentedSessionId });
      console.log(
        `[signaling] socket ${socket.id} presented stale sessionId=${identity.presentedSessionId}; downgraded to guest user=${identity.userId}`
      );
    }

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

    let currentRoom: string | null = null;

    socket.on(CLIENT_EVENTS.JOIN_ROOM, (roomId) => {
      const room = typeof roomId === 'string' ? state.rooms.get(roomId) : undefined;
      const decision = decideRoomJoin({
        sessionId: socket.data.identity.sessionId,
        roomId,
        currentRoom,
        roomSize: room?.size ?? 0,
        maxRoomSize: MAX_ROOM_SIZE,
      });
      if (decision.action === 'ignore') return;
      if (decision.action === 'room_full') {
        console.log(
          `[signaling] room-full: socket ${socket.id} rejected from room "${roomId}" (size=${room?.size ?? 0})`
        );
        socket.emit(SERVER_EVENTS.ROOM_FULL, { roomId });
        return;
      }

      const nextRoomId = roomId as string;
      let resolvedRoom = room;
      if (!resolvedRoom) {
        resolvedRoom = new Set();
        state.rooms.set(nextRoomId, resolvedRoom);
      }

      if (decision.leaveRoomId !== null) {
        leaveRoom(socket, decision.leaveRoomId, state.rooms);
      }

      currentRoom = nextRoomId;
      resolvedRoom.add(socket.id);
      void socket.join(nextRoomId);
      console.log(
        `[signaling] join: socket ${socket.id} joined room "${nextRoomId}" (size=${resolvedRoom.size})`
      );
      socket.to(nextRoomId).emit(SERVER_EVENTS.PEER_JOINED, { id: socket.id });
    });

    socket.on(CLIENT_EVENTS.ROOM_OFFER, (payload = {}) => {
      if (!socket.data.identity.sessionId || payload?.roomId !== currentRoom) return;
      const parsed = parseInboundPayload(socket, undefined, CLIENT_EVENTS.ROOM_OFFER, payload);
      if (!parsed) return;
      console.log(`[signaling] relay offer: from ${socket.id} in room "${parsed.roomId}"`);
      socket.to(parsed.roomId).emit(SERVER_EVENTS.ROOM_OFFER, { from: socket.id, sdp: parsed.sdp });
    });

    socket.on(CLIENT_EVENTS.ROOM_ANSWER, (payload = {}) => {
      if (!socket.data.identity.sessionId || payload?.roomId !== currentRoom) return;
      const parsed = parseInboundPayload(socket, undefined, CLIENT_EVENTS.ROOM_ANSWER, payload);
      if (!parsed) return;
      console.log(`[signaling] relay answer: from ${socket.id} in room "${parsed.roomId}"`);
      socket.to(parsed.roomId).emit(SERVER_EVENTS.ROOM_ANSWER, { from: socket.id, sdp: parsed.sdp });
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

      const calleeId = normaliseId(parsed.calleeId) as string;
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
      notifyIncomingCallAcknowledged(io, state, callId, identity.userId);
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

    socket.on(CLIENT_EVENTS.CALL_MEDIA_STATE, (payload = {}, ack) => {
      handleRtcRelay(socket, ack, payload, {
        state,
        io,
        eventName: CLIENT_EVENTS.CALL_MEDIA_STATE,
        dataKey: 'mediaState',
        recordsHeartbeat: true,
      });
    });

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
      const activeCallIds = normaliseReportedActiveCallIds(parsed);
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
  leaveRoom,
  registerSocketHandlers,
};
