'use strict';

const http = require('http');
const { randomUUID } = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const push = require('./push');

const MAX_ROOM_SIZE = 2;
const PUSH_PROVIDERS = new Set(['apns', 'fcm']);
const SIGNALING_VERSION = 1;
const RTC_ACTIVE_CALL_STATES = new Set(['accepted', 'connecting_media', 'in_call']);

// ─── Call lifecycle ───────────────────────────────────────────────────────────

/** States from which calls can never leave. */
const TERMINAL_CALL_STATES = new Set(['ended', 'declined', 'missed', 'busy', 'unreachable']);

/**
 * Canonical end-reason codes with their stable i18n message keys.
 *
 * Each key is the value stored in `call.endReason`.  The value is a
 * localization-friendly message key that clients can map to translated text;
 * the key itself also serves as a readable default English hint.
 *
 * @type {Record<string, string>}
 */
const CALL_END_REASONS = {
  ended:       'call_ended',
  declined:    'call_declined',
  cancelled:   'call_cancelled',
  timeout:     'call_missed',
  busy:        'callee_busy',
  unreachable: 'callee_unreachable',
  failed:      'call_failed',
};

/**
 * Valid next states for each non-terminal call state.
 *
 * @type {Map<string, Set<string>>}
 */
const CALL_TRANSITIONS = new Map([
  ['ringing',          new Set(['accepted', 'declined', 'missed', 'busy', 'unreachable', 'ended'])],
  ['accepted',         new Set(['connecting_media', 'ended'])],
  ['connecting_media', new Set(['in_call', 'ended'])],
  ['in_call',          new Set(['ended'])],
]);

/** How long a call may remain in `ringing` before it becomes `missed`. */
const DEFAULT_RINGING_TIMEOUT_MS = 30_000;

/** How often the background worker polls for timed-out ringing calls. */
const RINGING_POLL_MS = 5_000;

/**
 * Build the Express app and HTTP/Socket.IO server.
 *
 * Exported as a factory so tests can spin up an isolated instance on an
 * ephemeral port without starting the production listener.
 */
