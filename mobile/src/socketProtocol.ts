// @ts-check
import { SIGNALING_VERSION as SHARED_SIGNALING_VERSION } from '../../shared';

/**
 * Server-side signaling protocol version required for call.* and rtc.* events.
 * Re-exported from `@wetalk/shared` so the client and the server can never
 * disagree about the protocol version.
 */
export const SIGNALING_VERSION = SHARED_SIGNALING_VERSION;

/**
 * Wrap a socket.io emit-with-ack in a Promise.
 * Rejects if the server responds with `ok: false` or after a 10 s timeout.
 *
 * @param {{ emit: (event: string, payload: any, ack: (response: any) => void) => void }} socket
 * @param {string} event
 * @param {any} payload
 * @returns {Promise<any>}
 */
export function emitWithAck(socket: { emit: (event: string, payload: any, ack: (response: any) => void) => void; }, event: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket ack timeout')), 10_000);
    socket.emit(event, payload, (/** @type {any} */ ack: any) => {
      clearTimeout(timer);
      if (ack?.ok) {
        resolve(ack);
      } else {
        reject(new Error(ack?.error?.message || 'server error'));
      }
    });
  });
}
