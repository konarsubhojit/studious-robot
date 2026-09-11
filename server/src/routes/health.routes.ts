import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import { getRedisHealth } from '../lib/redisHealth.ts';

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
 * `fanout` is deliberately **orthogonal** to `stateAffinity`: the latter says
 * runtime state is Redis-backed, which is not the same guarantee as "an event
 * emitted here reaches a socket held by another instance".  It is measured by
 * an active probe (`lib/fanoutProbe.ts`) rather than inferred from
 * configuration, so a fleet split across two fan-out transports — or an
 * instance whose adapter clients have failed while its command client stays up
 * — reports `healthy: false` instead of looking perfectly well.
 *
 * `redis` reports subsystems a Redis/Valkey *permission* failure has disabled
 * — cross-instance fan-out or the stale-call sweep.  Those failures are not
 * retryable and are deliberately non-fatal (see `lib/redisHealth.ts`), so
 * without this field the instance would answer `status: 'ok'` while a
 * subsystem it depends on is permanently dead.
 *
 * `messageStore` reports only which backend is in use.  It deliberately does
 * *not* carry a readiness flag: the store is constructed synchronously over the
 * pool `db/client.ts` already owns, so any such flag could only ever be a
 * constant `'ready'` — a field that always says yes is worse than no field,
 * because it reads like a live signal during the outage it would be consulted
 * for.  Database reachability is observable through the query-timing and error
 * counters on `/metrics`.
 *
 * @param ctx
 */
function createHealthRouter({ state }: {
        state: {
            draining: boolean;
            messageStore: { type: string; };
            stateAffinity?: 'sticky' | 'shared';
            instanceId?: string;
            callState?: object;
            messageBus?: object | null;
            fanout?: { getStatus: () => import('../lib/fanoutProbe.ts').FanoutStatus; };
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
      },
      fanout: state.fanout?.getStatus() ?? null,
      redis: getRedisHealth(),
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

export { createHealthRouter };
