'use strict';

const express = require('express');
const { getSessionFromRequest } = require('../lib/auth');
const { normaliseId, normalisePushProvider } = require('../lib/normalize');
const { upsertDevice } = require('../lib/state');
const { persistDevice } = require('../lib/persistence');

/**
 * Device push-token registration / unregistration.
 *
 * @param {{ state: object, db: object|null }} ctx
 * @returns {import('express').Router}
 */
function createDevicesRouter({ state, db }) {
  const router = express.Router();

  router.post('/devices/register', async (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const provider = normalisePushProvider(req.body?.provider);
    const pushToken = normaliseId(req.body?.pushToken);
    const requestedDeviceId = normaliseId(req.body?.deviceId);
    if (!provider || !pushToken) {
      res.status(400).json({ error: 'provider and pushToken are required' });
      return;
    }
    if (requestedDeviceId && requestedDeviceId !== session.deviceId) {
      res.status(400).json({ error: 'deviceId does not match active session' });
      return;
    }

    const device = upsertDevice(state, {
      userId: session.userId,
      deviceId: session.deviceId,
      platform: session.platform,
      sessionId: session.sessionId,
      pushProvider: provider,
      pushToken,
      lastRegisteredAt: new Date().toISOString(),
      lastUnregisteredAt: null,
    });

    // Persist device push-token registration to DB so it survives restarts.
    await persistDevice(db, device, 'registration');

    res.status(200).json({
      status: 'registered',
      userId: device.userId,
      deviceId: device.deviceId,
      provider: device.pushProvider,
    });
  });

  router.post('/devices/unregister', async (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const requestedDeviceId = normaliseId(req.body?.deviceId);
    if (requestedDeviceId && requestedDeviceId !== session.deviceId) {
      res.status(400).json({ error: 'deviceId does not match active session' });
      return;
    }

    const device = upsertDevice(state, {
      userId: session.userId,
      deviceId: session.deviceId,
      platform: session.platform,
      sessionId: session.sessionId,
      pushProvider: null,
      pushToken: null,
      lastUnregisteredAt: new Date().toISOString(),
    });

    // Persist the cleared push-token record to DB so the unregistration
    // survives restarts and push deliveries stop immediately.
    await persistDevice(db, device, 'unregistration');

    res.status(200).json({
      status: 'unregistered',
      userId: device.userId,
      deviceId: device.deviceId,
    });
  });

  return router;
}

module.exports = { createDevicesRouter };
