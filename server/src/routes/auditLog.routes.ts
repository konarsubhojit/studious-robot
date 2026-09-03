import express from 'express';
import { getSessionFromRequestAsync } from '../lib/auth.ts';

/**
 * GET /audit-log – return the security audit entries where the authenticated
 * user is the actor or the target (oldest-first).
 */
function createAuditLogRouter({ state }: { state: import('../stores/contracts.ts').ServerState; }): import('express').Router {
  const router = express.Router();

  router.get('/audit-log', async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    res.status(200).json({ entries: state.auditLog.getForUser(session.userId) });
  });

  return router;
}

export { createAuditLogRouter };
