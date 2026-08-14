'use strict';

const { hasOwnProp } = require('./normalize');

/**
 * In-memory state helpers.
 *
 * These functions operate on the `state` object built by `createServer` and
 * encapsulate all reads/writes of the presence, session, device and connection
 * collections.  They are deliberately free of any Express/Socket.IO knowledge
 * so the HTTP routes and the signaling layer can share the exact same logic.
 */

// ─── Presence ───────────────────────────────────────────────────────────────

function ensurePresenceRecord(state, userId) {
  if (!userId) {
    return null;
  }

  if (!state.userPresence.has(userId)) {
    state.userPresence.set(userId, { lastSeen: null });
  }

  return state.userPresence.get(userId);
}

// ─── Sessions ───────────────────────────────────────────────────────────────

function addSessionToUser(state, session) {
  if (!state.userSessions.has(session.userId)) {
    state.userSessions.set(session.userId, new Set());
  }

  state.userSessions.get(session.userId).add(session.sessionId);
}

// ─── Devices ────────────────────────────────────────────────────────────────

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

// ─── Connections ────────────────────────────────────────────────────────────

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

/**
 * Drop every locally-tracked socket connection from presence and mark the
 * affected users offline (with a fresh `lastSeen`).  Called during graceful
 * shutdown so presence reflects the drain immediately rather than waiting for
 * each socket teardown.
 *
 * @param {object} state
 */
function drainLocalPresence(state) {
  const now = new Date().toISOString();
  for (const userId of Array.from(state.userConnections.keys())) {
    state.userConnections.delete(userId);
    ensurePresenceRecord(state, userId).lastSeen = now;
  }
}

// ─── Directory / presence snapshots ──────────────────────────────────────────

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

/**
 * Enumerate every userId the server is aware of, deduplicated across the
 * session, device, connection and presence collections.  Used by the contact
 * directory (`GET /users`).
 *
 * @param {object} state
 * @returns {Set<string>}
 */
function listKnownUsers(state) {
  const userIds = new Set();
  for (const userId of state.userSessions.keys()) userIds.add(userId);
  for (const userId of state.userDevices.keys()) userIds.add(userId);
  for (const userId of state.userConnections.keys()) userIds.add(userId);
  for (const userId of state.userPresence.keys()) userIds.add(userId);
  return userIds;
}

/**
 * Resolve the set of channels (live WebSocket connections and registered push
 * tokens) through which a user can currently be reached.
 *
 * @param {object} state
 * @param {string} userId
 * @returns {Array<object>}
 */
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

/**
 * Resolve the push channels for a user's devices that have **no live socket
 * connection** of their own.
 *
 * Push delivery must be decided per device, not per user: a user who is
 * connected on one device (say a laptop) is still unreachable on the phone that
 * is asleep in their pocket, and that phone is exactly the device that needs to
 * ring.  Gating on "the user has zero connections" silently drops the push for
 * every other registered device.
 *
 * @param {object} state
 * @param {string} userId
 * @returns {Array<object>} Push channels for devices without a live socket.
 */
function resolveOfflinePushChannels(state, userId) {
  const connections = state.userConnections.get(userId);
  const connectedDeviceIds = new Set(
    Array.from(connections?.values() || [], (connection) => connection.deviceId),
  );

  return resolveReachableChannels(state, userId)
    .filter((channel) => channel.type === 'push' && !connectedDeviceIds.has(channel.deviceId));
}

/**
 * Socket.IO room name that every one of a user's sockets joins on connect.
 *
 * Addressing emits to this room (instead of iterating tracked socket ids) lets
 * the Socket.IO Redis adapter deliver to the user's sockets on other instances.
 *
 * @param {string} userId
 * @returns {string}
 */
function userRoom(userId) {
  return `user:${userId}`;
}

module.exports = {
  ensurePresenceRecord,
  addSessionToUser,
  upsertDevice,
  unlinkDeviceFromUser,
  addConnection,
  removeConnection,
  drainLocalPresence,
  getPresenceSnapshot,
  hasKnownUser,
  listKnownUsers,
  resolveReachableChannels,
  resolveOfflinePushChannels,
  userRoom,
};
