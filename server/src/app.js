'use strict';

const express = require('express');

const { createTurnCredentials } = require('./turn');

/**
 * Build the Express application exposing health, metrics, and (optionally) TURN
 * credential endpoints.
 *
 * Split out from the Socket.IO wiring so the HTTP surface can be tested in
 * isolation and extended (readiness probes, metrics) without touching signaling.
 *
 * @param {object} deps
 * @param {ReturnType<import('./metrics').createMetrics>} deps.metrics
 * @param {ReturnType<import('./roomStore').createRoomStore>} deps.rooms
 * @param {ReturnType<import('./config').loadConfig>} [deps.config]
 * @param {ReturnType<import('./telemetry').createTelemetry>} [deps.telemetry]
 * @returns {import('express').Express}
 */
function createApp({ metrics, rooms, config = {}, telemetry } = {}) {
  const app = express();
  const instanceId = config.instanceId;

  // Liveness: the process is up and able to serve requests.
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'studious-robot-signaling',
      instance: instanceId,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Operational metrics: live signaling activity and room occupancy.
  app.get('/metrics', (_req, res) => {
    res.status(200).json({
      service: 'studious-robot-signaling',
      instance: instanceId,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      rooms: rooms.snapshot(),
      counters: metrics.snapshot(),
    });
  });

  // TURN credential provisioning: hand out short-lived, HMAC-signed credentials
  // so clients never embed the long-lived shared secret. Disabled (404) unless
  // TURN_SECRET and TURN_URLS are configured.
  app.get('/turn-credentials', (_req, res) => {
    if (!config.turn?.enabled) {
      res.status(404).json({ error: 'TURN provisioning is not configured' });
      return;
    }
    try {
      const credentials = createTurnCredentials(config.turn);
      metrics.increment?.('turnCredentialsIssuedTotal');
      res.status(200).json(credentials);
    } catch (err) {
      telemetry?.captureException?.(err, { endpoint: '/turn-credentials' });
      res.status(500).json({ error: 'Failed to issue TURN credentials' });
    }
  });

  return app;
}

module.exports = { createApp };
