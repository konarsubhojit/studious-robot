import {
  RECONNECTION_OPTIONS,
  getSocketOptions,
  isRecoverableDisconnectReason,
} from '../src/socketConfig';
import { CALL_RECOVERY_BUDGET_MS } from '../../shared';

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

  test('reconnection outlasts the mid-call recovery budget', () => {
    // Five attempts (roughly 17-20s with jitter) expired *inside* the client's
    // own recovery budget and then stopped for good, so any outage longer than
    // the ladder was unrecoverable until the user tapped Retry.
    const options = getSocketOptions();

    expect(options.reconnectionAttempts).toBe(Infinity);
    expect(options.reconnectionDelayMax).toBeLessThan(CALL_RECOVERY_BUDGET_MS);
  });

  test('a dead interface fails fast rather than blocking the recovery ladder', () => {
    const options = getSocketOptions();

    // The old 20s connect timeout could burn two thirds of the budget on a
    // single attempt against an interface that was never coming back.
    expect(RECONNECTION_OPTIONS.timeout).toBeLessThanOrEqual(10_000);
    expect((options as any).timeout).toBe(RECONNECTION_OPTIONS.timeout);
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
