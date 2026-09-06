import { SIGNALING_VERSION as SHARED_SIGNALING_VERSION } from '../../shared';

/**
 * Server-side signaling protocol version required for call.* and rtc.* events.
 * Re-exported from `@wetalk/shared` so the client and the server can never
 * disagree about the protocol version.
 */
export const SIGNALING_VERSION = SHARED_SIGNALING_VERSION;

/**
 * A rejected acknowledgement, carrying the server's error code.
 *
 * The code is what tells a caller *why* the request was refused — a call that
 * cannot be placed because the user is already in one needs a different
 * response from any other failure — and it used to be discarded, leaving the
 * client with only a human-readable message to guess from.
 */
export class SignalingAckError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'SignalingAckError';
    this.code = code;
  }
}

/**
 * Wrap a socket.io emit-with-ack in a Promise.
 * Rejects if the server responds with `ok: false` or after a 10 s timeout.
 */
export function emitWithAck(socket: { emit: (event: string, payload: any, ack: (response: any) => void) => void; }, event: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket ack timeout')), 10_000);
    socket.emit(event, payload, (ack: any) => {
      clearTimeout(timer);
      if (ack?.ok) {
        resolve(ack);
      } else {
        reject(
          new SignalingAckError(
            ack?.error?.message || 'server error',
            typeof ack?.error?.code === 'string' ? ack.error.code : null
          )
        );
      }
    });
  });
}
