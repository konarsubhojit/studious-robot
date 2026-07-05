'use strict';

const express = require('express');

/**
 * GET /health – liveness/readiness probe.
 *
 * While the instance is draining (rolling deploy / SIGTERM) it reports 503 so
 * load balancers stop routing new traffic here.
 *
 * @param {{ state: object }} ctx
 * @returns {import('express').Router}
 */
function createHealthRouter({ state }) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    // While draining, report unhealthy so load balancers / orchestrators stop
    // routing new traffic to this instance during a rolling deploy.
    if (state.draining) {
      res.status(503).json({
        status: 'draining',
        service: 'wetalk-signaling',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
      return;
    }
    res.status(200).json({
      status: 'ok',
      service: 'wetalk-signaling',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

module.exports = { createHealthRouter };
