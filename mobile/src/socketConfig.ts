const DEFAULT_TRANSPORTS = ['websocket', 'polling'];

/**
 * Socket.IO reconnection policy.
 *
 * The previous policy gave up permanently after five attempts — roughly 17-20s
 * with jitter — which is *inside* the client's own mid-call recovery budget:
 * a lift, a tunnel or a slow carrier attach left the socket dead for good even
 * after signal returned, and the only way back was the user tapping Retry.
 *
 * `Infinity` attempts plus a short per-attempt `timeout` is the pair that
 * matters: a dead interface now fails fast and is retried, instead of blocking
 * the recovery ladder for a full 20s per try. Backoff still bounds the traffic
 * this generates, and `useCallFlow` re-arms explicitly on `reconnect_failed`
 * for any transport that reports one anyway.
 */
export const RECONNECTION_OPTIONS = {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 8000,
};

export function getSocketOptions(overrides = {}) {
  return {
    transports: DEFAULT_TRANSPORTS,
    ...RECONNECTION_OPTIONS,
    ...overrides,
  };
}

const UNRECOVERABLE_DISCONNECT_REASONS = new Set(['io client disconnect', 'io server disconnect']);

/**
 * @param reason - Socket.IO omits the reason for some transports.
 */
export function isRecoverableDisconnectReason(reason?: string): boolean {
  return !(reason !== undefined && UNRECOVERABLE_DISCONNECT_REASONS.has(reason));
}
