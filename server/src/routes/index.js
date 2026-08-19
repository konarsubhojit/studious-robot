'use strict';

const { createHealthRouter } = require('./health.routes');
const { createSessionRouter } = require('./session.routes');
const { createDevicesRouter } = require('./devices.routes');
const { createDirectoryRouter } = require('./directory.routes');
const { createMetricsRouter } = require('./metrics.routes');
const { createBlocksRouter } = require('./blocks.routes');
const { createAuditLogRouter } = require('./auditLog.routes');
const { createCallsRouter } = require('./calls.routes');
const { createMessagesRouter } = require('./messages.routes');
const { createAttachmentsRouter } = require('./attachments.routes');
const { createTurnCredentialsRouter } = require('./turnCredentials.routes');

/**
 * Mount every HTTP router onto the Express app.
 *
 * Routers are mounted at the app root so their internal paths (e.g. `/session`,
 * `/calls/:callId`) remain identical to the original monolith, preserving the
 * public HTTP contract exactly.
 *
 * @param {import('express').Express} app
 * @param {{ state: object, db: object|null, io: object, sessionTtlMs: number, ringingTimeoutMs: number }} ctx
 */
function mountRoutes(app, ctx) {
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

module.exports = { mountRoutes };
