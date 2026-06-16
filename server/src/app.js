'use strict';

const express = require('express');

/**
 * Build the Express application exposing health and metrics endpoints.
 *
 * Split out from the Socket.IO wiring so the HTTP surface can be tested in
 * isolation and extended (readiness probes, metrics) without touching signaling.
 *
 * @param {object} deps
 * @param {ReturnType<import('./metrics').createMetrics>} deps.metrics
 * @param {ReturnType<import('./roomStore').createRoomStore>} deps.rooms
 * @returns {import('express').Express}
 */
function createApp({ metrics, rooms }) {
  const app = express();

  // Liveness: the process is up and able to serve requests.
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'studious-robot-signaling',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Operational metrics: live signaling activity and room occupancy.
  app.get('/metrics', (_req, res) => {
    res.status(200).json({
      service: 'studious-robot-signaling',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      rooms: rooms.snapshot(),
      counters: metrics.snapshot(),
    });
  });

  return app;
}

module.exports = { createApp };
