'use strict';

const http = require('http');
const { randomUUID } = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const MAX_ROOM_SIZE = 2;
const PUSH_PROVIDERS = new Set(['apns', 'fcm']);

// ─── Call lifecycle ───────────────────────────────────────────────────────────

/** States from which calls can never leave. */
const TERMINAL_CALL_STATES = new Set(['ended', 'declined', 'missed', 'busy', 'unreachable']);

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

    const result = transitionCall(state, call.callId, 'accepted', { actor: session.userId });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
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

    const result = transitionCall(state, call.callId, 'declined', {
      actor: session.userId,
      reason: 'declined',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
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

    const result = transitionCall(state, call.callId, 'ended', {
      actor: session.userId,
      reason: 'cancelled',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
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

    const result = transitionCall(state, call.callId, 'ended', {
      actor: session.userId,
      reason: 'ended',
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.message || result.error });
      return;
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
    () => tickRingingTimeouts(state, Date.now()),
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

module.exports = { createServer };

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
  } else if (resolveReachableChannels(state, calleeId).length === 0 && !hasKnownUser(state, calleeId)) {
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
  call.endReason = TERMINAL_CALL_STATES.has(toStatus) ? (reason ?? null) : null;
  call.updatedAt = new Date().toISOString();
  if (TERMINAL_CALL_STATES.has(toStatus)) {
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
    actor: actor || null,
    reason: reason || null,
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
 * Advance every `ringing` call whose `ringTimeoutAt` is ≤ `now` to `missed`.
 *
 * @param {object} state
 * @param {number} now - Unix timestamp in ms.
 * @returns {number} Number of calls transitioned.
 */
function tickRingingTimeouts(state, now) {
  let count = 0;
  for (const call of state.calls.values()) {
    if (call.status !== 'ringing') continue;
    if (call.ringTimeoutAt === null) continue;
    if (new Date(call.ringTimeoutAt).getTime() > now) continue;

    call.status = 'missed';
    call.endReason = 'timeout';
    call.updatedAt = new Date(now).toISOString();
    call.ringTimeoutAt = null;
    appendCallEvent(state, call.callId, 'missed', null, 'timeout');
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
