/**
 * Public facade for socket connection lifecycle handlers.
 *
 * The implementation now lives under `signaling/connection/`; this file keeps
 * existing import paths stable.
 */

export { registerSocketHandlers, leaveRoom } from './connection/registerSocketHandlers.ts';
