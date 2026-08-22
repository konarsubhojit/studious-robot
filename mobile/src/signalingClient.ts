import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  TRANSPORT_EVENTS,
  parseEventPayload,
} from '../../shared';
import { logInfo, logWarn } from './appLogger';
import { emitWithAck } from './socketProtocol';

/**
 * Thin typed wrapper around a Socket.IO connection.
 *
 * Responsibilities kept deliberately narrow — everything else (identity,
 * call state, WebRTC) stays in the hooks:
 *
 *   - **Contract enforcement.** Every event name comes from
 *     `@wetalk/shared`, and every inbound payload is validated against the
 *     shared schema before a handler sees it, so a malformed (or hostile)
 *     event is dropped and logged instead of throwing inside a React hook.
 *   - **Offline queueing.** Fire-and-forget emits made while the socket is
 *     disconnected are queued (newest-wins, bounded) and flushed on the next
 *     `connect`, instead of vanishing or growing without limit.
 *   - **Structured logging.** Drops, queue overflows and flushes are logged
 *     with the event name so a mismatch is visible in the exported log.
 *
 * Reconnect/backoff itself is delegated to Socket.IO's own reconnection
 * manager (see `getSocketOptions` in `socketConfig.js`), which already applies
 * exponential backoff with jitter; this wrapper only reacts to the resulting
 * `connect` / `disconnect` transitions.
 */

/**
 * Maximum number of queued fire-and-forget events. Beyond this the oldest
 * event is dropped: a backlog that big is stale by the time the socket is back.
 */
export const MAX_QUEUED_EVENTS = 32;

export type SignalingClient = { socket: object; on: (event: string, handler: (...args: any[]) => void) => void; emit: (event: string, payload?: object, ack?: (response: any) => void) => boolean; request: (event: string, payload: object) => Promise<any>; flushQueue: () => number; getQueuedEventCount: () => number; };

/**
 * Create a typed client for an existing Socket.IO connection.
 *
 * @param {import('socket.io-client').Socket} socket
 * @returns {SignalingClient}
 */
export function createSignalingClient(socket: import('socket.io-client').Socket): SignalingClient {
  /** @type {{ event: string, payload: object }[]} */
  const queue: { event: string; payload: object; }[] = [];

  /**
   * Register a handler for a server event, validating the payload first.
   *
   * @param {string} event one of `SERVER_EVENTS` / `TRANSPORT_EVENTS`
   * @param {Function} handler
   */
  function on(event: string, handler: Function) {
    socket.on(event, (payload, ...rest) => {
      const result = parseEventPayload(event, payload, 'server');
      if (!result.success) {
        logWarn('[Signaling] Dropped malformed inbound event', {
          event,
          reason: result.error.message,
        });
        return undefined;
      }
      return handler(result.data, ...rest);
    });
  }

  /**
   * Emit a client event. Payloads that do not match the shared contract are
   * dropped locally (a request the server would reject anyway), and emits made
   * while offline are queued for the next connection.
   *
   * The original payload object is sent rather than the parsed copy, so host
   * objects such as `RTCSessionDescription` reach the wire untouched.
   *
   * @param {string} event one of `CLIENT_EVENTS`
   * @param {object} [payload]
   * @param {Function} [ack]
   * @returns {boolean} whether the event was sent (`false` when queued/dropped)
   */
  function emit(event: string, payload: object = {}, ack?: Function): boolean {
    const result = parseEventPayload(event, payload, 'client');
    if (!result.success) {
      logWarn('[Signaling] Refused to emit malformed event', {
        event,
        reason: result.error.message,
      });
      return false;
    }

    if (!socket.connected) {
      // An emit that expects an acknowledgement cannot be replayed later: its
      // caller is waiting now, so let Socket.IO's own buffer handle it.
      if (typeof ack === 'function') {
        socket.emit(event, payload, ack);
        return false;
      }
      if (queue.length >= MAX_QUEUED_EVENTS) {
        const dropped = queue.shift();
        logWarn('[Signaling] Offline queue full, dropped oldest event', {
          event: dropped?.event,
        });
      }
      queue.push({ event, payload });
      logInfo('[Signaling] Queued event while offline', { event, queued: queue.length });
      return false;
    }

    if (typeof ack === 'function') {
      socket.emit(event, payload, ack);
    } else {
      socket.emit(event, payload);
    }
    return true;
  }

  /**
   * Emit a client event and await its acknowledgement envelope.
   *
   * @param {string} event one of `CLIENT_EVENTS`
   * @param {object} payload
   * @returns {Promise<any>} resolves with the event-specific ack envelope,
   *   rejects on `ok: false`
   */
  function request(event: string, payload: object): Promise<any> {
    const result = parseEventPayload(event, payload, 'client');
    if (!result.success) {
      return Promise.reject(new Error(`${event}: ${result.error.message}`));
    }
    return emitWithAck(socket, event, payload);
  }

  /**
   * Send everything queued while offline, oldest first. The socket owner calls
   * this from its own `connect` handler, so the flush is ordered explicitly
   * against the rest of the reconnect work instead of racing it.
   *
   * @returns {number} how many events were flushed
   */
  function flushQueue(): number {
    if (!socket.connected || queue.length === 0) return 0;
    const pending = queue.splice(0, queue.length);
    for (const item of pending) {
      socket.emit(item.event, item.payload);
    }
    logInfo('[Signaling] Flushed queued events', { count: pending.length });
    return pending.length;
  }

  return {
    socket,
    on,
    emit,
    request,
    flushQueue,
    getQueuedEventCount: () => queue.length,
  };
}

export { CLIENT_EVENTS, SERVER_EVENTS, TRANSPORT_EVENTS };
