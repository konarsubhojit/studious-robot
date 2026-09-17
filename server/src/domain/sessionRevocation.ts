import { SERVER_EVENTS } from '../../../shared/index.ts';
import { persistDevice } from '../lib/persistence.ts';
import { userRoom } from '../lib/state.ts';

type ServerState = import('../stores/contracts.ts').ServerState;
type SessionRecord = import('../stores/contracts.ts').SessionRecord;
type DeviceRecord = import('../stores/contracts.ts').DeviceRecord;

function removeLocalSession(state: ServerState, sessionId: string): void {
  const session = state.sessions.get(sessionId);
  state.sessions.delete(sessionId);
  if (!session) return;
  const owned = state.userSessions.get(session.userId);
  owned?.delete(sessionId);
  if (owned?.size === 0) state.userSessions.delete(session.userId);
}

async function listUserSessions(state: ServerState, userId: string): Promise<SessionRecord[]> {
  const sessions = new Map<string, SessionRecord>();
  for (const sessionId of state.userSessions.get(userId) ?? []) {
    const session = state.sessions.get(sessionId);
    if (session) sessions.set(sessionId, session);
  }
  if (state.sessionState?.listByUser) {
    for (const session of await state.sessionState.listByUser(userId)) {
      sessions.set(session.sessionId, session);
    }
  }
  return [...sessions.values()];
}

async function clearDevicePush(
  state: ServerState,
  device: DeviceRecord,
  reason: 'revocation' | 'revocation_all'
): Promise<DeviceRecord> {
  const revokedAt = new Date().toISOString();
  const next = {
    ...device,
    pushProvider: null,
    pushToken: null,
    sessionId: null,
    lastUnregisteredAt: revokedAt,
    revokedAt,
    updatedAt: revokedAt,
  };
  state.devices.set(device.deviceId, next);
  await state.sessionState?.revokeDevice?.(device.userId, device.deviceId, revokedAt);
  await persistDevice(state.db, next, 'unregistration');
  state.auditLog.record({
    event: 'device.push_cleared',
    actor: device.userId,
    target: device.deviceId,
    outcome: 'success',
    details: { reason },
  });
  return next;
}

async function revokeDeviceSessions(
  state: ServerState,
  { userId, deviceId, reason }: { userId: string; deviceId: string; reason: 'revocation' | 'revocation_all' }
): Promise<{ revokedSessionIds: string[]; device: DeviceRecord | null }> {
  const device = state.devices.get(deviceId) ?? null;
  if (!device || device.userId !== userId) {
    return { revokedSessionIds: [], device: null };
  }

  const cleared = await clearDevicePush(state, device, reason);
  const revokedSessionIds: string[] = [];
  const sessions = await listUserSessions(state, userId);
  for (const session of sessions) {
    if (session.deviceId !== deviceId) continue;
    removeLocalSession(state, session.sessionId);
    await state.sessionState?.remove(session.sessionId);
    revokedSessionIds.push(session.sessionId);
  }

  return { revokedSessionIds, device: cleared };
}

async function revokeAllDeviceSessions(
  state: ServerState,
  userId: string
): Promise<{ revokedSessionIds: string[]; revokedDeviceIds: string[] }> {
  const deviceIds = new Set(state.userDevices.get(userId) ?? []);
  const sessions = await listUserSessions(state, userId);
  for (const session of sessions) {
    if (session.userId === userId) deviceIds.add(session.deviceId);
  }

  const revokedSessionIds: string[] = [];
  const revokedDeviceIds: string[] = [];
  for (const deviceId of deviceIds) {
    if (!state.devices.has(deviceId)) {
      const session = sessions.find((knownSession) => knownSession.deviceId === deviceId);
      state.devices.set(deviceId, {
        userId,
        deviceId,
        platform: session?.platform ?? null,
        sessionId: session?.sessionId ?? null,
        pushProvider: null,
        pushToken: null,
      });
      let userDeviceIds = state.userDevices.get(userId);
      if (!userDeviceIds) {
        userDeviceIds = new Set();
        state.userDevices.set(userId, userDeviceIds);
      }
      userDeviceIds.add(deviceId);
    }
    const result = await revokeDeviceSessions(state, { userId, deviceId, reason: 'revocation_all' });
    if (result.device) revokedDeviceIds.push(deviceId);
    revokedSessionIds.push(...result.revokedSessionIds);
  }
  return { revokedSessionIds, revokedDeviceIds };
}

function disconnectRevokedSockets(
  io: import('socket.io').Server,
  state: ServerState,
  userId: string,
  deviceIds: string[],
  sessionIds: string[]
): void {
  const deviceSet = new Set(deviceIds);
  const sessionSet = new Set(sessionIds);
  io.to(userRoom(userId)).emit(SERVER_EVENTS.SESSION_INVALID, {
    reason: 'revoked',
    deviceIds,
    sessionIds,
  });
  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data.identity;
    if (identity?.userId !== userId) continue;
    if (deviceSet.has(identity.deviceId) || sessionSet.has(identity.sessionId)) {
      socket.emit(SERVER_EVENTS.SESSION_INVALID, {
        reason: 'revoked',
        deviceIds,
        sessionIds,
      });
      socket.disconnect(true);
    }
  }
}

export {
  listUserSessions,
  removeLocalSession,
  revokeDeviceSessions,
  revokeAllDeviceSessions,
  disconnectRevokedSockets,
};