function createServer() {
  const app = express();
  app.use(express.json());

  const ringingTimeoutMs = Number(process.env.RINGING_TIMEOUT_MS) || DEFAULT_RINGING_TIMEOUT_MS;

  const state = {
    rooms: new Map(),
    sessions: new Map(),
    userSessions: new Map(),
    devices: new Map(),
    userDevices: new Map(),
    userConnections: new Map(),
    userPresence: new Map(),
    /** @type {Map<string, CallRecord>} callId → call record */
    calls: new Map(),
    /** @type {Map<string, CallEvent[]>} callId → ordered event list */
    callEvents: new Map(),
  };

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'studious-robot-signaling',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/session', (req, res) => {
    const userId = normaliseId(req.body?.userId) || `user-${randomUUID()}`;
    const deviceId = normaliseId(req.body?.deviceId) || `device-${randomUUID()}`;
    const platform = normaliseOptionalString(req.body?.platform);
    const createdAt = new Date().toISOString();
    const session = {
      sessionId: randomUUID(),
      userId,
      deviceId,
      platform,
      createdAt,
    };

    state.sessions.set(session.sessionId, session);
    addSessionToUser(state, session);
    upsertDevice(state, {
      userId,
      deviceId,
      platform,
      sessionId: session.sessionId,
    });
    ensurePresenceRecord(state, userId);

    res.status(201).json(session);
  });

  app.get('/session', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    res.status(200).json(session);
  });

  app.post('/devices/register', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const provider = normalisePushProvider(req.body?.provider);
    const pushToken = normaliseId(req.body?.pushToken);
    const requestedDeviceId = normaliseId(req.body?.deviceId);
    if (!provider || !pushToken) {
      res.status(400).json({ error: 'provider and pushToken are required' });
      return;
    }
    if (requestedDeviceId && requestedDeviceId !== session.deviceId) {
      res.status(400).json({ error: 'deviceId does not match active session' });
      return;
    }

    const device = upsertDevice(state, {
      userId: session.userId,
      deviceId: session.deviceId,
      platform: session.platform,
      sessionId: session.sessionId,
      pushProvider: provider,
      pushToken,
      lastRegisteredAt: new Date().toISOString(),
      lastUnregisteredAt: null,
    });

    res.status(200).json({
      status: 'registered',
      userId: device.userId,
      deviceId: device.deviceId,
      provider: device.pushProvider,
    });
  });

  app.post('/devices/unregister', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const requestedDeviceId = normaliseId(req.body?.deviceId);
    if (requestedDeviceId && requestedDeviceId !== session.deviceId) {
      res.status(400).json({ error: 'deviceId does not match active session' });
      return;
    }

    const device = upsertDevice(state, {
      userId: session.userId,
      deviceId: session.deviceId,
      platform: session.platform,
      sessionId: session.sessionId,
      pushProvider: null,
      pushToken: null,
      lastUnregisteredAt: new Date().toISOString(),
    });

    res.status(200).json({
      status: 'unregistered',
      userId: device.userId,
      deviceId: device.deviceId,
    });
  });

  app.get('/presence/:userId', (req, res) => {
    const userId = normaliseId(req.params.userId);
    if (!userId || !hasKnownUser(state, userId)) {
      res.status(404).json({ error: 'user not found' });
      return;
    }

    res.status(200).json(getPresenceSnapshot(state, userId));
  });

  // ─── Call end-reason taxonomy (static, no auth required) ──────────────────

  app.get('/call-end-reasons', (_req, res) => {
    res.status(200).json({ reasons: CALL_END_REASONS });
  });

  // ─── Call lifecycle endpoints ───────────────────────────────────────────────

  app.post('/calls', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const calleeId = normaliseId(req.body?.calleeId);
    if (!calleeId) {
      res.status(400).json({ error: 'calleeId is required' });
      return;
    }

    if (calleeId === session.userId) {
      res.status(400).json({ error: 'cannot call yourself' });
      return;
    }

    const call = createCallRecord(state, {
      callerId: session.userId,
      calleeId,
      ringingTimeoutMs,
    });
    notifyCallCreated(io, state, call);

    res.status(201).json(call);
  });

  app.get('/calls/:callId', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = state.calls.get(normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.callerId !== session.userId && call.calleeId !== session.userId) {
      res.status(403).json({ error: 'not a participant in this call' });
      return;
    }

    res.status(200).json(call);
  });

  /**
   * GET /calls – return the call history for the authenticated user.
   *
   * Query parameters:
   *   limit  – max number of records to return (1–100, default 20)
   *   status – optional filter by call status (e.g. "missed", "ended")
   *
   * Records are ordered by `createdAt` descending (most recent first).
   */
  app.get('/calls', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const limitParam = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, 100)
      : 20;
    const statusFilter = normaliseId(req.query.status) ?? null;

    const userId = session.userId;
    const userCalls = [];
    for (const call of state.calls.values()) {
      if (call.callerId !== userId && call.calleeId !== userId) continue;
      if (statusFilter && call.status !== statusFilter) continue;
      userCalls.push(call);
    }

    userCalls.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.status(200).json({
      calls: userCalls.slice(0, limit),
      total: userCalls.length,
    });
  });

  app.post('/calls/:callId/accept', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = state.calls.get(normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.calleeId !== session.userId) {
      res.status(403).json({ error: 'only the callee can accept a call' });
      return;
    }

    const previousStatus = call.status;
    const result = transitionCall(state, call.callId, 'accepted', { actor: session.userId });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
    }
    if (previousStatus !== result.call.status) {
      notifyCallTransition(io, state, result.call, {
        previousStatus,
        actor: session.userId,
      });
    }

    res.status(200).json(result.call);
  });

  app.post('/calls/:callId/decline', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = state.calls.get(normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.calleeId !== session.userId) {
      res.status(403).json({ error: 'only the callee can decline a call' });
      return;
    }

    const previousStatus = call.status;
    const result = transitionCall(state, call.callId, 'declined', {
      actor: session.userId,
      reason: 'declined',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
    }
    if (previousStatus !== result.call.status) {
      notifyCallTransition(io, state, result.call, {
        previousStatus,
        actor: session.userId,
        reason: 'declined',
      });
    }

    res.status(200).json(result.call);
  });

  app.post('/calls/:callId/cancel', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = state.calls.get(normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.callerId !== session.userId) {
      res.status(403).json({ error: 'only the caller can cancel a call' });
      return;
    }

    const previousStatus = call.status;
    const result = transitionCall(state, call.callId, 'ended', {
      actor: session.userId,
      reason: 'cancelled',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
    }
    if (previousStatus !== result.call.status) {
      notifyCallTransition(io, state, result.call, {
        previousStatus,
        actor: session.userId,
        reason: 'cancelled',
      });
    }

    res.status(200).json(result.call);
  });

  app.post('/calls/:callId/end', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const call = state.calls.get(normaliseId(req.params.callId) ?? '');
    if (!call) {
      res.status(404).json({ error: 'call not found' });
      return;
    }

    if (call.callerId !== session.userId && call.calleeId !== session.userId) {
      res.status(403).json({ error: 'not a participant in this call' });
      return;
    }

    const previousStatus = call.status;
    const result = transitionCall(state, call.callId, 'ended', {
      actor: session.userId,
      reason: 'ended',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
    }
    if (previousStatus !== result.call.status) {
      notifyCallTransition(io, state, result.call, {
        previousStatus,
        actor: session.userId,
        reason: 'ended',
      });
    }

    res.status(200).json(result.call);
  });

  const httpServer = http.createServer(app);
  const rawCorsOrigin = process.env.CORS_ORIGIN?.trim();
  let corsOrigin = '*';
  if (rawCorsOrigin) {
    corsOrigin = rawCorsOrigin === '*'
      ? rawCorsOrigin
      : rawCorsOrigin.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (process.env.NODE_ENV === 'production') {
    corsOrigin = [];
    console.warn('[signaling] CORS_ORIGIN is not set; rejecting browser origins in production.');
  }
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin },
  });

  io.on('connection', (socket) => {
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

    console.log(
      `[signaling] socket connected: ${socket.id} user=${identity.userId} device=${identity.deviceId}`,
    );
    // Track which room this socket is currently in (one room per socket).
    let currentRoom = null;

    socket.on('join-room', (roomId) => {
      if (typeof roomId !== 'string' || roomId.length === 0) return;

      if (!state.rooms.has(roomId)) {
        state.rooms.set(roomId, new Set());
      }
      const room = state.rooms.get(roomId);

      if (room.size >= MAX_ROOM_SIZE) {
        console.log(`[signaling] room-full: socket ${socket.id} rejected from room "${roomId}" (size=${room.size})`);
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
      console.log(`[signaling] join: socket ${socket.id} joined room "${roomId}" (size=${room.size})`);

      // Notify existing peer that a new participant joined.
      socket.to(roomId).emit('peer-joined', { id: socket.id });
    });

    socket.on('offer', ({ roomId, sdp } = {}) => {
      if (typeof roomId !== 'string' || roomId.length === 0) return;
      console.log(`[signaling] relay offer: from ${socket.id} in room "${roomId}"`);
      socket.to(roomId).emit('offer', { from: socket.id, sdp });
    });

    socket.on('answer', ({ roomId, sdp } = {}) => {
      if (typeof roomId !== 'string' || roomId.length === 0) return;
      console.log(`[signaling] relay answer: from ${socket.id} in room "${roomId}"`);
      socket.to(roomId).emit('answer', { from: socket.id, sdp });
    });

    socket.on('ice-candidate', ({ roomId, candidate } = {}) => {
      if (typeof roomId !== 'string' || roomId.length === 0) return;
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
        acknowledgeError(socket, ack, 'call.initiate', 'bad_request', 'calleeId is required');
        return;
      }
      if (calleeId === socket.data.identity.userId) {
        acknowledgeError(socket, ack, 'call.initiate', 'bad_request', 'cannot call yourself');
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

    socket.on('call.accept', (payload = {}, ack) => {
      handleSocketCallTransition(socket, ack, payload, {
        state,
        io,
        eventName: 'call.accept',
        nextStatus: 'accepted',
        authorize: (call, userId) => (
          call.calleeId === userId
            ? null
            : 'only the callee can accept a call'
        ),
      });
    });

    socket.on('call.decline', (payload = {}, ack) => {
      handleSocketCallTransition(socket, ack, payload, {
        state,
        io,
        eventName: 'call.decline',
        nextStatus: 'declined',
        reason: 'declined',
        authorize: (call, userId) => (
          call.calleeId === userId
            ? null
            : 'only the callee can decline a call'
        ),
      });
    });

    socket.on('call.cancel', (payload = {}, ack) => {
      handleSocketCallTransition(socket, ack, payload, {
        state,
        io,
        eventName: 'call.cancel',
        nextStatus: 'ended',
        reason: 'cancelled',
        authorize: (call, userId) => (
          call.callerId === userId
            ? null
            : 'only the caller can cancel a call'
        ),
      });
    });

    socket.on('call.end', (payload = {}, ack) => {
      handleSocketCallTransition(socket, ack, payload, {
        state,
        io,
        eventName: 'call.end',
        nextStatus: 'ended',
        reason: 'ended',
        authorize: (call, userId) => (
          call.callerId === userId || call.calleeId === userId
            ? null
            : 'not a participant in this call'
        ),
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

    socket.on('disconnect', (reason) => {
      console.log(`[signaling] socket disconnected: ${socket.id}, reason=${reason}`);
      if (currentRoom !== null) {
        leaveRoom(socket, currentRoom, state.rooms);
        currentRoom = null;
      }
      removeConnection(state, socket.data.identity?.userId, socket.id);
    });
  });

  // Background worker: advance stale ringing calls to `missed`.
  const pollTimer = setInterval(
    () => tickRingingTimeouts(state, Date.now(), (call, previousStatus, reason) => {
      notifyCallTransition(io, state, call, {
        previousStatus,
        actor: null,
        reason,
      });
    }),
    RINGING_POLL_MS,
  );
  // Don't prevent the process from exiting if only the timer is left.
  pollTimer.unref();

  return {
    app,
    httpServer,
    io,
    getPresence: (userId) => getPresenceSnapshot(state, userId),
    resolveReachableChannels: (userId) => resolveReachableChannels(state, userId),
    getCall: (callId) => state.calls.get(callId) || null,
    getCallEvents: (callId) => state.callEvents.get(callId) || [],
    /**
     * Advance all stale `ringing` calls to `missed`.  Exposed for
     * deterministic testing; the production server also calls this on a timer.
     *
     * @param {number} [now] - Unix timestamp in ms (defaults to Date.now()).
     * @returns {number} Number of calls transitioned.
     */
    tickRingingTimeouts: (now = Date.now()) => tickRingingTimeouts(state, now),
  };
}

/**
 * Remove a socket from a room, notify the remaining peer, and clean up the
 * room entry if it becomes empty.
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

function normaliseId(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normaliseOptionalString(value) {
  return normaliseId(value);
}

function normalisePushProvider(value) {
  const provider = normaliseId(value)?.toLowerCase();
  return provider && PUSH_PROVIDERS.has(provider) ? provider : null;
}

function getSessionFromRequest(req, sessions) {
  const sessionId = normaliseId(parseBearerToken(req.headers.authorization))
    || normaliseId(req.body?.sessionId)
    || normaliseId(req.query?.sessionId);

  return sessionId ? sessions.get(sessionId) || null : null;
}

function parseBearerToken(header) {
  if (typeof header !== 'string') {
    return null;
  }

  const trimmed = header.trim();
  if (trimmed.length < 7 || trimmed.slice(0, 7).toLowerCase() !== 'bearer ') {
    return null;
  }

  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

function resolveSocketIdentity(socket, sessions) {
  const auth = isPlainObject(socket.handshake.auth) ? socket.handshake.auth : {};
  const sessionId = normaliseId(auth.sessionId);
  const session = sessionId ? sessions.get(sessionId) : null;
  if (session) {
    return {
      userId: session.userId,
      deviceId: session.deviceId,
      platform: session.platform,
      sessionId: session.sessionId,
    };
  }

  return {
    userId: normaliseId(auth.userId) || `guest-${randomUUID()}`,
    deviceId: normaliseId(auth.deviceId) || `device-${randomUUID()}`,
    platform: normaliseOptionalString(auth.platform),
    sessionId: null,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ensurePresenceRecord(state, userId) {
  if (!userId) {
    return null;
  }

  if (!state.userPresence.has(userId)) {
    state.userPresence.set(userId, { lastSeen: null });
  }

  return state.userPresence.get(userId);
}

function addSessionToUser(state, session) {
  if (!state.userSessions.has(session.userId)) {
    state.userSessions.set(session.userId, new Set());
  }

  state.userSessions.get(session.userId).add(session.sessionId);
}

function upsertDevice(state, nextDevice) {
  const existing = state.devices.get(nextDevice.deviceId);
  if (existing && existing.userId !== nextDevice.userId) {
    unlinkDeviceFromUser(state, existing.userId, existing.deviceId);
  }

  const device = {
    deviceId: nextDevice.deviceId,
    userId: nextDevice.userId,
    platform: nextDevice.platform ?? existing?.platform ?? null,
    sessionId: nextDevice.sessionId ?? existing?.sessionId ?? null,
    pushProvider: hasOwnProp(nextDevice, 'pushProvider')
      ? nextDevice.pushProvider
      : existing?.pushProvider ?? null,
    pushToken: hasOwnProp(nextDevice, 'pushToken')
      ? nextDevice.pushToken
      : existing?.pushToken ?? null,
    lastRegisteredAt: hasOwnProp(nextDevice, 'lastRegisteredAt')
      ? nextDevice.lastRegisteredAt
      : existing?.lastRegisteredAt ?? null,
    lastUnregisteredAt: hasOwnProp(nextDevice, 'lastUnregisteredAt')
      ? nextDevice.lastUnregisteredAt
      : existing?.lastUnregisteredAt ?? null,
  };

  state.devices.set(device.deviceId, device);
  if (!state.userDevices.has(device.userId)) {
    state.userDevices.set(device.userId, new Set());
  }
  state.userDevices.get(device.userId).add(device.deviceId);
  return device;
}

function unlinkDeviceFromUser(state, userId, deviceId) {
  const deviceIds = state.userDevices.get(userId);
  if (!deviceIds) {
    return;
  }

  deviceIds.delete(deviceId);
  if (deviceIds.size === 0) {
    state.userDevices.delete(userId);
  }
}

function addConnection(state, connection) {
  if (!state.userConnections.has(connection.userId)) {
    state.userConnections.set(connection.userId, new Map());
  }

  state.userConnections.get(connection.userId).set(connection.socketId, connection);
  ensurePresenceRecord(state, connection.userId).lastSeen = null;
}

function removeConnection(state, userId, socketId) {
  if (!userId) {
    return;
  }

  const connections = state.userConnections.get(userId);
  if (!connections) {
    return;
  }

  connections.delete(socketId);
  if (connections.size === 0) {
    state.userConnections.delete(userId);
    ensurePresenceRecord(state, userId).lastSeen = new Date().toISOString();
  }
}

function getPresenceSnapshot(state, userId) {
  ensurePresenceRecord(state, userId);
  const connections = state.userConnections.get(userId);
  const online = Boolean(connections && connections.size > 0);
  const deviceIds = state.userDevices.get(userId) || new Set();
  const connectedDeviceIds = new Set(
    Array.from(connections?.values() || [], (connection) => connection.deviceId),
  );

  return {
    userId,
    status: online ? 'online' : 'offline',
    online,
    lastSeen: online ? null : state.userPresence.get(userId)?.lastSeen ?? null,
    activeConnections: connections?.size || 0,
    devices: Array.from(deviceIds, (deviceId) => {
      const device = state.devices.get(deviceId);
      return {
        deviceId,
        platform: device?.platform ?? null,
        pushRegistered: Boolean(device?.pushProvider && device?.pushToken),
        connected: connectedDeviceIds.has(deviceId),
      };
    }),
  };
}

function hasKnownUser(state, userId) {
  if (state.userConnections.has(userId) || state.userDevices.has(userId) || state.userSessions.has(userId)) {
    return true;
  }

  return state.userPresence.has(userId);
}

function hasOwnProp(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function resolveReachableChannels(state, userId) {
  const channels = [];
  const connections = state.userConnections.get(userId);
  if (connections) {
    for (const connection of connections.values()) {
      channels.push({
        type: 'websocket',
        socketId: connection.socketId,
        deviceId: connection.deviceId,
        sessionId: connection.sessionId,
      });
    }
  }

  const deviceIds = state.userDevices.get(userId);
  if (deviceIds) {
    for (const deviceId of deviceIds) {
      const device = state.devices.get(deviceId);
      if (!device?.pushProvider || !device?.pushToken) {
        continue;
      }

      channels.push({
        type: 'push',
        deviceId,
        provider: device.pushProvider,
        pushToken: device.pushToken,
      });
    }
  }

  return channels;
}

function emitToUserSockets(io, state, userId, eventName, payload) {
  const connections = state.userConnections.get(userId);
  if (!connections) {
    return;
  }

  for (const connection of connections.values()) {
    io.to(connection.socketId).emit(eventName, payload);
  }
}

function notifyCallCreated(io, state, call) {
  const envelope = createCallEnvelope(call);
  if (call.status === 'ringing') {
    emitToUserSockets(io, state, call.calleeId, 'call.incoming', envelope);
    emitToUserSockets(io, state, call.callerId, 'call.ringing', envelope);

    // Push fallback: if the callee has no active WebSocket connection, deliver
    // the incoming-call notification via APNs / FCM to every registered device.
    const calleeConnections = state.userConnections.get(call.calleeId);
    const calleeIsOffline = !calleeConnections || calleeConnections.size === 0;
    if (calleeIsOffline) {
      const pushChannels = resolveReachableChannels(state, call.calleeId)
        .filter((ch) => ch.type === 'push');
      for (const channel of pushChannels) {
        push.sendIncomingCallPush(channel, { callId: call.callId, callerId: call.callerId })
          .catch((err) => {
            console.error(
              `[push] Unhandled error for device ${channel.deviceId}: ${err?.message}`,
            );
          });
      }
    }
  }

  notifyCallTransition(io, state, call, {
    previousStatus: null,
    actor: call.callerId,
    reason: call.endReason,
  });
}

function notifyCallTransition(io, state, call, { previousStatus, actor = null, reason = null }) {
  const statePayload = {
    version: SIGNALING_VERSION,
    callId: call.callId,
    previousStatus,
    status: call.status,
    actor,
    reason: reason ?? call.endReason ?? null,
    call,
  };
  emitToUserSockets(io, state, call.callerId, 'call.state_changed', statePayload);
  emitToUserSockets(io, state, call.calleeId, 'call.state_changed', statePayload);

  const eventName = getCallTransitionEventName(call.status, statePayload.reason);
  if (!eventName) {
    return;
  }

  const eventPayload = {
    version: SIGNALING_VERSION,
    callId: call.callId,
    actor,
    reason: statePayload.reason,
    call,
  };
  emitToUserSockets(io, state, call.callerId, eventName, eventPayload);
  emitToUserSockets(io, state, call.calleeId, eventName, eventPayload);
}

function getCallTransitionEventName(status, reason) {
  if (status === 'accepted') {
    return 'call.accept';
  }
  if (status === 'declined') {
    return 'call.decline';
  }
  if (status === 'ended') {
    return reason === 'cancelled' ? 'call.cancel' : 'call.end';
  }
  return null;
}

function createCallEnvelope(call) {
  return {
    version: SIGNALING_VERSION,
    callId: call.callId,
    call,
  };
}

function requireSocketSession(socket, ack, eventName) {
  if (socket.data.identity?.sessionId) {
    return true;
  }

  acknowledgeError(socket, ack, eventName, 'unauthorized', 'a valid session is required');
  return false;
}

function validateSignalingVersion(socket, payload, ack, eventName) {
  if (payload?.version === SIGNALING_VERSION) {
    return true;
  }

  acknowledgeError(socket, ack, eventName, 'unsupported_version', `version ${SIGNALING_VERSION} is required`);
  return false;
}

function acknowledgeSuccess(socket, ack, eventName, data) {
  const payload = {
    ok: true,
    version: SIGNALING_VERSION,
    event: eventName,
    ...data,
  };

  if (typeof ack === 'function') {
    ack(payload);
  }
}

function acknowledgeError(socket, ack, eventName, code, message) {
  const payload = {
    ok: false,
    version: SIGNALING_VERSION,
    event: eventName,
    error: {
      code,
      message,
    },
  };

  if (typeof ack === 'function') {
    ack(payload);
    return;
  }

  socket?.emit('signaling.error', payload);
}

function handleSocketCallTransition(socket, ack, payload, options) {
  if (!requireSocketSession(socket, ack, options.eventName)) {
    return;
  }
  if (!validateSignalingVersion(socket, payload, ack, options.eventName)) {
    return;
  }

  const callId = normaliseId(payload.callId);
  if (!callId) {
    acknowledgeError(socket, ack, options.eventName, 'bad_request', 'callId is required');
    return;
  }

  const call = options.state.calls.get(callId);
  if (!call) {
    acknowledgeError(socket, ack, options.eventName, 'call_not_found', 'call not found');
    return;
  }

  const authorizationError = options.authorize(call, socket.data.identity.userId);
  if (authorizationError) {
    acknowledgeError(socket, ack, options.eventName, 'forbidden', authorizationError);
    return;
  }

  const previousStatus = call.status;
  const result = transitionCall(options.state, callId, options.nextStatus, {
    actor: socket.data.identity.userId,
    reason: options.reason ?? null,
  });
  if (!result.ok) {
    acknowledgeError(socket, ack, options.eventName, 'invalid_state', result.message || result.error);
    return;
  }

  if (previousStatus !== result.call.status) {
    notifyCallTransition(options.io, options.state, result.call, {
      previousStatus,
      actor: socket.data.identity.userId,
      reason: options.reason ?? null,
    });
  }
  acknowledgeSuccess(socket, ack, options.eventName, { call: result.call });
}

function handleRtcRelay(socket, ack, payload, options) {
  if (!requireSocketSession(socket, ack, options.eventName)) {
    return;
  }
  if (!validateSignalingVersion(socket, payload, ack, options.eventName)) {
    return;
  }

  const callId = normaliseId(payload.callId);
  if (!callId) {
    acknowledgeError(socket, ack, options.eventName, 'bad_request', 'callId is required');
    return;
  }

  const value = payload[options.dataKey];
  if (!options.validateData(value)) {
    acknowledgeError(socket, ack, options.eventName, 'bad_request', `${options.dataKey} is required`);
    return;
  }

  const call = options.state.calls.get(callId);
  if (!call) {
    acknowledgeError(socket, ack, options.eventName, 'call_not_found', 'call not found');
    return;
  }

  const userId = socket.data.identity.userId;
  if (call.callerId !== userId && call.calleeId !== userId) {
    acknowledgeError(socket, ack, options.eventName, 'forbidden', 'not a participant in this call');
    return;
  }
  if (!RTC_ACTIVE_CALL_STATES.has(call.status)) {
    acknowledgeError(socket, ack, options.eventName, 'stale_call_state', `call is not ready for RTC in state: ${call.status}`);
    return;
  }

  if (call.status === 'accepted') {
    const previousStatus = call.status;
    const result = transitionCall(options.state, callId, 'connecting_media', {
      actor: userId,
    });
    if (result.ok && previousStatus !== result.call.status) {
      notifyCallTransition(options.io, options.state, result.call, {
        previousStatus,
        actor: userId,
      });
    }
  }

  const peerUserId = call.callerId === userId ? call.calleeId : call.callerId;
  const relayPayload = {
    version: SIGNALING_VERSION,
    callId,
    fromUserId: userId,
    [options.dataKey]: value,
  };
  emitToUserSockets(options.io, options.state, peerUserId, options.eventName, relayPayload);
  acknowledgeSuccess(socket, ack, options.eventName, { callId });
}

module.exports = { createServer, CALL_END_REASONS };

// ─── Call domain helpers ──────────────────────────────────────────────────────

/**
 * Create a new call record and append the initial `created` event.
 *
 * Immediately resolves to `busy` when the callee already has an active
 * (non-terminal) call, or to `unreachable` when the callee has no reachable
 * channels at all; otherwise starts in `ringing`.
 *
 * @param {object} state
 * @param {{ callerId: string, calleeId: string, ringingTimeoutMs: number }} opts
 * @returns {CallRecord}
 */
function createCallRecord(state, { callerId, calleeId, ringingTimeoutMs }) {
  const callId = randomUUID();
  const now = new Date().toISOString();

  // Determine initial status.
  let status = 'ringing';
  let endReason = null;

  if (getActiveCallsForUser(state, calleeId).length > 0) {
    status = 'busy';
    endReason = 'busy';
  } else if (isCalleeUnreachable(state, calleeId)) {
    status = 'unreachable';
    endReason = 'unreachable';
  }

  const call = {
    callId,
    callerId,
    calleeId,
    status,
    endReason,
    createdAt: now,
    updatedAt: now,
    ringTimeoutAt: status === 'ringing'
      ? new Date(Date.now() + ringingTimeoutMs).toISOString()
      : null,
  };

  state.calls.set(callId, call);
  state.callEvents.set(callId, []);
  appendCallEvent(state, callId, 'created', callerId, null);
  if (status !== 'ringing') {
    appendCallEvent(state, callId, status, null, endReason);
  }

  return call;
}

/**
 * Attempt to move a call to `toStatus`.
 *
 * Idempotent: if the call is already in `toStatus`, returns `{ ok: true }`.
 * Terminal states are immutable: any other transition out of a terminal state
 * returns `{ ok: false, status: 409 }`.
 *
 * @param {object} state
 * @param {string} callId
 * @param {string} toStatus
 * @param {{ actor?: string|null, reason?: string|null }} [opts]
 * @returns {{ ok: boolean, call?: CallRecord, status?: number, error?: string, message?: string }}
 */
function transitionCall(state, callId, toStatus, { actor = null, reason = null } = {}) {
  const call = state.calls.get(callId);
  if (!call) {
    return { ok: false, error: 'not_found', status: 404 };
  }

  // Idempotent: already in the requested state.
  if (call.status === toStatus) {
    return { ok: true, call };
  }

  // Terminal states are immutable.
  if (TERMINAL_CALL_STATES.has(call.status)) {
    return {
      ok: false,
      error: 'terminal_state',
      status: 409,
      message: `call is already in terminal state: ${call.status}`,
    };
  }

  const allowed = CALL_TRANSITIONS.get(call.status);
  if (!allowed || !allowed.has(toStatus)) {
    return {
      ok: false,
      error: 'invalid_transition',
      status: 409,
      message: `cannot transition from ${call.status} to ${toStatus}`,
    };
  }

  call.status = toStatus;
  const isTerminal = TERMINAL_CALL_STATES.has(toStatus);
  call.endReason = isTerminal ? (reason ?? null) : null;
  call.updatedAt = new Date().toISOString();
  if (isTerminal) {
    call.ringTimeoutAt = null;
  }

  appendCallEvent(state, callId, toStatus, actor, reason);

  return { ok: true, call };
}

/**
 * Append an event entry to a call's event log.
 *
 * @param {object} state
 * @param {string} callId
 * @param {string} event
 * @param {string|null} actor
 * @param {string|null} reason
 */
function appendCallEvent(state, callId, event, actor, reason) {
  const events = state.callEvents.get(callId);
  if (!events) return;

  events.push({
    eventId: randomUUID(),
    callId,
    event,
    actor: actor ?? null,
    reason: reason ?? null,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Return all non-terminal calls where `userId` is either the caller or callee.
 *
 * @param {object} state
 * @param {string} userId
 * @returns {CallRecord[]}
 */
function getActiveCallsForUser(state, userId) {
  const active = [];
  for (const call of state.calls.values()) {
    if (
      !TERMINAL_CALL_STATES.has(call.status)
      && (call.callerId === userId || call.calleeId === userId)
    ) {
      active.push(call);
    }
  }
  return active;
}

/**
 * Return true when the callee has never interacted with this server instance
 * (completely unknown user with no reachable channels).
 *
 * A known-but-offline user is intentionally **not** considered unreachable
 * here: they may come online or register a push token before the ringing
 * timeout fires.
 *
 * @param {object} state
 * @param {string} calleeId
 * @returns {boolean}
 */
function isCalleeUnreachable(state, calleeId) {
  return resolveReachableChannels(state, calleeId).length === 0 && !hasKnownUser(state, calleeId);
}

/**
 * Advance every `ringing` call whose `ringTimeoutAt` is ≤ `now` to `missed`.
 *
 * @param {object} state
 * @param {number} now - Unix timestamp in ms.
 * @returns {number} Number of calls transitioned.
 */
function tickRingingTimeouts(state, now, onTransition) {
  let count = 0;
  for (const call of state.calls.values()) {
    if (call.status !== 'ringing') continue;
    if (call.ringTimeoutAt === null) continue;
    if (new Date(call.ringTimeoutAt).getTime() > now) continue;

    const previousStatus = call.status;
    call.status = 'missed';
    call.endReason = 'timeout';
    call.updatedAt = new Date(now).toISOString();
    call.ringTimeoutAt = null;
    appendCallEvent(state, call.callId, 'missed', null, 'timeout');
    onTransition?.(call, previousStatus, 'timeout');
    count++;
  }
  return count;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173;
  const host = process.env.HOST || '0.0.0.0';
  const { httpServer } = createServer();
  httpServer.listen(port, host, () => {
    console.log(`[signaling] listening on http://${host}:${port}`);
    console.log(`[signaling] health endpoint: http://${host}:${port}/health`);
  });
}
