// @ts-check
'use strict';

const express = require('express');
const { API_ROUTES } = require('../../../shared');
const { CALL_END_REASONS } = require('../config');

/**
 * Operational, no-auth endpoints:
 *   GET /call-end-reasons – static end-reason taxonomy for clients.
 *   GET /metrics          – point-in-time telemetry snapshot for scrapers.
 *
 * @param {{ state: import('../stores/contracts').ServerState }} ctx
 * @returns {import('express').Router}
 */
function createMetricsRouter({ state }) {
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
   */
  router.get(API_ROUTES.METRICS, (_req, res) => {
    res.status(200).json(state.telemetry.getSnapshot());
  });

  return router;
}

module.exports = { createMetricsRouter };
