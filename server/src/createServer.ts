/**
 * Public facade for the server composition root.
 *
 * The implementation is in `createServer/index.ts`; this file preserves the
 * original import path used by the app and tests.
 */

export { createServer } from './createServer/index.ts';
export type { CreateServerOptions } from './createServer/types.ts';
