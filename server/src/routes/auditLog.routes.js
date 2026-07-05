'use strict';

const express = require('express');
const { getSessionFromRequest } = require('../lib/auth');

/**
 * GET /audit-log – return the security audit entries where the authenticated
 * user is the actor or the target (oldest-first).
 *
 * @param {{ state: object }} ctx
 * @returns {import('express').Router}
 */
function createAuditLogRouter({ state }) {
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

module.exports = { createAuditLogRouter };
