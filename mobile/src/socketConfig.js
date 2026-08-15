const DEFAULT_TRANSPORTS = ['websocket', 'polling'];

export const RECONNECTION_OPTIONS = {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
};

export function getSocketOptions(overrides = {}) {
  return {
    transports: DEFAULT_TRANSPORTS,
    ...RECONNECTION_OPTIONS,
    ...overrides,
  };
}

const UNRECOVERABLE_DISCONNECT_REASONS = new Set(['io client disconnect', 'io server disconnect']);

export function isRecoverableDisconnectReason(reason) {
  return !UNRECOVERABLE_DISCONNECT_REASONS.has(reason);
}
