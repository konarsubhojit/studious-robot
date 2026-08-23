import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import { CALL_END_REASONS } from '../config.ts';
import { summarizeDeviceFanout } from '../lib/state.ts';

/**
 * Operational, no-auth endpoints:
 *   GET /call-end-reasons – static end-reason taxonomy for clients.
 *   GET /metrics          – point-in-time telemetry snapshot for scrapers.
 */
function createMetricsRouter({ state }: { state: import('../stores/contracts.ts').ServerState; }): import('express').Router {
  const router = express.Router();

  // ─── Call end-reason taxonomy (static, no auth required) ──────────────────
  router.get('/call-end-reasons', (_req, res) => {
    res.status(200).json({ reasons: CALL_END_REASONS });
  });

  /**
   * GET /metrics
   *
   * Returns a point-in-time JSON snapshot of all in-process call-funnel
   * counters and latency histograms.  Designed to be scraped by a monitoring
   * system (Prometheus, Datadog, Grafana, etc.) or consumed by an ops dashboard.
   *
   * Shape:
   *   collectedAt   – ISO-8601 timestamp of the snapshot
   *   counters      – monotonically increasing call-lifecycle counts
   *   histograms    – latency distributions with bucket, count, sum, mean, min, max
   *   derived       – calculated rates (connect rate, completion rate)
   *   devices       – aggregate device-row counts, so accumulating stale rows
   *                   (which fan a push out to handsets that no longer exist)
   *                   are visible to a scraper.  Aggregate only: no per-user
   *                   detail and never a push token.
   */
  router.get(API_ROUTES.METRICS, (_req, res) => {
    res.status(200).json({
      ...state.telemetry.getSnapshot(),
      devices: summarizeDeviceFanout(state),
    });
  });

  return router;
}

export { createMetricsRouter };
