import express from 'express';
import { getSessionFromRequest } from '../lib/auth.ts';

/**
 * GET /audit-log – return the security audit entries where the authenticated
 * user is the actor or the target (oldest-first).
 *
 * @param {{ state: { sessions: import('../stores/contracts.ts').SessionStore, auditLog: { getForUser: (userId: string) => object[] } } }} ctx
 * @returns {import('express').Router}
 */
function createAuditLogRouter({ state }: { state: { sessions: import('../stores/contracts.ts').SessionStore; auditLog: { getForUser: (userId: string) => object[]; }; }; }): import('express').Router {
  const router = express.Router();

  router.get('/audit-log', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    res.status(200).json({ entries: state.auditLog.getForUser(session.userId) });
  });

  return router;
}

export { createAuditLogRouter };
