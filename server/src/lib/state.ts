import { hasOwnProp } from './normalize.ts';

/**
 * In-memory state helpers.
 *
 * These functions operate on the `state` object built by `createServer` and
 * encapsulate all reads/writes of the presence, session, device and connection
 * collections.  They are deliberately free of any Express/Socket.IO knowledge
 * so the HTTP routes and the signaling layer can share the exact same logic.
 */

export type Stores = import('../stores/contracts.ts').Stores;
export type SessionRecord = import('../stores/contracts.ts').SessionRecord;
export type DeviceRecord = import('../stores/contracts.ts').DeviceRecord;
export type ConnectionRecord = import('../stores/contracts.ts').ConnectionRecord;
export type PresenceRecord = import('../stores/contracts.ts').PresenceRecord;

/**
 * A websocket channel a user can be reached on.
 */
export type WebsocketChannel = { type: 'websocket'; socketId: string; deviceId: string; sessionId: string | null; };

/**
 * A push channel a user can be reached on.
 */
export type PushChannel = { type: 'push'; deviceId: string; provider: string; pushToken: string; };

export type ReachableChannel = WebsocketChannel | PushChannel;

// ─── Presence ───────────────────────────────────────────────────────────────

/**
 * Ensure a presence record exists for a user and return it.
 *
 * @returns `null` when `userId` is falsy.
 */
function ensurePresenceRecord(state: Stores, userId: string): PresenceRecord | null {
  if (!userId) {
    return null;
  }

  let record = state.userPresence.get(userId);
  if (!record) {
    record = { lastSeen: null };
    state.userPresence.set(userId, record);
  }

  return record;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/**
 * Track a session id against the user that owns it.
 */
function addSessionToUser(state: Stores, session: SessionRecord): void {
  let sessionIds = state.userSessions.get(session.userId);
  if (!sessionIds) {
    sessionIds = new Set();
    state.userSessions.set(session.userId, sessionIds);
  }

  sessionIds.add(session.sessionId);
}

// ─── Devices ────────────────────────────────────────────────────────────────

/**
 * Find another device row (different `deviceId`) currently holding the given
 * push token, if any.
 *
 * A live push token can only ever be delivered to one device. This guards
 * against the "same physical device signs in as a different user" case: if a
 * token resurfaces on a new registration, the row that previously held it is
 * stale and must give it up so it can no longer intercept that device's
 * pushes. See the matching DB-level unique index in `db/schema.js`.
 */
function findDeviceHoldingToken(state: Stores, pushToken: string, exceptDeviceId: string): DeviceRecord | null {
  if (!pushToken) return null;
  for (const device of state.devices.values()) {
    if (device.deviceId !== exceptDeviceId && device.pushToken === pushToken) {
      return device;
    }
  }
  return null;
}

/**
 * Create or update a device row, re-linking it to its owner and evicting a
 * reused push token from whichever other row previously held it.
 */
function upsertDevice(state: Stores, nextDevice: Partial<DeviceRecord> & { deviceId: string; userId: string; }): DeviceRecord {
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
      ? nextDevice.pushProvider ?? null
      : existing?.pushProvider ?? null,
    pushToken: hasOwnProp(nextDevice, 'pushToken')
      ? nextDevice.pushToken ?? null
      : existing?.pushToken ?? null,
    lastRegisteredAt: hasOwnProp(nextDevice, 'lastRegisteredAt')
      ? nextDevice.lastRegisteredAt ?? null
      : existing?.lastRegisteredAt ?? null,
    lastUnregisteredAt: hasOwnProp(nextDevice, 'lastUnregisteredAt')
      ? nextDevice.lastUnregisteredAt ?? null
      : existing?.lastUnregisteredAt ?? null,
    updatedAt: new Date().toISOString(),
  };

  // A freshly-registered token wins: evict it from whichever other row (if
  // any) previously held it, in memory, so `resolveReachableChannels` never
  // fans a push out to two rows sharing the same live token.
  if (device.pushToken) {
    const holder = findDeviceHoldingToken(state, device.pushToken, device.deviceId);
    if (holder) {
      holder.pushToken = null;
      holder.pushProvider = null;
      holder.updatedAt = new Date().toISOString();
    }
  }

  state.devices.set(device.deviceId, device);
  let deviceIds = state.userDevices.get(device.userId);
  if (!deviceIds) {
    deviceIds = new Set();
    state.userDevices.set(device.userId, deviceIds);
  }
  deviceIds.add(device.deviceId);
  return device;
}

/**
 * Fully remove a device row — in-memory only. Used when a delivery attempt
 * proves the device's push token is dead (FCM `UNREGISTERED` /
 * `INVALID_ARGUMENT`), so the row stops being selected for future pushes and
 * stops masking real failures as silent no-ops.
 *
 * @returns `true` when a row was found and removed
 */
function removeDevice(state: Stores, deviceId: string): boolean {
  const device = state.devices.get(deviceId);
  if (!device) return false;
  state.devices.delete(deviceId);
  unlinkDeviceFromUser(state, device.userId, deviceId);
  return true;
}

/**
 * Remove a device id from a user's device set, dropping the set when empty.
 */
