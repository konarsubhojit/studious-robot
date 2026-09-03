import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';

/**
 * GET /health – liveness/readiness probe.
 *
 * While the instance is draining (rolling deploy / SIGTERM) it reports 503 so
 * load balancers stop routing new traffic here.
 *
 * The response advertises `stateAffinity`: `'sticky'` for per-process runtime
 * state and `'shared'` when runtime call/session state is coordinated through
 * Redis-backed store primitives.
 *
 * @param ctx
 */
function createHealthRouter({ state }: {
        state: {
            draining: boolean;
            messageStore: { type: string; };
            messageStoreStatus: string;
            stateAffinity?: 'sticky' | 'shared';
            instanceId?: string;
            callState?: object;
            messageBus?: object | null;
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
      stateAffinity: state.stateAffinity ?? 'sticky',
      instanceId: state.instanceId ?? `${process.pid}`,
      sharedState: {
        calls: Boolean(state.callState),
        messageBus: Boolean(state.messageBus),
      },
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
