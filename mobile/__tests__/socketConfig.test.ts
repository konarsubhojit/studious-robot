import {
  RECONNECTION_OPTIONS,
  getSocketOptions,
  isRecoverableDisconnectReason,
} from '../src/socketConfig';

describe('socketConfig', () => {
  test('getSocketOptions enables reconnection with a bounded retry policy', () => {
    const options = getSocketOptions();

    expect(options.transports).toEqual(['websocket', 'polling']);
    expect(options.reconnection).toBe(true);
    expect(options.reconnectionAttempts).toBe(RECONNECTION_OPTIONS.reconnectionAttempts);
    expect(options.reconnectionDelay).toBe(RECONNECTION_OPTIONS.reconnectionDelay);
    expect(options.reconnectionDelayMax).toBe(RECONNECTION_OPTIONS.reconnectionDelayMax);
  });

  test('getSocketOptions allows overrides', () => {
    const options = getSocketOptions({ reconnectionAttempts: 2, extra: true });

    expect(options.reconnectionAttempts).toBe(2);
    expect((options as any).extra).toBe(true);
    expect(options.reconnection).toBe(true);
  });

  test('transient disconnect reasons are treated as recoverable', () => {
    expect(isRecoverableDisconnectReason('transport close')).toBe(true);
    expect(isRecoverableDisconnectReason('ping timeout')).toBe(true);
    expect(isRecoverableDisconnectReason(undefined)).toBe(true);
  });

  test('explicit client/server disconnects are not recoverable', () => {
    expect(isRecoverableDisconnectReason('io client disconnect')).toBe(false);
    expect(isRecoverableDisconnectReason('io server disconnect')).toBe(false);
  });
});
