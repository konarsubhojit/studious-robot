import { createHealthRouter } from './health.routes.ts';
import { createSessionRouter } from './session.routes.ts';
import { createDevicesRouter } from './devices.routes.ts';
import { createDirectoryRouter } from './directory.routes.ts';
import { createMetricsRouter } from './metrics.routes.ts';
import { createBlocksRouter } from './blocks.routes.ts';
import { createAuditLogRouter } from './auditLog.routes.ts';
import { createCallsRouter } from './calls.routes.ts';
import { createMessagesRouter } from './messages.routes.ts';
import { createAttachmentsRouter } from './attachments.routes.ts';
import { createTurnCredentialsRouter } from './turnCredentials.routes.ts';

/**
 * Mount every HTTP router onto the Express app.
 *
 * Routers are mounted at the app root so their internal paths (e.g. `/session`,
 * `/calls/:callId`) remain identical to the original monolith, preserving the
 * public HTTP contract exactly.
 *
 * @param {import('express').Express} app
 * @param {{
 *   state: import('../stores/contracts.ts').ServerState,
 *   db: any,
 *   io: any,
 *   sessionTtlMs: number,
 *   ringingTimeoutMs: number,
 *   turnFetch?: typeof fetch,
 *   turnEnv?: NodeJS.ProcessEnv,
 *   verifyIdToken?: (idToken: string) => Promise<{
 *     authUid: string,
 *     email?: string|null,
 *     authProvider?: string|null,
 *   }>,
 * }} ctx
 */
function mountRoutes(app: import('express').Express, ctx: {
        state: import('../stores/contracts.ts').ServerState;
        db: any;
        io: any;
        sessionTtlMs: number;
        ringingTimeoutMs: number;
        turnFetch?: typeof fetch;
        turnEnv?: NodeJS.ProcessEnv;
        verifyIdToken?: (idToken: string) => Promise<{
            authUid: string;
            email?: string | null;
            authProvider?: string | null;
        }>;
    }) {
  const {
    state,
    db,
    io,
    sessionTtlMs,
    ringingTimeoutMs,
    turnFetch,
    turnEnv,
    verifyIdToken,
  } = ctx;

  app.use(createHealthRouter({ state }));
  app.use(createSessionRouter({ state, db, sessionTtlMs, verifyIdToken }));
  app.use(createDevicesRouter({ state, db }));
  app.use(createDirectoryRouter({ state }));
  app.use(createMetricsRouter({ state }));
  app.use(createBlocksRouter({ state, db }));
  app.use(createAuditLogRouter({ state }));
  app.use(createCallsRouter({ state, io, ringingTimeoutMs }));
  app.use(createMessagesRouter({ state, io }));
  app.use(createAttachmentsRouter({ state }));
  app.use(createTurnCredentialsRouter({ state, fetchImpl: turnFetch, env: turnEnv }));
}

export { mountRoutes };
