/** Server-side signaling protocol version required for call.* and rtc.* events. */
export const SIGNALING_VERSION = 1;

/**
 * Wrap a socket.io emit-with-ack in a Promise.
 * Rejects if the server responds with `ok: false` or after a 10 s timeout.
 */
export function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket ack timeout')), 10_000);
    socket.emit(event, payload, ack => {
      clearTimeout(timer);
      if (ack?.ok) {
        resolve(ack);
      } else {
        reject(new Error(ack?.error?.message || 'server error'));
      }
    });
  });
}
