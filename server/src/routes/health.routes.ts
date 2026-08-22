import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';

/**
 * GET /health – liveness/readiness probe.
 *
 * While the instance is draining (rolling deploy / SIGTERM) it reports 503 so
 * load balancers stop routing new traffic here.
 *
 * @param ctx
 */
function createHealthRouter({ state }: {
        state: {
            draining: boolean;
            messageStore: { type: string; };
            messageStoreStatus: string;
        };
    }): import('express').Router {
  const router = express.Router();

  router.get(API_ROUTES.HEALTH, (_req, res) => {
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
      messageStore: {
        type: state.messageStore.type,
        status: state.messageStoreStatus,
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

export { createHealthRouter };
