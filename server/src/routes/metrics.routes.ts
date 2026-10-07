import express from 'express';
import { timingSafeEqual } from 'crypto';
import { API_ROUTES } from '../../../shared/index.ts';
import { CALL_END_REASONS } from '../config.ts';
import { summarizeDeviceFanout } from '../lib/state.ts';
import { getCallQualityMetrics } from '../callQuality.ts';
import { describeError } from '../lib/errors.ts';

/**
 * Operational endpoints:
 *   GET /call-end-reasons – static end-reason taxonomy for clients.
 *   GET /metrics          – operator-token-protected telemetry snapshot.
 */
function createMetricsRouter({ state }: { state: import('../stores/contracts.ts').ServerState; }): import('express').Router {
  const router = express.Router();
  const TOKEN_COMPARE_BYTES = 256;

  /**
   * Constant-time check of the operator token guarding metrics access.
   */
  function hasMetricsToken(req: import('express').Request): boolean {
    const expected = process.env.DEBUG_API_TOKEN;
    if (!expected) return false;
    const presented = req.get('x-debug-token') ?? '';

    const expectedRaw = Buffer.from(expected);
    const presentedRaw = Buffer.from(presented);
    const expectedPadded = Buffer.alloc(TOKEN_COMPARE_BYTES);
    const presentedPadded = Buffer.alloc(TOKEN_COMPARE_BYTES);
    expectedRaw.subarray(0, TOKEN_COMPARE_BYTES).copy(expectedPadded);
    presentedRaw.subarray(0, TOKEN_COMPARE_BYTES).copy(presentedPadded);

    const equal = timingSafeEqual(expectedPadded, presentedPadded);
    return (
      equal &&
      expectedRaw.length === presentedRaw.length &&
      expectedRaw.length <= TOKEN_COMPARE_BYTES &&
      presentedRaw.length <= TOKEN_COMPARE_BYTES
    );
  }

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
   *   callQuality   – MOS-style quality buckets and p50/p95 per call and fleet.
   */
  router.get(API_ROUTES.METRICS, async (req, res) => {
    if (!hasMetricsToken(req)) {
      res.status(401).json({ error: 'metrics authentication required' });
      return;
    }

    let callQuality;
    try {
      callQuality = await getCallQualityMetrics(state.db);
    } catch (error) {
      console.error(`[metrics] call-quality query failed: ${describeError(error)}`);
      callQuality = null;
    }
    const snapshot = state.telemetry.getSnapshot();
    res.status(200).json({
      ...snapshot,
      metricScopes: {
        ...snapshot.metricScopes,
        devices: 'current-instance-device-cache',
        callQuality: state.db ? 'database-retained-history' : 'disabled-empty',
      },
      historical: { scope: 'hydration-window', hydration: state.hydration },
      devices: summarizeDeviceFanout(state),
      callQuality,
    });
  });

  return router;
}

export { createMetricsRouter };