function unlinkDeviceFromUser(state: Stores, userId: string, deviceId: string): void {
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

/**
 * Track a live socket connection and mark its owner online.
 */
function addConnection(state: Stores, connection: ConnectionRecord): void {
  let connections = state.userConnections.get(connection.userId);
  if (!connections) {
    connections = new Map();
    state.userConnections.set(connection.userId, connections);
  }

  connections.set(connection.socketId, connection);
  const presence = ensurePresenceRecord(state, connection.userId);
  if (presence) presence.lastSeen = null;
}

/**
 * Drop a socket connection, marking its owner offline when it was the last one.
 */
function removeConnection(state: Stores, userId: string, socketId: string): void {
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
    const presence = ensurePresenceRecord(state, userId);
    if (presence) presence.lastSeen = new Date().toISOString();
  }
}

/**
 * Drop every locally-tracked socket connection from presence and mark the
 * affected users offline (with a fresh `lastSeen`).  Called during graceful
 * shutdown so presence reflects the drain immediately rather than waiting for
 * each socket teardown.
 */
function drainLocalPresence(state: Stores): void {
  const now = new Date().toISOString();
  for (const userId of Array.from(state.userConnections.keys())) {
    state.userConnections.delete(userId);
    const presence = ensurePresenceRecord(state, userId);
    if (presence) presence.lastSeen = now;
  }
}

// ─── Directory / presence snapshots ──────────────────────────────────────────

/**
 * Build the public presence payload for a user.
 */
function getPresenceSnapshot(state: Stores, userId: string): {
    userId: string;
    status: 'online' | 'offline';
    online: boolean;
    lastSeen: string | null;
    activeConnections: number;
    devices: Array<{ deviceId: string; platform: string | null; pushRegistered: boolean; connected: boolean; }>;
} {
  ensurePresenceRecord(state, userId);
  const connections = state.userConnections.get(userId);
  const online = Boolean(connections && connections.size > 0);
  const deviceIds = state.userDevices.get(userId) || new Set();
  const connectedDeviceIds = new Set(
    Array.from(connections?.values() || [], (connection) => connection.deviceId)
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

/**
 * @returns `true` when the server has any record of the user.
 */
function hasKnownUser(state: Stores, userId: string): boolean {
  if (
    state.userConnections.has(userId) ||
    state.userDevices.has(userId) ||
    state.userSessions.has(userId)
  ) {
    return true;
  }

  return state.userPresence.has(userId);
}

/**
 * Enumerate every userId the server is aware of, deduplicated across the
 * session, device, connection and presence collections.  Used by the contact
 * directory (`GET /users`).
 */
function listKnownUsers(state: Stores): Set<string> {
  const userIds = new Set<string>();
  for (const userId of state.userSessions.keys()) userIds.add(userId);
  for (const userId of state.userDevices.keys()) userIds.add(userId);
  for (const userId of state.userConnections.keys()) userIds.add(userId);
  for (const userId of state.userPresence.keys()) userIds.add(userId);
  return userIds;
}

/**
 * Resolve the set of channels (live WebSocket connections and registered push
 * tokens) through which a user can currently be reached.
 */
function resolveReachableChannels(state: Stores, userId: string): ReachableChannel[] {
  const channels: ReachableChannel[] = [];
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
  const pushChannels: Array<PushChannel & { updatedAt: string | null; }> = [];
  if (deviceIds) {
    for (const deviceId of deviceIds) {
      const device = state.devices.get(deviceId);
      if (!device?.pushProvider || !device?.pushToken) {
        continue;
      }

      pushChannels.push({
        type: 'push',
        deviceId,
        provider: device.pushProvider,
        pushToken: device.pushToken,
        updatedAt: device.updatedAt ?? null,
      });
    }
  }

  // Safety net: when a user still has more than one push-registered device
  // (e.g. right after a reinstall, before the old row's dead token is pruned
  // — see removeDevice / server/src/push.js), prefer the most recently
  // updated row first. Registration dedupe (upsertDevice evicting a reused
  // token) and dead-token pruning should make this rarely load-bearing.
  pushChannels.sort((a, b) => {
    const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bTime - aTime;
  });

  for (const { updatedAt: _updatedAt, ...channel } of pushChannels) {
    channels.push(channel);
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
 * @returns Push channels for devices without a live socket.
 */
function resolveOfflinePushChannels(state: Stores, userId: string): PushChannel[] {
  const connections = state.userConnections.get(userId);
  const connectedDeviceIds = new Set(
    Array.from(connections?.values() || [], (connection) => connection.deviceId)
  );

  return (resolveReachableChannels(state, userId).filter(
      (channel) => channel.type === 'push' && !connectedDeviceIds.has(channel.deviceId)
    ) as PushChannel[]);
}

/**
 * Socket.IO room name that every one of a user's sockets joins on connect.
 *
 * Addressing emits to this room (instead of iterating tracked socket ids) lets
 * the Socket.IO Redis adapter deliver to the user's sockets on other instances.
 */
function userRoom(userId: string): string {
  return `user:${userId}`;
}

export {
  ensurePresenceRecord,
  addSessionToUser,
  upsertDevice,
  removeDevice,
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
